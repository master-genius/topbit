'use strict';

const http2 = require('node:http2')
const crypto = require('node:crypto')

class Http2Pool {
  
  constructor(options = {}) {
    if (!options || typeof options !== 'object') options = {}
    
    // 配置初始化
    this.maxConnect = options.maxConnect || 100 // 最大物理连接数
    this.maxAliveStreams = options.maxAliveStreams || 100 // 单连接最大并发流
    this.url = options.url
    this.debug = !!options.debug
    this.reconnDelay = options.reconnDelay || 500

    // 常驻连接数：零流量时保持不关闭（仅 ping 保活），异常断开后低于此值自动补连。
    // 持久连接是 HTTP/2 代理的核心优势（免握手、多路复用），
    // 且“手里有活连接”本身就是后端可达的状态信号（ok() 据此判定健康），
    // 因此常驻名额内的连接不做空闲回收；设为 0 可关闭常驻。
    this.minConnect = options.minConnect === undefined ? 2 : options.minConnect
    // 指数退避上限：重连间隔从 reconnDelay 起翻倍，封顶于此
    this.reconnMaxDelay = options.reconnMaxDelay || 30_000
    // 新建连接的握手等待上限（对应代理配置项 connectTimeout）
    this.connectTimeout = options.connectTimeout || 5000
    // 无可用配额时，请求在等待队列中的滞留上限
    this.queueTimeout = options.queueTimeout || 3000
    // 收到 GOAWAY 后，存量流的最长排水时间
    this.drainTimeout = options.drainTimeout || 30_000
    
    // 核心数据结构
    this.sessions = [] // 使用数组代替Map，利用索引做 Round-Robin
    this.cursor = 0    // 轮询指针
    
    this.connectOptions = {
      rejectUnauthorized: false,
      timeout: options.timeout || 30000,
      ...options.connectOptions
    }
    
    this.waitQueue = [] // 等待可用连接的队列

    // 重连退避状态：全池共享，同一时刻只保留一个在途重连任务
    this._reconnAttempts = 0
    this._reconnTimer = null
    // 最近一次建连是否失败：区分"空闲回收后的空池"与"后端不可用"
    this._lastConnectFailed = false
  }

  /**
   * 初始化连接池 (预热)
   */
  createPool(initialSize = 5) {
    for (let i = 0; i < initialSize; i++) {
      this._createConnection()
    }
  }

  /**
   * 预占一个并发配额。
   * 配额必须在“分发连接的同一个同步回合”内占住：
   * 若等到调用方 await 恢复后才自增，同一轮唤醒循环会把同一个配额重复发给多个等待者。
   * @returns {boolean} 占用成功与否
   */
  _acquire(wrapper) {
    if (!wrapper || wrapper._destroyed || wrapper._draining) return false
    if (!wrapper.connected || wrapper.session.destroyed) return false
    if (wrapper.aliveStreams >= wrapper.streamLimit) return false

    wrapper.aliveStreams++
    return true
  }

  /**
   * 归还一个并发配额，并推进后续流程（排水收尾 / 唤醒等待者）
   */
  _releaseSlot(wrapper) {
    if (wrapper.aliveStreams > 0) wrapper.aliveStreams--

    // 排水中且存量流已清空：此刻才可以真正关闭连接
    if (wrapper._draining) {
      if (wrapper.aliveStreams <= 0) this._closeDrained(wrapper)
      return
    }

    this._dispatchWaiters(wrapper)
  }

  /**
   * 把空闲配额分发给等待者：每分发一个即同步预占，杜绝超发
   */
  _dispatchWaiters(wrapper) {
    while (this.waitQueue.length > 0 && this._acquire(wrapper)) {
      const waiter = this.waitQueue.shift()

      // 已超时出队的陈旧等待者：归还刚预占的配额，继续下一个
      if (waiter.settled) {
        wrapper.aliveStreams--
        continue
      }

      waiter.settled = true
      clearTimeout(waiter.timer)
      waiter.resolve(wrapper)
    }
  }

  /**
   * 进入等待队列，直到拿到配额或超时
   */
  _waitForSlot() {
    return new Promise((resolve, reject) => {
      const waiter = { settled: false, resolve, reject, timer: null }

      waiter.timer = setTimeout(() => {
        if (waiter.settled) return
        waiter.settled = true

        const idx = this.waitQueue.indexOf(waiter)
        if (idx !== -1) this.waitQueue.splice(idx, 1)

        reject(new Error('No available h2 session (Queued timeout)'))
      }, this.queueTimeout)

      this.waitQueue.push(waiter)
    })
  }

  /**
   * 池内可继续服务的连接数（排除排水中/已销毁）
   */
  _liveCount() {
    // 排除排水中/已销毁/已进入空闲关闭流程的连接。
    // _idleClosed 必须计入排除项：多条连接的空闲计时器往往在同一时刻触发，
    // 若只看 session.destroyed（close() 后要等 'close' 事件才置位），
    // 它们会同时判定“富余”而一起关掉，常驻名额落空。
    return this.sessions.filter(
      w => !w._draining && !w._destroyed && !w._idleClosed && !w.session.destroyed
    ).length
  }

