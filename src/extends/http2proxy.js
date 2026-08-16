'use strict'

const http2 = require('node:http2')
const Http2Pool = require('./Http2Pool.js')

// RFC 7230 §6.1 定义的逐跳（hop-by-hop）头：只对单次连接有意义，
// 代理必须剥离，不得透传（h2 协议本身也禁止这些头）
const HOP_BY_HOP_HEADERS = {
  'connection': true,
  'keep-alive': true,
  'proxy-authenticate': true,
  'proxy-authorization': true,
  'te': true,
  'trailer': true,
  'transfer-encoding': true,
  'upgrade': true,
  'proxy-connection': true // 非标准但广泛存在的事实逐跳头
}

// 解析 Connection 头列出的额外逐跳头。
// RFC 7230 §6.1：Connection 值中的每个 token 所指的头同样属于逐跳头。
// 值可能为字符串或数组（多同名头合并），统一处理。
function connectionTokens (value) {
  const tokens = Object.create(null)
  if (!value) return tokens

  const list = Array.isArray(value) ? value : [value]

  for (const item of list) {
    if (typeof item !== 'string') continue
    for (const name of item.split(',')) {
      const t = name.trim().toLowerCase()
      if (t) tokens[t] = true
    }
  }

  return tokens
}

let error_502_text = `<!DOCTYPE html><html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Error 502</title>
      </head>
      <body>
        <div style="width:100%;font-size:105%;color:#737373;padding:0.8rem;">
          <h2>502 Bad Gateway</h2><br>
          <p>代理请求不可达。</p>
        </div>
      </body>
  </html>`

let error_503_text = `<!DOCTYPE html><html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Error 503</title>
      </head>
      <body>
        <div style="width:100%;font-size:105%;color:#737373;padding:0.8rem;">
          <h2>503 Service Unavailable</h2><br>
          <p>此服务暂时不可用。</p>
        </div>
      </body>
  </html>`

function fmtpath(path) {
  path = path.trim()
  if (path.length == 0) {
    return '/*'
  }

  if (path[0] !== '/') {
    path = `/${path}`
  }

  if (path.length > 1 && path[path.length - 1] !== '/') {
    path = `${path}/`
  }

  if (path.indexOf('/:') >= 0) {
    return path.substring(0, path.length-1)
  }

  return `${path}*`
}

