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
    
    // 核心数据结构
    this.sessions = [] // 使用数组代替Map，利用索引做 Round-Robin
    this.cursor = 0    // 轮询指针
    
    this.connectOptions = {
      rejectUnauthorized: false,
      timeout: options.timeout || 30000,
      ...options.connectOptions
    }
    
    this.waitQueue = [] // 等待可用连接的队列
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
   * 内部建立连接
   */
  _createConnection() {
    if (this.sessions.length >= this.maxConnect) return null

    const session = http2.connect(this.url, this.connectOptions)
    
    const wrapper = {
      id: crypto.randomBytes(8).toString('hex'),
      session: session,
      connected: false,
      aliveStreams: 0, // 当前并发数
      weight: 1        // 预留权重字段
    }

    session.once('connect', () => {
      wrapper.connected = true
      // 触发队列中的等待者
      while (this.waitQueue.length > 0 && wrapper.aliveStreams < this.maxAliveStreams) {
        const resolve = this.waitQueue.shift()
        resolve(wrapper)
      }
    })

    // 错误处理与清理
    const cleanup = () => {
        if (wrapper._destroyed) return
        wrapper._destroyed = true
        
        // 从池中移除
        const idx = this.sessions.indexOf(wrapper)
        if (idx !== -1) {
            this.sessions.splice(idx, 1)
            // 修正指针，防止跳过
            if (this.cursor >= idx && this.cursor > 0) this.cursor-- 
        }

        if (!session.destroyed) session.destroy()
        
        // 自动补充连接 (维持最小连接数，可选)
        if (this.sessions.length < 2) {
             // 防止雪崩，延迟重连
             setTimeout(() => this._createConnection(), this.reconnDelay)
        }
    }

    session.on('close', cleanup)
    session.on('error', (err) => {
        if(this.debug) console.error(`[H2Pool] Session Error ${this.url}:`, err.message)
        cleanup()
    })
    session.on('goaway', cleanup)
    
    // 超时保活策略：只有完全空闲才销毁，否则发送 ping
    session.setTimeout(this.connectOptions.timeout, () => {
        if (wrapper.aliveStreams > 0) {
            // 还有流量，不销毁，尝试 ping 保持活跃
            session.ping && session.ping(() => {}) 
        } else {
            session.close() // 优雅关闭
        }
    })

    this.sessions.push(wrapper)
    return wrapper
  }

  /**
   * 获取最佳可用 Session (Round-Robin)
   */
  async getSession() {
    let tried = 0
    const len = this.sessions.length

    // 1. 尝试轮询获取可用连接
    while (tried < len) {
        this.cursor = (this.cursor + 1) % len
        const wrapper = this.sessions[this.cursor]

        if (wrapper && wrapper.connected && !wrapper.session.destroyed && wrapper.aliveStreams < this.maxAliveStreams) {
            return wrapper
        }
        tried++
    }

    // 2. 如果没有可用连接，且未达上限，创建新连接
    if (this.sessions.length < this.maxConnect) {
        const newWrapper = this._createConnection()
        if (newWrapper) {
            // 等待连接建立 (设置一个短超时)
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                     reject(new Error('Connection timeout'))
                }, 5000)
                
                const onConnect = () => {
                    clearTimeout(timer)
                    newWrapper.session.removeListener('connect', onConnect)
                    resolve(newWrapper)
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
    return new Promise((resolve, reject) => {
        // 3秒后还没拿到连接就报错
        const timer = setTimeout(() => {
            const idx = this.waitQueue.indexOf(resolve)
            if (idx !== -1) this.waitQueue.splice(idx, 1)
            reject(new Error('No available h2 session (Queued timeout)'))
        }, 3000)

        // 包装 resolve 以清理 timer
        this.waitQueue.push((wrapper) => {
            clearTimeout(timer)
            resolve(wrapper)
        })
    })
  }

  /**
   * 发起请求 (核心入口)
   */
  async request(headers) {
    const wrapper = await this.getSession()
    wrapper.aliveStreams++

    try {
        const stream = wrapper.session.request(headers)
        
        // 监听流关闭，减少计数
        stream.once('close', () => {
            wrapper.aliveStreams--
            // 如果有等待队列，唤醒一个
            if (this.waitQueue.length > 0) {
                const resolve = this.waitQueue.shift()
                resolve(wrapper)
            }
        })
        
        return stream
    } catch (e) {
        wrapper.aliveStreams--
        throw e
    }
  }

  ok() {
      return this.sessions.some(s => s.connected && !s.session.destroyed)
  }
}

module.exports = Http2Pool