  /**
   * 从池中摘除（不销毁连接）：用于 GOAWAY 排水期停止接新流
   */
  _removeFromPool(wrapper) {
    const idx = this.sessions.indexOf(wrapper)
    if (idx === -1) return

    this.sessions.splice(idx, 1)
    // 修正指针，防止跳过
    if (this.cursor >= idx && this.cursor > 0) this.cursor--
  }

  /**
   * 排水结束：优雅关闭；force 表示排水超时，强制销毁
   */
  _closeDrained(wrapper, force = false) {
    if (wrapper._drainTimer) {
      clearTimeout(wrapper._drainTimer)
      wrapper._drainTimer = null
    }

    const session = wrapper.session
    if (session.destroyed) return

    if (force) session.destroy()
    else if (!session.closed) session.close()
  }

  /**
   * 指数退避重连：同一时刻只保留一个在途任务，避免后端宕机时的定频重连风暴
   */
  _scheduleReconnect() {
    if (this._reconnTimer) return
    if (this.sessions.length >= this.maxConnect) return

    const delay = Math.min(this.reconnDelay * Math.pow(2, this._reconnAttempts), this.reconnMaxDelay)
    this._reconnAttempts++

    this._reconnTimer = setTimeout(() => {
      this._reconnTimer = null
      if (this.sessions.length < this.minConnect) this._createConnection()
    }, delay)

    // 重连是后台保活任务，不应阻止进程退出
    if (this._reconnTimer.unref) this._reconnTimer.unref()
  }

  /**
   * 内部建立连接
   */
  _createConnection() {
    if (this.sessions.length >= this.maxConnect) return null

    let session

    if (this.url && this.url.startsWith('unix://')) {
      // http2.connect 不支持 unix 协议，通过 createConnection 提供 unix socket 连接
      const net = require('node:net')
      const u = new URL(this.url)
      const sockarr = u.pathname.split('.sock')
      session = http2.connect(`http://localhost${sockarr[1] || '/'}`, {
        ...this.connectOptions,
        createConnection: () => net.connect(sockarr[0] + '.sock')
      })
    } else {
      session = http2.connect(this.url, this.connectOptions)
    }
    
    const wrapper = {
      id: crypto.randomBytes(8).toString('hex'),
      session: session,
      connected: false,
      aliveStreams: 0, // 当前并发数
      // 本连接并发上限。'connect' 先于 'remoteSettings' 触发，若此时就按配置值放行，
      // 对端声明 2 而本地按 100 分发，首轮唤醒即超发。故在收到对端 SETTINGS 前
      // 只给保守配额 1（够用且不会超发），收到后再收敛为 min(配置, 对端声明)。
      streamLimit: 1,
      settingsKnown: false,
      weight: 1        // 预留权重字段
    }

    // 对端通过 SETTINGS_MAX_CONCURRENT_STREAMS 声明并发上限，动态收敛本连接配额
    session.on('remoteSettings', (settings) => {
      wrapper.settingsKnown = true
      wrapper.streamLimit = settings.maxConcurrentStreams === undefined
        ? this.maxAliveStreams
        : Math.min(this.maxAliveStreams, settings.maxConcurrentStreams)

      // 配额放开，唤醒等待者（remoteSettings 与 connect 的先后顺序不确定，两处都要唤醒）
      this._dispatchWaiters(wrapper)

      // 配额放开后仍有人排队 → 说明单连接吃不下，按需扩容一条（逐条爬坡，不做瞬时扇出）
      if (this.waitQueue.length > 0 && this.sessions.length < this.maxConnect) {
        this._createConnection()
      }
    })

    session.once('connect', () => {
      wrapper.connected = true
      // 连接恢复，退避计数归零
      this._reconnAttempts = 0
      this._lastConnectFailed = false
      // 触发队列中的等待者
      this._dispatchWaiters(wrapper)
      // 仍不足最小连接数则继续补（单任务串行，不并发建连）
      if (this.sessions.length < this.minConnect) this._scheduleReconnect()
    })

    // 错误处理与清理
    const cleanup = () => {
        if (wrapper._destroyed) return
        wrapper._destroyed = true

        if (wrapper._drainTimer) {
          clearTimeout(wrapper._drainTimer)
          wrapper._drainTimer = null
        }

        this._removeFromPool(wrapper)

        if (!session.destroyed) session.destroy()
        
        // 富余连接的空闲关闭不补连，否则会陷入“空闲关闭 → 立即重连”的空转。
        // 常驻连接不会走到这里（空闲时只 ping 不关），因此低于常驻数
        // 只可能是异常断开或对端主动关闭，此时应当按退避补连。
        if (!wrapper._idleClosed && this.sessions.length < this.minConnect) {
          this._scheduleReconnect()
        }
    }

    session.on('close', cleanup)
    session.on('error', (err) => {
        if(this.debug) console.error(`[H2Pool] Session Error ${this.url}:`, err.message)
        // 标记最近一次连接是失败的：ok() 据此把"空闲回收后的空池"与"后端真的挂了"区分开
        this._lastConnectFailed = true
        cleanup()
    })

    // GOAWAY 只表示对端不再接受“新流”，存量流（id <= lastStreamID）仍会正常收完。
    // 直接销毁会让下游拿到被截断却不带 error 的响应体（静默截断），
    // 因此先摘出池停止接新流，再等存量流排水结束才关闭。
    session.on('goaway', () => {
        if (wrapper._destroyed || wrapper._draining) return
        wrapper._draining = true

        this._removeFromPool(wrapper)

        if (wrapper.aliveStreams <= 0) {
          this._closeDrained(wrapper)
        } else {
          wrapper._drainTimer = setTimeout(() => this._closeDrained(wrapper, true), this.drainTimeout)
          if (wrapper._drainTimer.unref) wrapper._drainTimer.unref()
        }

        // 对端多为滚动重启，按退避补连
        if (this.sessions.length < this.minConnect) this._scheduleReconnect()
    })
    
    // 空闲保活策略
    //   有在途流           → ping 续命，不动连接
    //   空闲但在常驻名额内 → ping 续命，保持持久连接（免握手 + 作为可达性信号）
    //   空闲且属富余连接   → 优雅关闭，且不补连（避免“关了再连”的空转 churn）
    session.setTimeout(this.connectOptions.timeout, () => {
        if (session.destroyed) return

        if (wrapper.aliveStreams <= 0 && this._liveCount() > this.minConnect) {
            wrapper._idleClosed = true
            session.close() // 富余连接，优雅关闭
            return
        }

        // ping 一次即可让 Node 重置空闲计时器，等价于周期性保活
        // （会话已销毁时 ping 会抛 ERR_HTTP2_INVALID_SESSION，做一层防护）
        if (typeof session.ping === 'function') {
          try {
            session.ping(() => {})
          } catch (e) {
            if (this.debug) console.error(`[H2Pool] ping failed ${this.url}:`, e.message)
          }
        }
    })

    this.sessions.push(wrapper)
    return wrapper
  }

