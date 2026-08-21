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

let error_504_text = `<!DOCTYPE html><html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Error 504</title>
      </head>
      <body>
        <div style="width:100%;font-size:105%;color:#737373;padding:0.8rem;">
          <h2>504 Gateway Timeout</h2><br>
          <p>代理请求超时。</p>
        </div>
      </body>
  </html>`

let error_413_text = `<!DOCTYPE html><html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Error 413</title>
      </head>
      <body>
        <div style="width:100%;font-size:105%;color:#737373;padding:0.8rem;">
          <h2>413 Payload Too Large</h2><br>
          <p>请求数据超过允许的大小。</p>
        </div>
      </body>
  </html>`

// 后端错误码 → 网关状态码映射
// 超时（含自造的 ETIMEOUT）语义上是上游超时 → 504；
// 连接层面不可达（拒绝/复位/DNS/网络不可达）→ 502；
// 其余不确定错误保持 503。
const GATEWAY_TIMEOUT_CODES = {
  ETIMEOUT: true, ETIMEDOUT: true, ESOCKETTIMEDOUT: true
}

const BAD_GATEWAY_CODES = {
  ECONNREFUSED: true, ECONNRESET: true, EHOSTUNREACH: true, ENETUNREACH: true,
  ENOTFOUND: true, EAI_AGAIN: true, EPIPE: true, EPROTO: true,
  ERR_TLS_CERT_ALTNAME_INVALID: true, ERR_HTTP2_ERROR: true,
  ERR_HTTP2_SESSION_ERROR: true, ERR_HTTP2_GOAWAY_SESSION: true
}

const ERROR_PAGE = {
  413: error_413_text,
  502: error_502_text,
  503: error_503_text,
  504: error_504_text
}

function mapErrorStatus(err) {
  const code = err && err.code
  if (!code) return 503
  if (code === 'EMAXBODY') return 413
  if (GATEWAY_TIMEOUT_CODES[code]) return 504
  if (BAD_GATEWAY_CODES[code]) return 502
  return 503
}

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

/**
 * 生成 routepath 的降级候选序列，按最长前缀优先。
 * 路由表是所有 host 的 path 并集，路由匹配发生在中间件之前且不感知 Host，
 * 因此 c.routepath 是"全局最具体"，未必是"该 host 范围内最具体"——
 * 例如 a.com 声明 /api、b.com 只声明 /，请求 b.com/api/x 会命中 /api/*，
 * 而 hostProxy['b.com'] 里没有这一条。降级序列用于把它退回该 host 自己声明过的前缀。
 *
 * '/v1/api/*' -> ['/v1/*', '/*']
 * '/*'        -> []
 * 参数路由（不以 /* 结尾）不参与降级。
 */
function fallbackPaths(routepath) {
  if (!routepath.endsWith('/*')) return []

  let base = routepath.slice(0, -2)

  const out = []

  while (base.length > 0) {
    base = base.slice(0, base.lastIndexOf('/'))
    out.push(`${base}/*`)
  }

  return out
}