let Http2Proxy = function (options = {}) {

  if (!(this instanceof Http2Proxy)) return Http2Proxy(options)

  if (typeof options !== 'object') options = {}

  this.urlpreg = /(?:unix:\/\/\/[a-zA-Z0-9\-\_\/\.]+|unix:\/\/[a-zA-Z0-9\-\_]+|(?:http|https):\/\/[\[a-zA-Z0-9\-\_]+)/

  this.hostProxy = {}
  this.proxyBalance = {}
  this.pathTable = {}

  this.methods = [
    'GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH', 'TRACE'
  ]

  this.maxBody = 50000000

  this.realIPHeader = 'x-real-ip'

  //是否启用全代理模式。
  this.full = false

  this.timeout = 30000
  this.connectTimeout = 15000

  // 代理传输总时长上限（毫秒），0 表示不限制；响应头到达后开始计时
  this.requestTimeout = 600000

  this.maxAliveStreams = 100

  this.starPath = false

  this.addIP = false

  this.debug = false

  // 初始化时告知的服务端口，用于自动拼接 hostProxy 的 key；'' 或 0 表示不拼接
  this.port = ''

  this.config = {}

  this.connectOptions = {
    family: 4
  }

  this.balancer = (options.balancer
                    && options.balancer.select
                      && typeof options.balancer.select === 'function')
                    ? options.balancer
                    : null

  for (let k in options) {
    switch (k) {
      case 'realIPHeader':
        this.realIPHeader = options[k]
        break

      case 'config':
        this.config = options[k]
        break

      case 'starPath':
        this.starPath = !!options[k]
        break

      case 'maxBody':
      case 'timeout':
      case 'connectTimeout':
      case 'maxAliveStreams':
      case 'requestTimeout':
        if (typeof options[k] === 'number' && !isNaN(options[k])) {
          this[k] = options[k]
        }
        break

      case 'addIP':
      case 'full':
      case 'debug':
        this[k] = !!options[k]
        break

      case 'connectOptions':
        if (options[k] && typeof options[k] === 'object') {
          for (let a in options[k]) this.connectOptions[a] = options[k][a]
        }
        break

      case 'port':
        // '' 和 0 表示不拼接；其他必须为 1~65535
        if (options[k] === '' || options[k] === 0 || options[k] === '0') {
          this.port = ''
        } else if (typeof options[k] === 'number'
                    || (typeof options[k] === 'string' && /^\d+$/.test(options[k]))) {
          let p = parseInt(options[k])
          if (p > 0 && p <= 65535) {
            this.port = p
          } else {
            console.error(`proxy port 超出范围: ${options[k]}`)
            this.port = ''
          }
        } else {
          console.error(`proxy port 必须是数字或数字字符串: ${options[k]}`)
          this.port = ''
        }
        break
    }
  }

  this.setHostProxy(this.config)

}

Http2Proxy.prototype.fmtConfig = function (cfg, k) {
  if (typeof cfg[k] === 'string') {
    cfg[k] = [
      { path : '/', url : cfg[k] }
    ]
  } else if (! (cfg[k] instanceof Array) ) {
    cfg[k] = [ cfg[k] ]
  }
}

Http2Proxy.prototype.checkConfig = function (tmp, k) {

  if (typeof tmp !== 'object' || (tmp instanceof Array) ) {
    console.error(`${k} ${JSON.stringify(tmp)} 错误的配置格式`)
    return false
  }

  if (tmp.path === undefined) {
    tmp.path = '/'
  }

  tmp.path = tmp.path.trim().replace(/(\/){2,}/g, '/')

  if (tmp.path.length > 2 && tmp.path[tmp.path.length - 1] === '/') {
    tmp.path = tmp.path.substring(0, tmp.path.length - 1)
  }

  if (tmp.url === undefined) {
    console.error(`${k} ${tmp.path}：没有指定要代理转发的url。`)
    return false
  }

  if (this.urlpreg.test(tmp.url) === false) {
    console.error(`${tmp.url} : 错误的url，请检查。`)
    return false
  }

  if (tmp.url[ tmp.url.length - 1 ] == '/') {
    tmp.url = tmp.url.substring(0, tmp.url.length - 1)
  }

  if (tmp.headers !== undefined) {
    if (typeof tmp.headers !== 'object') {
      console.error(`${k} ${tmp.url} ${tmp.path}：headers属性要求是object类型，使用key-value形式提供。`)
      return false
    }
  }

  return true
}

Http2Proxy.prototype.checkAndSetConfig = function (backend_obj, tmp) {
  if (tmp.headers && tmp.headers.toString() === '[object Object]') {
    backend_obj.headers = {}

    for (let h in tmp.headers) {
      backend_obj.headers[h] = tmp.headers[h]
    }

  }

  if (tmp.resHeaders && typeof tmp.resHeaders === 'object' && !(tmp.resHeaders instanceof Array)) {
    backend_obj.resHeaders = tmp.resHeaders
  }

  // 解析时判定类型，非函数置 null，运行时直接条件判断
  backend_obj.resHeadersCallback =
    (typeof tmp.resHeadersCallback === 'function') ? tmp.resHeadersCallback : null

  if (tmp.maxConnect && typeof tmp.maxConnect === 'number' && tmp.maxConnect > 1)
    backend_obj.maxConnect = tmp.maxConnect

  if (tmp.debug !== undefined) backend_obj.debug = tmp.debug

  if (tmp.weight && typeof tmp.weight === 'number' && tmp.weight > 1)
    backend_obj.weight = parseInt(tmp.weight)

  if (tmp.reconnDelay !== undefined && typeof tmp.reconnDelay === 'number') 
    backend_obj.reconnDelay = tmp.reconnDelay

  if (tmp.timeout !== undefined && typeof tmp.timeout === 'number')
    backend_obj.timeout = tmp.timeout

  if (tmp.rewrite && typeof tmp.rewrite === 'function')
    backend_obj.rewrite = tmp.rewrite

  if (tmp.connectTimeout && typeof tmp.connectTimeout === 'number' && !isNaN(tmp.connectTimeout))
  {
    backend_obj.connectTimeout = tmp.connectTimeout
  }

  if (tmp.maxAliveStreams && typeof tmp.maxAliveStreams === 'number' && tmp.maxAliveStreams > 0)
    backend_obj.maxAliveStreams = tmp.maxAliveStreams

}

Http2Proxy.prototype.setHostProxy = function (cfg) {
  if (typeof cfg !== 'object') return false

  let pt = ''
  let tmp = ''
  let backend_obj = null
  let tmp_cfg

  for (let k in cfg) {

    // 80/443 场景确保裸 + 带端口双 key 共享（key 裸则补带端口，key 带端口则补裸）；
    // port 为空但 key 带 :80/:443 后缀也补裸；其他端口裸 key 替换为带端口
    let keys = [k]
    if (this.port === 80 || this.port === 443) {
      let bareKey, portKey
      if (k.endsWith(':80')) { bareKey = k.slice(0, -3); portKey = k }
      else if (k.endsWith(':443')) { bareKey = k.slice(0, -4); portKey = k }
      else { bareKey = k; portKey = `${k}:${this.port}` }
      keys = [bareKey, portKey]
    } else if (this.port !== '' && !k.endsWith(`:${this.port}`)) {
      keys = [`${k}:${this.port}`]
    } else if (this.port === '' && (k.endsWith(':80') || k.endsWith(':443'))) {
      let bareKey = k.endsWith(':80') ? k.slice(0, -3) : k.slice(0, -4)
      keys = [bareKey, k]
    }

    tmp_cfg = Array.isArray(cfg[k]) ? cfg[k] : [ cfg[k] ]

    for (let i = 0; i < tmp_cfg.length; i++) {
      tmp = tmp_cfg[i]

      if (!this.checkConfig(tmp, k)) continue

      for (let hk of keys) {
        if (this.hostProxy[hk] === undefined) {
          this.hostProxy[hk] = {}
          this.proxyBalance[hk] = {}
        }
      }

      pt = fmtpath(tmp.path)

      backend_obj = {
        url: tmp.url,
        headers: null,
        resHeaders: null,
        resHeadersCallback: null,
        path: tmp.path,
        pathLength: tmp.path.length,
        rewrite: false,
        weight: 1,
        weightCount: 0,
        reconnDelay: 500,
        maxConnect: tmp.maxConnect || 10,
        debug: this.debug,
        h2Pool: null,
        timeout: this.timeout,
        connectTimeout: this.connectTimeout,
        maxAliveStreams: this.maxAliveStreams,
        // 透传配置项的总时长上限；运行时判定：undefined 未设置，0 不限制
        requestTimeout: tmp.requestTimeout,
        alive: false,
        connectOptions: {
          timeout: this.timeout,
          ...this.connectOptions
        }
      }

      if (tmp.connectOptions && typeof tmp.connectOptions === 'object') {
        for (let o in tmp.connectOptions) {
          backend_obj.connectOptions[o] = tmp.connectOptions[o]
        }
      }

      this.checkAndSetConfig(backend_obj, tmp)

      backend_obj.h2Pool = new Http2Pool({
        debug: backend_obj.debug,
        url: backend_obj.url,
        connectOptions: backend_obj.connectOptions,
        parent: backend_obj,
        reconnDelay: backend_obj.reconnDelay,
        quiet: true,
        timeout: backend_obj.timeout,
        connectTimeout: backend_obj.connectTimeout,
        maxAliveStreams: backend_obj.maxAliveStreams,
        maxConnect: backend_obj.maxConnect
      })

      backend_obj.h2Pool.createPool()

      if (this.hostProxy[keys[0]][pt] === undefined) {

        this.hostProxy[keys[0]][pt] = [ backend_obj ]

        this.proxyBalance[keys[0]][pt] = {
          stepIndex : 0,
          useWeight : false
        }

      } else if (this.hostProxy[keys[0]][pt] instanceof Array) {
        this.hostProxy[keys[0]][pt].push(backend_obj)
      }

      // 双 key 共享同一数组与 balance（同引用），保证 alive 状态与权重步进一致
      if (keys.length > 1) {
        for (let hk of keys) {
          if (hk === keys[0]) continue
          this.hostProxy[hk][pt] = this.hostProxy[keys[0]][pt]
          this.proxyBalance[hk][pt] = this.proxyBalance[keys[0]][pt]
        }
      }

      if (backend_obj.weight > 1) this.proxyBalance[keys[0]][pt].useWeight = true

      this.pathTable[pt] = 1

    } //end sub for

  } //end for

}

Http2Proxy.prototype.checkAlive = function (pr) {
  if (!pr.h2Pool) return false
  return pr.h2Pool.ok()
}

Http2Proxy.prototype.getBackend = function (c, host) {
  let prlist = this.hostProxy[host][c.routepath]
  let pxybalance = this.proxyBalance[host][c.routepath]

  if (this.balancer) {
    return this.balancer.select(c, prlist, pxybalance)
  }

  let pr

  if (prlist.length === 1) {
    pr = prlist[0]
  } else {
    if (pxybalance.stepIndex >= prlist.length) {
      pxybalance.stepIndex = 0
    }

    pr = prlist[pxybalance.stepIndex]

    if (pxybalance.useWeight) {
      if (pr.weightCount >= pr.weight) {
        pr.weightCount = 0
        pxybalance.stepIndex += 1
      } else {
        pr.weightCount += 1
      }
    } else {
      pxybalance.stepIndex += 1
    }
  }

  return pr
}

//把http1的消息头转换为http2支持的
Http2Proxy.prototype.fmtHeaders = function (headers, ctx) {
  let http2_headers = {
    ':method': ctx.method,
    ':path': headers[':path'] || (ctx.req && ctx.req.url) || ctx.path,
  }

  // Connection 头列出的额外逐跳头，转换时一并剥离
  const extraHop = connectionTokens(headers.connection)

  for (let k in headers) {
    //if (typeof k !== 'string') continue

    if (extraHop[k]) continue

    switch (k) {
      case 'connection':
      case 'keep-alive':
      case 'upgrade':
      case 'transfer-encoding':
      case 'proxy-connection':
      case 'proxy-authenticate':
      case 'proxy-authorization':
      case 'te':
      case 'trailer':
      case ':path':
      case ':method':
      case 'method':
        break

      case 'host':
        http2_headers[':authority'] = headers[k]
        break

      default:
        http2_headers[k] = headers[k]
    }
  }

  return http2_headers
}

Http2Proxy.prototype.mid = function () {
  let self = this

  let timeoutError = new Error('request timeout')

  timeoutError.code = 'ETIMEOUT'

  return async (c, next) => {
    let host = c.host

    if (!self.hostProxy[host] || !self.hostProxy[host][c.routepath]) {
      if (self.full) {
        return c.status(502).to(error_502_text)
      }

      return await next(c)
    }

    let pr = self.getBackend(c, host)
    if (!pr) return c.status(503).to(error_503_text)

    if (self.addIP && c.headers[self.realIPHeader]) {
      c.headers[self.realIPHeader] += `,${c.ip}`
    } else {
      c.headers[self.realIPHeader] = c.ip
    }

    let hii = pr.h2Pool

    try {
      if (pr.headers) {
        for (let k in pr.headers) c.headers[k] = pr.headers[k]
      }

      if (pr.rewrite) {
        let rpath = pr.rewrite(c, c.major > 1 ? c.headers[':path'] : c.req.url)

        if (rpath) {
          let path_typ = typeof rpath
          if (path_typ === 'object' && rpath.redirect) {
            // 重定向必须携带 3xx 状态码，否则客户端收到 200 + location 不会跳转
            return c.status(302).setHeader('location', rpath.redirect)
          } else if (path_typ === 'string') {
            if (c.major > 1)
              c.headers[':path'] = rpath
            else c.req.url = rpath
          }
        }
      }

      await new Promise(async (rv, rj) => {
        let resolved = false
        let rejected = false

        // ctx.stream 的类型随服务形态不同：
        // 纯 h2：ServerHttp2Stream（本体即 h2 流）；
        // ALPN h2：Http2ServerResponse（底层 h2 流在 .stream 属性上）；
        // ALPN h1 / 纯 h1：ServerResponse 或不存在 → 归一化为 null，走 h1 分支。
        // 判别只用文档化属性（.stream + c.major），跨 Node 版本安全
        let request_stream = null
        if (c.major > 1 && c.stream) {
          request_stream = c.stream.stream || c.stream
        }

        let stm = null

        stm = await hii.request(c.major > 1 ? c.headers : this.fmtHeaders(c.headers, c))
                      .catch(err => {
                          rejected = true
                          rj(err)
                          stm = null
                      })

        if (!stm) {
          rj(new Error('request failed'))
          return false
        }

        if (request_stream) {
          // h2 下游：close 是所有终止路径（正常/超时/取消/错误）的统一出口，
          // rstCode 携带取消原因，不再监听冗余的 aborted
          request_stream.on('timeout', () => {
            stm.close(http2.constants.NGHTTP2_CANCEL)
          })

          request_stream.on('close', () => {
            if (request_stream.rstCode !== http2.constants.NGHTTP2_NO_ERROR) {
              stm.close(request_stream.rstCode)
            }
          })

          request_stream.on('error', err => {
            stm.close(http2.constants.NGHTTP2_INTERNAL_ERROR)
            stm.destroy()
          })
        } else if (c.res && typeof c.res.on === 'function') {
          // h1 下游：响应未完成即关闭 = 客户端提前断开 → 终止上游流。
          // 'close' 覆盖正常/中断全部路径，writableEnded 为判别依据；
          // 不用已弃用的 'aborted'/req.aborted，也不用 destroyed
          // （流正常完成后 destroyed 同样为 true，会把正常响应误判为中断）
          c.res.on('close', () => {
            if (!c.res.writableEnded && !stm.destroyed) stm.destroy()
          })
        }

        stm.setTimeout(pr.timeout, () => {
          //stm.close(http2.constants.NGHTTP2_CANCEL)
          stm.destroy()
        })

        stm.on('aborted', err => {
          !stm.destroyed && stm.destroy()

          if (!resolved && !rejected) {
            rejected = true
            rj(err)
          }
        })

        stm.on('close', () => {
          if (stm.rstCode === http2.constants.NGHTTP2_NO_ERROR) {
            if (!resolved && !rejected) {
              resolved = true
              rv()
            }
          } else {
            if (!resolved && !rejected) {
              rejected = true
              rj(new Error(`stream close, exit code ${stm.rstCode}`))
            }
          }
        })

        stm.on('response', (headers, flags) => {
          // ---- 代理传输总时长上限（毫秒）----
          // 优先级：ctx.box > 代理配置项 > 全局默认
          // undefined = 未设置，继续向下一级查找；0 = 显式不限制
          let rt = 0
          if (c.box && typeof c.box.requestTimeout === 'number') {
            rt = c.box.requestTimeout
          } else if (pr && typeof pr.requestTimeout === 'number') {
            rt = pr.requestTimeout
          } else if (typeof self.requestTimeout === 'number') {
            rt = self.requestTimeout
          }

          if (rt > 0) {
            let rtTimer = setTimeout(() => {
              !stm.destroyed && stm.destroy()       // 断开后端 h2 流
              !c.res.destroyed && c.res.destroy()   // 断开客户端（h2 伪流 / h1 原生 res）
            }, rt)
            // h2 流 close 是所有结束路径的终点，仅此处清理即可
            stm.on('close', () => clearTimeout(rtTimer))
          }

          // 防御性剥离逐跳头：后端是 h2，协议本身禁止发送这些头，
          // 此处过滤兜底异常后端（透传给 h2 客户端会被 nghttp2 判协议错误）
          const extraHopRes = connectionTokens(headers.connection)

          for (let k in headers) {
            if (k === ':status') continue
            if (typeof k !== 'string') continue

            if (k[0] === ':' || HOP_BY_HOP_HEADERS[k] || extraHopRes[k]) {
              delete headers[k]
            }
          }

          if (c.res && c.res.writable) {
            if (c.res.respond) {
              // HTTP/2：合并配置的响应消息头后一次性发送
              if (pr.resHeadersCallback) {
                let rh = pr.resHeadersCallback(c)
                if (rh && typeof rh === 'object') {
                  for (let k in rh) headers[k] = rh[k]
                }
              } else if (pr.resHeaders) {
                for (let k in pr.resHeaders) headers[k] = pr.resHeaders[k]
              }

              c.res.respond(headers)
            } else if (c.res.setHeader) {
              c.status(headers[':status'])

              for (let k in headers) {
                if (typeof k !== 'string' || k[0] === ':') continue

                c.res.setHeader(k, headers[k])
              }

              // 配置的响应消息头：resHeadersCallback 优先，返回对象则设置；否则设置静态 resHeaders
              if (pr.resHeadersCallback) {
                let rh = pr.resHeadersCallback(c)
                if (rh && typeof rh === 'object') {
                  for (let k in rh) c.res.setHeader(k, rh[k])
                }
              } else if (pr.resHeaders) {
                for (let k in pr.resHeaders) c.res.setHeader(k, pr.resHeaders[k])
              }

              // 🌟 新增：强制将 HTTP/1 的 Headers 发送出去
              if (c.res.flushHeaders) {
                c.res.flushHeaders()
              }
            }
          }

        })

        stm.on('frameError', err => {
          stm.close(http2.constants.NGHTTP2_INTERNAL_ERROR)
          stm.destroy()
        })

        stm.on('error', err => {
          self.debug && console.error('------ error ------',err)
          //stm.close(http2.constants.NGHTTP2_INTERNAL_ERROR)
          stm.destroy(err)
        })

        c.req.on('data', chunk => {
          // stm 已销毁（后端错误/超时/取消）时丢弃数据，
          // 避免 write 抛出 ERR_STREAM_DESTROYED 未捕获异常
          if (stm.destroyed) return

          // 背压控制：h2 流控窗口耗尽时 write 返回 false，
          // 暂停客户端读取，drain 后恢复，防止数据在流缓冲无限堆积
          let ok = stm.write(chunk)
          if (!ok) {
            c.req.pause()
            stm.once('drain', () => {
              c.req.resume()
            })
          }
        })

        c.req.on('end', () => {
          // stm 未销毁才 end，否则忽略
          !stm.destroyed && stm.end()
        })

        const onDrain = () => stm.resume()
        if (c.res) c.res.on('drain', onDrain)

        stm.on('data', chunk => {
          if (c.res && c.res.writable) {
            if (c.res.write(chunk) === false) {
              stm.pause()
            }
          }
        })

        stm.on('end', () => {
          if (c.res) c.res.removeListener('drain', onDrain)
          
          !stm.closed && stm.close()

          if (!resolved && !rejected) {
            resolved = true
            rv()
          }
        })

      })
    } catch (err) {
      self.debug && console.error(err||'request null error')
      c.status(503).to(error_503_text)
    }

  }

}

Http2Proxy.prototype.init = function (app) {
  app.config.timeout = this.timeout

  for (let p in this.pathTable) {
    app.router.map(this.methods, p, async c => {}, '@topbit_h2_proxy');
  }

  app.use(this.mid(), {
    pre: true,
    group: `topbit_h2_proxy`
  })

}

module.exports = Http2Proxy