  /**
   * 获取最佳可用 Session (Round-Robin)
   * 返回时该连接的一个并发配额已被预占，调用方无需再自增
   */
  async getSession() {
    let tried = 0
    const len = this.sessions.length

    // 1. 尝试轮询获取可用连接
    while (tried < len) {
        this.cursor = (this.cursor + 1) % len
        const wrapper = this.sessions[this.cursor]

        if (this._acquire(wrapper)) return wrapper

        tried++
    }

    // 2a. 池中已有正在握手 / 等待对端 SETTINGS 的连接：它们马上就会提供配额，
    //     此时应排队而不是扩容。否则冷启动瞬间的并发会把每个请求各判成
    //     "需要新连接"，一次把 maxConnect 打满（实测 10 并发 → 10 条连接）。
    const pending = this.sessions.some(
      w => !w._draining && !w.session.destroyed && (!w.connected || !w.settingsKnown)
    )
    if (pending) return this._waitForSlot()

    // 2b. 如果没有可用连接，且未达上限，创建新连接
    if (this.sessions.length < this.maxConnect) {
        const newWrapper = this._createConnection()
        if (newWrapper) {
            // 等待连接建立（上限为配置的 connectTimeout）
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                     reject(new Error('Connection timeout'))
                }, this.connectTimeout)
                
                const onConnect = () => {
                    clearTimeout(timer)
                    newWrapper.session.removeListener('connect', onConnect)
                    // 建连期间配额可能已被等待队列抢占，抢不到就转入队列
                    if (this._acquire(newWrapper)) resolve(newWrapper)
                    else resolve(this._waitForSlot())
                }
                newWrapper.session.once('connect', onConnect)
                newWrapper.session.once('error', (err) => {
                    clearTimeout(timer)
                    reject(err)
                })
            })
        }
    }

    // 3. 还是没有，进入队列等待 (削峰填谷)
    return this._waitForSlot()
  }

  /**
   * 发起请求 (核心入口)
   */
  async request(headers) {
    const wrapper = await this.getSession()

    let stream

    try {
        stream = wrapper.session.request(headers)
    } catch (e) {
        this._releaseSlot(wrapper)
        throw e
    }

    // 监听流关闭，归还配额并唤醒等待者
    stream.once('close', () => this._releaseSlot(wrapper))

    return stream
  }

  /**
   * 后端是否可用（供负载均衡器做健康过滤）
   *
   * 注意这里判定的是"能否服务新请求"，而不是"此刻是否握着一条连接"：
   * 空闲连接被回收后池会变空，若把空池判为不可用，负载均衡器就会把该后端剔除，
   * 后端便永远收不到流量、池也永远补不满，形成自锁。
   */
  ok() {
      if (this.sessions.some(s => s.connected && !s.session.destroyed)) return true

      // 池空但仍可按需建连，且最近一次建连没有失败 → 视为可用
      return this.sessions.length < this.maxConnect && !this._lastConnectFailed
  }
}

module.exports = Http2Pool
