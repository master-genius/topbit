'use strict';

const urlparse = require('node:url');
const http = require('node:http');
const https = require('node:https');

const HTTP2_PSEUDO_HEADERS = Object.create(null)
HTTP2_PSEUDO_HEADERS[':method'] = true
HTTP2_PSEUDO_HEADERS[':path'] = true
HTTP2_PSEUDO_HEADERS[':scheme'] = true
HTTP2_PSEUDO_HEADERS[':authority'] = true

const IGNORE_HTTP2_HEADERS = {
  'connection': true,
  'keep-alive': true,
  'transfer-encoding': true,
  'proxy-connection': true
}

function cleanHeadersForHttp1(headers) {
  const h1Headers = Object.create(null)
  
  for (const k in headers) {
    if (!HTTP2_PSEUDO_HEADERS[k]) {
      h1Headers[k] = headers[k]
    }
  }
  
  if (!h1Headers.host && headers[':authority']) {
    h1Headers.host = headers[':authority']
  }
  
  return h1Headers
}

/**
 * {
 *    host : {}
 * }
 * {
 *    host : ''
 * }
 * 
 * {
 *    host : [
 *      {}
 *    ]
 * }
 * 
 */

class ProxyNoAgent {

  constructor(options = {}) {

    this.methods = ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH', 'TRACE']

    this.realIPHeader = 'x-real-ip'

    this.hostProxy = {}

    this.proxyBalance = {}

    this.pathTable = {}

    this.config = {}

    this.urlpreg = /(?:unix:\/\/\/[a-zA-Z0-9\-\_\/\.]+|unix:\/\/[a-zA-Z0-9\-\_]+|(?:http|https):\/\/[\[a-zA-Z0-9\-\_]+)/

    this.maxBody = 50000000

    // 初始化时告知的服务端口，用于自动拼接 hostProxy 的 key；'' 或 0 表示不拼接
    this.port = ''

    //是否启用全代理模式。
    this.full = false

    this.timeout = 35000

    // 代理传输总时长上限（毫秒），0 表示不限制；响应头到达后开始计时
    this.requestTimeout = 600000

    this.addIP = false

    this.debug = false

    this.autoClearListeners = false

    //记录定时器
    this.proxyIntervals = {}

    this.connectOptions = {
      family: 4
    }

    this.error = {
      '502' : `<!DOCTYPE html><html>
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
      </html>`,

      '503' :`<!DOCTYPE html><html>
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
    }

    if (typeof options !== 'object') {
      options = {}
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

        case 'host':
        case 'config':
          this.config = options[k]
          break

        case 'methods':
          Array.isArray(options[k]) && (this.methods = options[k]);
          break

        case 'maxBody':
          if (typeof options[k] == 'number' && parseInt(options[k]) >= 0) {
            this.maxBody = parseInt(options[k])
          }
          break
      
        case 'full':
        case 'debug':
        case 'autoClearListeners':
          this[k] = !!options[k]
          break

        case 'timeout':
          if (typeof options[k] === 'number' && options[k] >= 0) {
            this.timeout = options[k]
          }
          break

        case 'requestTimeout':
          if (typeof options[k] === 'number' && options[k] >= 0) {
            this.requestTimeout = options[k]
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

        case 'addIP':
          this.addIP = options[k]
          break

        case 'connectOptions':
          if (options[k] && typeof options[k] === 'object') {
            for (let o in options[k]) this.connectOptions[o] = options[k][o]
          }
          break

        default:;
      }
    }

    this.setHostProxy(this.config)
  }

  fmtpath(path) {
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

  setHostProxy(cfg) {
    if (typeof cfg !== 'object') {
      return
    }

    let pt = ''
    let tmp = ''
    let backend_obj = null

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

      if (typeof cfg[k] === 'string') {
        cfg[k] = [ { path : '/', url : cfg[k] } ]

      } else if (!(cfg[k] instanceof Array) && typeof cfg[k] === 'object') {
        cfg[k] = [ cfg[k] ]

      } else if ( !(cfg[k] instanceof Array) ) {
        continue
      }
      /**
       * {
       *    path : '',
       *    url : '',
       *    aliveCheckPath : '',
       *    headers : {}
       * }
       */
        for (let i = 0; i < cfg[k].length; i++) {
          tmp = cfg[k][i]

          if (typeof tmp !== 'object' || (tmp instanceof Array) ) {
            console.error(`${k} ${JSON.stringify(tmp)} 错误的配置格式`)
            continue
          }

          if (tmp.path === undefined) {
            tmp.path = '/'
          }

          if (tmp.url === undefined) {
            console.error(`${k} ${tmp.path}：没有指定要代理转发的url。`)
            continue
          }

          if (this.urlpreg.test(tmp.url) === false) {
            console.error(`${tmp.url} : 错误的url，请检查。`)
            continue
          }

          pt = this.fmtpath(tmp.path)
    
          if (tmp.url[ tmp.url.length - 1 ] == '/') {
            tmp.url = tmp.url.substring(0, tmp.url.length - 1)
          }
    
          if (tmp.headers !== undefined) {
            if (typeof tmp.headers !== 'object') {
              console.error(
                `${k} ${tmp.url} ${tmp.path}：headers属性要求是object类型，使用key-value形式提供。`
              );
              continue
            }
          }

          for (let hk of keys) {
            if (this.hostProxy[hk] === undefined) {
              this.hostProxy[hk] = {}
              this.proxyBalance[hk] = {}
            }
          }
    
          tmp.urlobj = this.parseUrl(tmp.url)

          tmp.urlobj.timeout = tmp.timeout || this.timeout

          backend_obj = {
            url : tmp.url,
            urlobj : tmp.urlobj,
            // 透传配置项的总时长上限；运行时判定：undefined 未设置，0 不限制
            requestTimeout : tmp.requestTimeout,
            headers : {},
            resHeaders : null,
            resHeadersCallback : null,
            path : tmp.path,
            weight: 1,
            weightCount : 0,
            alive : true,
            aliveCheckInterval : 5,
            aliveCheckPath : '/',
            aliveCheckMethod: (tmp.aliveCheckMethod
                              && (['GET', 'TRACE', 'HEAD'].includes(tmp.aliveCheckMethod)) )
                            ? tmp.aliveCheckMethod : 'GET',
            intervalCount : 0,
            rewrite: (tmp.rewrite && typeof tmp.rewrite === 'function') ? tmp.rewrite : null,
            connectOptions: {...this.connectOptions}
          }

          // FIX: 原来是 typeof tmp.connectOptions（永远 truthy），修正为严格类型判断
          if (tmp.connectOptions && typeof tmp.connectOptions === 'object') {
            for (let o in tmp.connectOptions) {
              backend_obj.connectOptions[o] = tmp.connectOptions[o]
            }
          }

          if (tmp.headers !== undefined) {
            for (let h in tmp.headers) {
              backend_obj.headers[h] = tmp.headers[h]
            }
          }

          if (tmp.resHeaders !== undefined) {
            if (typeof tmp.resHeaders === 'object' && !(tmp.resHeaders instanceof Array)) {
              backend_obj.resHeaders = tmp.resHeaders
            } else {
              console.error(
                `${k} ${tmp.url} ${tmp.path}：resHeaders属性要求是object类型，使用key-value形式提供。`
              )
            }
          }

          // 解析时判定类型，非函数置 null，运行时直接条件判断
          backend_obj.resHeadersCallback =
            (typeof tmp.resHeadersCallback === 'function') ? tmp.resHeadersCallback : null

          if (typeof tmp.aliveCheckPath === 'string' && tmp.aliveCheckPath.length > 0) {
            if (tmp.aliveCheckPath[0] !== '/') {
              tmp.aliveCheckPath = `/${tmp.aliveCheckPath}`
            }

            backend_obj.aliveCheckPath = tmp.aliveCheckPath
          }

          if (tmp.weight && typeof tmp.weight === 'number' && tmp.weight > 1) {
            backend_obj.weight = parseInt(tmp.weight)
          }

          if (tmp.aliveCheckInterval !== undefined && typeof tmp.aliveCheckInterval === 'number') {
            if (tmp.aliveCheckInterval >= 0 && tmp.aliveCheckInterval <= 7200) {
              backend_obj.aliveCheckInterval = tmp.aliveCheckInterval
            }
          }

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

          if (backend_obj.weight > 1) {
            this.proxyBalance[k][pt].useWeight = true
          }

          this.pathTable[pt] = 1
        } //end sub for
    } // end for
  }

  parseUrl(url) {
    let u = new urlparse.URL(url)

    let urlobj = {
      hash    : u.hash,
      hostname: u.hostname,
      protocol: u.protocol,
      path    : u.pathname,
      method  : 'GET',
      headers : {},
    }

    if (u.search.length > 0) {
      urlobj.path += u.search
    }
    
    if (u.protocol  === 'unix:') {
      urlobj.protocol = 'http:'
      let sockarr = u.pathname.split('.sock')
      urlobj.socketPath = `${sockarr[0]}.sock`
      urlobj.path = sockarr[1]
    } else {
      urlobj.host = u.host
      urlobj.port = u.port
    }
  
    if (u.protocol === 'https:') {
      urlobj.requestCert = false
      urlobj.rejectUnauthorized = false
    }
  
    return urlobj
  }

  copyUrlobj(uobj) {
    let u = {
      hash: uobj.hash,
      hostname: uobj.hostname,
      protocol: uobj.protocol,
      path: uobj.path,
      method: 'GET',
      headers: {},
      timeout: uobj.timeout
    }

    if (uobj.host) {
      u.host = uobj.host
      u.port = uobj.port
    } else {
      u.socketPath = uobj.socketPath
    }

    if (uobj.protocol === 'https:') {
      u.requestCert = false
      u.rejectUnauthorized = false
    }

    return u
  }

  getBackend(c, host) {
    let prlist = this.hostProxy[host][c.routepath]
    let pb = this.proxyBalance[host][c.routepath]
    if (this.balancer) {
      return this.balancer.select(c, prlist, pb)
    }

    let pr

    if (prlist.length === 1) {
      pr = prlist[0]
    } else {
      if (pb.stepIndex >= prlist.length) {
        pb.stepIndex = 0
      }

      pr = prlist[pb.stepIndex]

      if (pb.useWeight) {
        if (pr.weightCount >= pr.weight) {
          pr.weightCount = 0
          pb.stepIndex++
        } else {
          pr.weightCount++
        }
      } else {
        pb.stepIndex++
      }
    }

    if (pr.alive === false) {
      for (let i = 0; i < prlist.length; i++) {
        
        pr = prlist[i]

        if (pr.alive === true) {
          return pr
        }
      }
      return null
    }

    return pr
  }

  mid() {
    let self = this
    let timeoutError = new Error('request timeout')
    timeoutError.code = 'ETIMEOUT'

    return async (c, next) => {

      let host = c.host

      if (self.hostProxy[host]===undefined || self.hostProxy[host][c.routepath]===undefined) {
        if (self.full) {
          return c.status(502).to(self.error['502'])
        }
        return await next(c)
      }

      let pr = self.getBackend(c, host)

      if (pr === null) {
        for (let i = 0; i < 50; i++) {
          await new Promise((rv, rj) => {setTimeout(rv, 60)})
          pr = self.getBackend(c, host)
          if (pr) break
        }

        if (!pr)
          return c.status(503).to(self.error['503'])
      }

      let urlobj = self.copyUrlobj(pr.urlobj)

      urlobj.path = c.req.url
      urlobj.headers = cleanHeadersForHttp1(c.headers)
      urlobj.method = c.method

      // 合并配置的自定义请求头（配置覆盖客户端同名头）
      for (let k in pr.headers) {
        urlobj.headers[k] = pr.headers[k]
      }

      if (self.addIP && urlobj.headers[self.realIPHeader]) {
        urlobj.headers[self.realIPHeader] += `,${c.ip}`
      } else {
        urlobj.headers[self.realIPHeader] = c.ip
      }

      let hci = urlobj.protocol == 'https:' ? https : http

      for (let k in pr.connectOptions) {
        urlobj[k] = pr.connectOptions[k]
      }

      if (pr.rewrite) {
        let rw = pr.rewrite(c, c.req.url)
        
        if (rw) {
          let path_typ = typeof rw
          if (path_typ === 'string') {
            urlobj.path = rw
          } else if (path_typ === 'object' && rw.redirect) {
            return c.setHeader('location', rw.redirect)
          }
        }
      }

      let h = hci.request(urlobj)

      return await new Promise((rv, rj) => {
        let resolved = false
        let rejected = false

        c.req.on('timeout', () => {
          !h.destroyed && h.destroy(timeoutError)
        })

        c.res.on('timeout', () => {
          !h.destroyed && h.destroy(timeoutError)
        })

        h.on('timeout', () => {
          !h.destroyed && h.destroy(timeoutError)
        })

        h.on('close', () => {
          if (!resolved && !rejected) {
            resolved = true
            rv()
          }
        })

        h.on('response', res => {
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
              !res.destroyed && res.destroy()       // 断开后端响应流
              !c.res.destroyed && c.res.destroy()   // 断开客户端连接
            }, rt)
            // 三条结束路径均清理，防 timer 泄漏
            res.on('end',   () => clearTimeout(rtTimer))
            res.on('error', () => clearTimeout(rtTimer))
            h.on('close',   () => clearTimeout(rtTimer))
          }

          c.status(res.statusCode)

          if (c.major === 2) {
            for (let k in res.headers) {
              if (IGNORE_HTTP2_HEADERS[k]) continue
              c.setHeader(k, res.headers[k])
            }
          } else {
            for (let k in res.headers) {
              c.setHeader(k, res.headers[k])
            }
          }

          // 配置的响应消息头：resHeadersCallback 优先，返回对象则设置；否则设置静态 resHeaders
          if (pr.resHeadersCallback) {
            let rh = pr.resHeadersCallback(c)
            if (rh && typeof rh === 'object') {
              for (let k in rh) {
                c.setHeader(k, rh[k])
              }
            }
          } else if (pr.resHeaders) {
            for (let k in pr.resHeaders) {
              c.setHeader(k, pr.resHeaders[k])
            }
          }

          if (c.res.flushHeaders) {
            c.res.flushHeaders()
          }

          res.on('data', chunk => {
            // 客户端已断开：停止从后端抽数据，尽早释放后端连接
            if (!c.res.writable) {
              res.destroy()
              return
            }
            // 背压：write 返回 false 时暂停后端流，等 drain 后恢复，与请求方向一致
            if (!c.res.write(chunk)) {
              res.pause()
              c.res.once('drain', () => res.resume())
            }
          })
      
          res.on('end', () => {
            c.res.writable && c.res.end()

            if (!resolved && !rejected) {
              resolved = true
              rv()
            }
          })
      
            res.on('error', err => {
                if (!resolved && !rejected){
                  rejected = true
                  rj(err)
                }
            })
        })

        h.on('error', (err) => {
          if (!resolved && !rejected) {
            rejected = true
            rj(err)
          }
        })
    
        c.req.on('data', chunk => {
          if (h.destroyed) return

          // 背压控制：write 返回 false 时暂停上游，等 drain 后恢复
          let ok = h.write(chunk)
          if (!ok) {
            c.req.pause()
            h.once('drain', () => {
              c.req.resume()
            })
          }
        })
    
        c.req.on('end', () => {
          // h 未销毁才 end，否则忽略
          !h.destroyed && h.end()
        })
    
      }).catch(err => {
        self.debug && console.error(err);
        c.status(503).to(self.error['503']);
      })
      .finally(() => {
        this.autoClearListeners && h.removeAllListeners && h.removeAllListeners();
        !h.destroyed && h.destroy();
      })

    }

  }

  timerRequest(pxy, timeout=false) {
    let h = http

    let opts = {
      timeout : this.timeout + 30_000,
      method: pxy.aliveCheckMethod || 'GET',
      headers: {
        'user-agent': 'Node.js/Topbit,Topbit-Toolkit: Proxy,AliveCheck'
      }
    }

    if (pxy.urlobj.protocol === 'https:') {
      h = https
      opts.rejectUnauthorized = false
      opts.requestCert = false
    }

    for (let o in pxy.connectOptions) {
      opts[o] = pxy.connectOptions[o]
    }

    if (pxy.urlobj.socketPath) {
      opts.socketPath = pxy.urlobj.socketPath
    }

    let aliveUrl = pxy.urlobj.socketPath
      ? `${pxy.urlobj.protocol}//unix${pxy.aliveCheckPath}`
      : `${pxy.urlobj.protocol}//${pxy.urlobj.host}${pxy.aliveCheckPath}`

    let req = h.request(aliveUrl, opts)
    
    req.on('error', err => {
      pxy.alive = false
      //当出现连接错误，立即发起一个请求，测试是否是某些特殊情况导致的异常，比如服务重启导致瞬间请求失败。
      if (!timeout) {
        setTimeout(() => {
          this.timerRequest(pxy, true)
        }, 500)
      }
    })

    req.on('response', res => {
      pxy.alive = true

      res.on('error', err => {

      })

      res.on('data', chunk => {
        pxy.alive = true
      })
      
      res.on('end', () => {
        pxy.alive = true
      })
    })

    req.end()
  }

  setTimer(pxys) {
    let count = 0

    for (let p of pxys) {
      if (p.aliveCheckInterval > 0) count++
    }

    if (count === 0) return null
    
    let self = this

    return setInterval(() => {
      for (let i = 0; i < pxys.length; i++) {
        if (pxys[i].aliveCheckInterval <= 0) continue

        pxys[i].intervalCount++

        if (pxys[i].intervalCount >= pxys[i].aliveCheckInterval) {
          pxys[i].intervalCount = 0
          self.timerRequest(pxys[i])
        }
      }

    }, 1000)
    
  }

  init(app) {
    app.config.timeout = this.timeout

    for (let p in this.pathTable) {
      app.router.map(this.methods, p, async c => {}, '@topbit_proxy')
    }

    app.use(this.mid(), {pre: true, group: `topbit_proxy`})

    for (let k in this.hostProxy) {

      // :80/:443 别名 key：仅当对应裸 key 存在时跳过（裸 key 负责 alive 检测）；
      // 手工配置的带端口 key 无裸 key 对应，不跳过
      if (k.endsWith(':80') && this.hostProxy[k.slice(0, -3)] !== undefined) continue
      if (k.endsWith(':443') && this.hostProxy[k.slice(0, -4)] !== undefined) continue

      this.proxyIntervals[k] = {}

      for (let p in this.hostProxy[k]) {
        this.proxyIntervals[k][p] = this.setTimer(this.hostProxy[k][p])
      }

    }

  }

}

module.exports = ProxyNoAgent