let Http2Proxy = function (options = {}) {

  if (!(this instanceof Http2Proxy)) return Http2Proxy(options)

  if (typeof options !== 'object') options = {}

  this.urlpreg = /(?:unix:\/\/\/[a-zA-Z0-9\-\_\/\.]+|unix:\/\/[a-zA-Z0-9\-\_]+|(?:http|https):\/\/[\[a-zA-Z0-9\-\_]+)/

  // 查表 key 直接来自 Host 头（外部可控），用无原型对象避免取到 constructor 等原型属性。
  // 内层以 routepath 为 key，必然以 / 开头，本无此风险，一并统一形态。
  this.hostProxy = Object.create(null)
  this.proxyBalance = Object.create(null)
  this.pathTable = Object.create(null)

  // host -> { 全局path: 降级后的path }，init() 中预计算
  this.pathFallback = Object.create(null)

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

  this.addIP = false

  this.debug = false

  // 初始化时告知的服务端口，用于自动拼接 hostProxy 的 key；'' 或 0 表示不拼接
  this.port = ''

  // default_server：host 未命中时的回退目标。
  // defaultServer 保存用户原始配置值，defaultHost 是归一化并校验后的 hostProxy key。
  this.defaultServer = ''

  this.defaultHost = null

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

      case 'defaultServer':
        if (typeof options[k] === 'string') {
          this.defaultServer = options[k]
        } else {
          console.error(`defaultServer 必须是字符串: ${options[k]}`)
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

  // defaultServer 归一化：c.host 与 hostProxy 的 key 都是纯 host[:port]，不含协议前缀
  // （Host 头 / :authority 按 RFC 无 scheme），因此容错用户写成 URL 的情况，
  // 削掉 scheme 与 path 后再校验是否真的存在于配置中。必须放在 setHostProxy 之后。
  if (this.defaultServer) {
    let d = this.defaultServer.replace(/^https?:\/\//, '')
                              .replace(/\/.*$/, '')
                              .trim()

    // setHostProxy 会按 this.port 改写配置 key（非 80/443 时裸 key 变为 host:port），
    // defaultServer 允许用户按 config 里的写法给裸 host，故先查原样、再查补端口的形式。
    if (d.length === 0) {
      console.error(`defaultServer: ${this.defaultServer} 格式错误，已忽略`)
    } else if (this.hostProxy[d] !== undefined) {
      this.defaultHost = d
    } else if (this.port !== '' && this.hostProxy[`${d}:${this.port}`] !== undefined) {
      this.defaultHost = `${d}:${this.port}`
    } else {
      console.error(`defaultServer: ${this.defaultServer} 不在 host 配置中，已忽略`)
    }
  }

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
          this.hostProxy[hk] = Object.create(null)
          this.proxyBalance[hk] = Object.create(null)
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
        // 透传后端级请求体上限；undefined 表示未设置，回退到代理实例配置
        maxBody: tmp.maxBody,
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
        reconnDelay: backend_obj.reconnDelay,
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
    // 第三方 balancer 的返回值不受本模块控制：非对象一律归一化为 null，
    // 交由上层统一走 503，避免 undefined 直接被解引用抛 TypeError
    const picked = this.balancer.select(c, prlist, pxybalance)
    return (picked && typeof picked === 'object') ? picked : null
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

  let maxBodyError = new Error('request body too large')
  maxBodyError.code = 'EMAXBODY'

  return async (c, next) => {
    let host = c.host

    // host 未命中时回退到 default_server。路由未命中不回退——那是"该 server 块里
    // 没有这条 location"，与 nginx 的 server → location 两级匹配一致。
    // 注意未命中后走 next()，会落到 init() 注册的空 handler（空响应），不是 404。
    if (!self.hostProxy[host] && self.defaultHost !== null) {
      host = self.defaultHost
    }

    const t = self.hostProxy[host]

    // 该 host 没声明这条全局 path，退回它自己声明过的最长前缀（见 buildPathFallback）。
    // 直接改写 c.routepath——这就是本次代理实际执行的 routepath。降级成功必然命中，
    // 不会走到下面的 next()，因此不存在改写后泄漏给下游中间件的情况。
    if (t && !t[c.routepath]) {
      const fb = self.pathFallback[host]
      if (fb && fb[c.routepath]) c.routepath = fb[c.routepath]
    }

    if (!t || !t[c.routepath]) {
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

      // ---- 代理请求体上限（字节）----
      // 优先级：ctx.box.proxyMaxBody > 后端配置 maxBody > 代理实例 maxBody
      // 之所以不直接用 ctx.maxBody：框架必定会给它赋上 config.maxBody，
      // 无法区分"前置中间件显式设置"与"框架默认值"，故另立 box 字段。
      // 语义与框架 maxBody 一致：按累计字节数直接比较，0 即不允许请求体。
      let maxBodyLimit = self.maxBody
      if (c.box && typeof c.box.proxyMaxBody === 'number' && !isNaN(c.box.proxyMaxBody)) {
        maxBodyLimit = c.box.proxyMaxBody
      } else if (pr && typeof pr.maxBody === 'number' && !isNaN(pr.maxBody)) {
        maxBodyLimit = pr.maxBody
      }

      // 预检：声明了 content-length 且已超限，直接拒绝，不必占用后端流
      let declaredLength = parseInt(c.headers['content-length'])
      if (!isNaN(declaredLength) && declaredLength > maxBodyLimit) {
        return c.status(413).to(error_413_text)
      }

      let bodyLength = 0

      // 注意这里是 async executor：new Promise 只接管 executor 的「同步」抛出，
      // async 函数的抛出会变成它自己返回的那个被 reject 的 Promise，new Promise
      // 根本不看，于是外层 await 永不 settle → 请求永久挂起（不是 503，是挂死）。
      // 之所以仍用 async，是因为内部要 await 后端流的建立；
      // 代价用整体 try/catch 兜住：任何逃逸异常都转成 reject，交给外层统一映射状态码。
      await new Promise(async (rv, rj) => {
        let resolved = false
        let rejected = false

        const failsafe = err => {
          if (resolved || rejected) return
          rejected = true
          rj(err)
        }

        try {

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
                          failsafe(err)
                          stm = null
                      })

        // 建流失败时 failsafe 已 reject，这里只做兜底（避免 catch 未触发却拿到空值）
        if (!stm) {
          failsafe(new Error('request failed'))
          return
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

          // chunked 等无 content-length 的场景：边转发边累计，超限即终止后端流
          bodyLength += chunk.length
          if (bodyLength > maxBodyLimit) {
            if (!resolved && !rejected) {
              rejected = true
              !stm.destroyed && stm.destroy()
              rj(maxBodyError)
            }
            return
          }

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

        stm.on('data', chunk => {
          // 客户端已不可写（提前断开）：继续从后端抽数据只会白白占用上游连接
          // 与流控窗口，直接终止上游流，尽早释放后端资源。
          // 终止后由 stm 的 'close' 统一 settle，不会造成挂起。
          if (!c.res || !c.res.writable) {
            !stm.destroyed && stm.destroy()
            return
          }

          // 背压：write 返回 false 时暂停上游，等 drain 后恢复，与请求方向一致。
          // 监听在此处按需注册且用 once：暂停后不再有 data 事件，
          // 因此同一时刻至多存在一个待触发的 drain 监听，用完即弃、无需手动摘除。
          // （不可改为在请求开始时注册一个常驻 once 监听：它会被第一次 drain
          //   消费掉，此后的背压将 pause 而无人 resume，上游流永久停住。）
          if (c.res.write(chunk) === false) {
            stm.pause()
            c.res.once('drain', () => stm.resume())
          }
        })

        stm.on('end', () => {
          !stm.closed && stm.close()

          if (!resolved && !rejected) {
            resolved = true
            rv()
          }
        })

        } catch (err) {
          // executor 内部逃逸的异常：转成 reject，避免外层 await 永久挂起
          failsafe(err)
        }
      })
    } catch (err) {
      self.debug && console.error(err||'request null error')
      // 按错误类型区分网关语义：超时 504 / 不可达 502 / 其他 503
      let st = mapErrorStatus(err)
      c.status(st).to(ERROR_PAGE[st])
    }

  }

}

/**
 * 预计算每个 host 的 routepath 降级映射，运行时 O(1) 查表。
 * 键只取自 pathTable（代理自己注册的 path），所以应用自有的业务路由
 * 不会出现在映射里，也就不会被代理吞掉；值只取自该 host 已声明的 path，
 * 不会凭空产生后端。降不下去就是未命中，与 nginx"没有匹配的 location"一致。
 */
Http2Proxy.prototype.buildPathFallback = function () {
  this.pathFallback = Object.create(null)

  for (const h in this.hostProxy) {
    const t = this.hostProxy[h]

    let map = null

    for (const gp in this.pathTable) {
      if (t[gp] !== undefined) continue

      for (const fp of fallbackPaths(gp)) {
        if (t[fp] === undefined) continue

        if (map === null) map = Object.create(null)
        map[gp] = fp
        break
      }
    }

    if (map !== null) this.pathFallback[h] = map
  }
}

Http2Proxy.prototype.init = function (app) {
  app.config.timeout = this.timeout

  this.buildPathFallback()

  for (let p in this.pathTable) {
    // 分组名与 proxy/proxyNoAgent 统一：应用层不需要关心上游走 http1 还是 http2
    app.router.map(this.methods, p, async c => {}, '@topbit_proxy');
  }

  app.use(this.mid(), {
    pre: true,
    group: `topbit_proxy`
  })

}

module.exports = Http2Proxy
