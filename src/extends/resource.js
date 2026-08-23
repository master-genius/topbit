'use strict';

//const fs = require('fs');

const zlib = require('node:zlib')
const fs = require('node:fs')
const crypto = require('node:crypto')

const fsp = fs.promises

let _typemap = {
  '.css'  : 'text/css; charset=utf-8',
  '.js'   : 'text/javascript; charset=utf-8',
  '.wasm' : 'application/wasm',
  '.txt'  : 'text/plain; charset=utf-8',
  '.json' : 'application/json; charset=utf-8',
  '.lrc'  : 'text/plain; charset=utf-8',
  '.md'   : 'text/plain; charset=utf-8',
  '.html' : 'text/html; charset=utf-8',
  '.xml'  : 'text/xml; charset=utf-8',

  '.svg'  : 'image/svg+xml',
  '.jpg'  : 'image/jpeg',
  '.jpeg' : 'image/jpeg',
  '.png'  : 'image/png',
  '.gif'  : 'image/gif',
  '.ico'  : 'image/x-icon',
  '.webp' : 'image/webp',
  '.tif'  : 'image/tiff',
  '.tiff' : 'image/tiff',
  '.avif' : 'image/avif',
  '.apng' : 'image/apng',

  '.mp3'  : 'audio/mpeg',
  '.flac' : 'audio/flac',
  '.wav'  : 'audio/x-wav',
  '.mp4'  : 'video/mp4',
  '.webm' : 'video/webm',

  '.otf'  : 'font/otf',
  '.ttf'  : 'font/ttf',
  '.wtf'  : 'font/wtf',
  '.woff' : 'font/woff',
  '.ttc'  : 'font/ttc',
  '.woff2' : 'font/woff2',

  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}


/**
 * 判断客户端是否接受 gzip 编码。
 *
 * 只看 accept-encoding 里有没有出现 gzip，不解析 q 值、不做 token 边界判定。
 * 这是刻意的简化：不想接收压缩内容的客户端，本就应当不在头里声明支持 gzip；
 * 用 q=0 表达"我认得但别发给我"是极少见的写法，为它引入一套字符级解析器
 * 不划算。
 *
 * 头缺失与头为空是两种不同情形（RFC 9110 §12.5.3）：
 *   - 缺失：未表达偏好，任意编码皆可接受，压缩；
 *   - 存在但为空串：明确表示不要任何内容编码，不压缩。
 *
 * @param {string|undefined} ae accept-encoding 头
 * @returns {boolean}
 */
function acceptGzip(ae) {
  //头缺失：未表达偏好，视为接受
  if (ae === undefined || ae === null) return true

  //头存在但为空：明确表示不要任何内容编码
  if (typeof ae !== 'string' || ae.length === 0) return false

  return ae.indexOf('gzip') >= 0
}

/**
 * 处理静态资源的请求，需要把中间件挂载到一个分组下，否则会影响全局，如果一个只做静态分发的服务则可以全局启用。
 */

class Resource {

  constructor(options = {}) {

    this.cache = new Map()

    this.staticPath = ''

    //最大缓存，单位为字节，0表示不限制。
    this.maxCacheSize = 128_000_000

    this.size = 0

    //控制释放缓存的概率，1到100
    this.prob = 6

    //失败缓存统计，当失败缓存计数达到一个阈值，则会清空缓存。
    this.cacheFailed = 0

    this.failedLimit = 50

    // 缓存条目 stat 校验周期（毫秒）：周期内不重复 stat，最多滞后 checkInterval 检测到文件变更
    this.checkInterval = 600000

    this.cacheControl = null

    this.routePath = '/static/*'

    this.prepath = ''
    
    this.routeGroup = `__static_${Math.floor(Math.random() * 10000)}_`

    this.decodePath = false

    this.maxFileSize = 10_000_000

    if (typeof options !== 'object') {
      options = {}
    }

    for (let k in options) {
      switch(k) {
        case 'staticPath':
          this.staticPath = options[k]
          break

        case 'maxCacheSize':
        case 'maxFileSize':
          if (typeof options[k] === 'number') {
            this[k] = options[k]
          }
          break

        case 'failedLimit':
          if (options[k] > 0) {
            this.failedLimit = options[k]
          }
          break

        case 'checkInterval':
          if (typeof options[k] === 'number' && options[k] >= 0) {
            this.checkInterval = options[k]
          }
          break

        case 'cacheControl':
          this.cacheControl = options[k]
          break
        
        case 'routePath':
          if (typeof options[k] === 'string') {
            this.routePath = options[k]
          }
          break

        case 'routeGroup':
          if (typeof options[k] === 'string') {
            this.routeGroup = options[k]
          }
          break
        
        case 'decodePath':
          this.decodePath = options[k]
          break

        case 'prepath':
          this.prepath = options[k]

          if (this.prepath.length > 0 && this.prepath[0] !== '/') {
            this.prepath = `/${this.prepath}`
          }
          break

        case 'prob':
          if (typeof options[k] === 'number' && options[k] >= 1 && options[k] <= 100) {
            this.prob = options[k]
          }
          break

      }
    }

    if (this.maxCacheSize < 10_000_000) {
      this.maxCacheSize = 10_000_000
    }

    // 有效范围 10000 ~ 500_000_000；越界值会被重置为默认 10MB（注意：是重置，不是钳制到边界值）
    if (this.maxFileSize < 10000 || this.maxFileSize > 500_000_000) {
      this.maxFileSize = 10_000_000
    }

    if (this.staticPath.length > 1 && this.staticPath[ this.staticPath.length-1 ] === '/') {
      this.staticPath = this.staticPath.substring(0, this.staticPath.length-1)
    }

    // 拷贝模块级 MIME 表，避免多个实例通过 addType / 大写化写入相互污染
    this.ctypeMap = { ..._typemap }

    // 数据源固定为原始表：若遍历 this.ctypeMap，循环中新增的大写 key 会被再次访问并覆盖为 undefined
    for (let k in _typemap) {
      this.ctypeMap[k.toUpperCase()] = _typemap[k]
    }

  }

  addType(tobj) {
    let lower_name, up_name;

    for (let k in tobj) {
      lower_name = k.toLowerCase()

      up_name = k.toUpperCase()

      this.ctypeMap[lower_name] = tobj[k]

      this.ctypeMap[up_name] = tobj[k]
    }
  }

  extName(filename) {
    // 扩展名的点必须出现在最后一个路径分隔符之后，避免目录名中的点被误判为扩展名
    let namestart = filename.lastIndexOf('/')
    let extind = filename.lastIndexOf('.')

    if (extind <= namestart) {
      return ''
    }

    return filename.substring(extind)
  }

  filetype(extname) {
    if (this.ctypeMap[extname] !== undefined) {
      return this.ctypeMap[extname]
    }

    return 'application/octet-stream'
  }

  removeGroupCache(filepre) {
    let keys = this.cache.keys()
    for (let k of keys) {
      if (k.indexOf(filepre) === 0) this.cache.delete(k)
    }
  }

  removeNameCache(name) {
    //收集后再删：删除时要同步扣减 this.size，走 removeCache 统一记账
    let hit = []
    for (let k of this.cache.keys()) {
      if (k.lastIndexOf(name) >= 0) hit.push(k)
    }

    for (let k of hit) this.removeCache(k)
  }

  removeCache(filepath) {
    let r = this.cache.get(filepath)
    if (r === undefined) return

    this.size -= r.data.length + (r.zdata ? r.zdata.length : 0)
    if (this.size < 0) this.size = 0

    this.cache.delete(filepath)
  }

  clearCache() {
    this.size = 0
    this.cacheFailed = 0
    this.cache.clear()
  }

  /**
   * 当前是否还能接纳新的缓存条目。
   *
   * 必须在读取文件**之前**问一次：二进制分支为了填缓存会把整个文件累积到
   * 内存再 Buffer.concat，缓存满时那份数据读完即弃，白白分配两倍文件大小，
   * 且每个请求都来一遍。
   */
  canCache() {
    if (this.cacheFailed >= this.failedLimit) return false

    if (this.maxCacheSize > 0 && this.size >= this.maxCacheSize) return false

    return true
  }

  /**
   * 缓存未能接纳新条目时的记账。
   *
   * 失败计数达到阈值后，以 prob% 的概率整体清空——这是刻意的：缓存键来自
   * 外部可控的请求路径，用 LRU 反而容易被构造大量冷门路径挤掉热点，
   * 概率性全清让攻击者无法预测何时生效。
   */
  noteCacheFull() {
    if (this.cacheFailed >= this.failedLimit) {
      if (((Math.random() * 100) | 0) < this.prob) {
        this.clearCache()
        this.cacheFailed = 0
      } else {
        this.cacheFailed--
      }
    } else if (this.maxCacheSize > 0 && this.size >= this.maxCacheSize) {
      if (this.cacheFailed < 1000_0000) this.cacheFailed++
    }
  }

  /**
   * 表示（representation）各自的 ETag。
   *
   * 原文与 gzip 版本是同一资源的两种表示，字节不同，必须给不同的 ETag，
   * 否则中间缓存会用一种表示去应答另一种表示的条件请求。
   */
  etagOf(size, hash, gzip) {
    return gzip ? `"${size}-${hash}-gz"` : `"${size}-${hash}"`
  }

  /**
   * If-None-Match 匹配。RFC 9110：支持 * 与逗号分隔的多值。
   */
  etagMatch(inm, etag) {
    if (!inm) return false
    if (inm === '*') return true

    return inm.split(',').map(v => v.trim()).includes(etag)
  }

  /**
   * 写入一条缓存。原文与 gzip 版本同时保留：两种表示都可能被请求，
   * 只存压缩版会导致不接受 gzip 的客户端拿不到可用内容。
   */
  setCache(key, entry) {
    this.cache.set(key, entry)
    this.size += entry.data.length + (entry.zdata ? entry.zdata.length : 0)
  }

  async pipeData(pathfile, ctx, filesize) {
    let stm = fs.createReadStream(pathfile)
    let dataBuffer = []
    let total = 0

    if (ctx.major === 2) {
      ctx.sendHeader()
    }

    return new Promise((rv, rj) => {
      stm.on('data', data => {
        total += data.length
        dataBuffer.push(data)
      })

      stm.on('error', err => {
        dataBuffer = null
        !stm.destroyed && stm.destroy()
        rj(err)
      })

      stm.on('end', () => {
        if (dataBuffer && dataBuffer.length > 0) {
          let retData = Buffer.concat(dataBuffer, total)
          dataBuffer = null
          rv(retData)
        } else {
          rv(null)
        }
      })

      stm.pipe(ctx.res)
    })

  }

  mid() {
    let self = this

    return async (c, next) => {
      let rpath = c.param.starPath || c.path

      if (rpath[0] !== '/') {
        rpath = `/${rpath}`
      }

      let real_path = rpath

      if (self.decodePath) {
        try {
          real_path = decodeURIComponent(rpath)
        } catch (err) {
          real_path = rpath
        }
      }

      if (real_path.indexOf('/../') >= 0 || real_path.indexOf('\\..\\') >= 0) {
        return c.status(404).to('file not found')
      }

      let pathfile = `${self.staticPath}${self.prepath}${real_path}`
  
      if (self.cache.has(real_path)) {
        let r = self.cache.get(real_path)

        // 周期内不重复 stat；超周期校验文件是否变更（size + mtime）
        if (Date.now() - r.checkTime > self.checkInterval) {
          let fst = await fsp.stat(pathfile).catch(() => null)
          if (!fst || fst.size !== r.size || fst.mtimeMs !== r.mtime) {
            // 文件被删或变更 → 失效，删条目走下方新鲜读取
            self.cache.delete(real_path)
            self.size -= r.data.length + (r.zdata ? r.zdata.length : 0)
          } else {
            r.checkTime = Date.now()
          }
        }

        if (self.cache.has(real_path)) {
          //有压缩版本时才按 accept-encoding 二选一，否则只有原文一种表示
          let useZip = r.zdata !== null && acceptGzip(c.headers['accept-encoding'])
          let body = useZip ? r.zdata : r.data
          let etag = self.etagOf(r.size, r.hash, useZip)

          if (r.zdata !== null) {
            //响应内容随 accept-encoding 变化，共享缓存必须按该头分别存储，
            //否则会把 gzip 版本发给不接受 gzip 的客户端
            c.setHeader('vary', 'accept-encoding')
          }

          if (self.cacheControl) {
            c.setHeader('cache-control', self.cacheControl)
          }

          // RFC 9110：If-None-Match 支持 * 与逗号分隔的多值
          if (self.etagMatch(c.headers['if-none-match'], etag)) {
            c.setHeader('etag', etag)
            return c.status(304).to('')
          }

          c.setHeader('content-type', r.type)
          c.setHeader('content-length', body.length)
          c.setHeader('etag', etag)

          if (useZip) {
            c.setHeader('content-encoding', 'gzip')
          }

          return c.to(body)
        }
      }

      let data = null

      let extname = this.extName(pathfile)

      let ctype = self.filetype(extname)

      let zipdata = null

      // 内容摘要（sha1 小写 hex）：文本分支发送前计算并带 ETag；二进制分支响应已流式发出，缓存命中后带
      let hash = null

      try {
        let fst = await fsp.stat(pathfile)

        // 超限文件统一走流式，不缓存不压缩（无论文本/二进制）
        if (fst.size > self.maxFileSize) {
          self.cacheControl && c.setHeader('cache-control', self.cacheControl)
          c.setHeader('content-type', ctype)
            .setHeader('content-length', fst.size)
            .sendHeader()

          return await c.pipe(pathfile)
        } else if (ctype.indexOf('text/') === 0
            || extname === '.json'
            || ctype.indexOf('font/') === 0)
        {
          data = await fsp.readFile(pathfile)

          // 内容摘要：基于原文计算，发送前带上 ETag（数据在手，顺带计算）
          hash = crypto.createHash('sha1').update(data).digest('hex')

          let wantZip = acceptGzip(c.headers['accept-encoding'])

          /**
           * 压缩时机：只要文件够大就压。
           *
           * 即使本次请求不接受 gzip，压缩结果也会随缓存一起留下，供后续接受
           * gzip 的请求直接取用——压缩成本摊到往后所有命中上。仅当这条记录
           * 根本进不了缓存时，不接受 gzip 的请求才跳过压缩，避免纯浪费。
           *
           * 小于 1K 的文件压完往往比原文还大，不压。
           */
          let cacheable = self.canCache()

          if (fst.size > 1024 && (wantZip || cacheable)) {
            zipdata = await new Promise((rv, rj) => {
                zlib.gzip(data, (err, d) => {
                  if (err) {
                    rj(err)
                  } else {
                    rv(d)
                  }
                })
            }).catch(err => {
              zipdata = null
            })

            //压完反而更大就丢掉，没有保留价值
            if (zipdata && zipdata.length >= data.length) zipdata = null
          }

          let useZip = zipdata !== null && wantZip
          let body = useZip ? zipdata : data
          let etag = self.etagOf(fst.size, hash, useZip)

          if (zipdata !== null) {
            c.setHeader('vary', 'accept-encoding')
          }

          self.cacheControl && c.setHeader('cache-control', self.cacheControl);

          // 缓存未命中但客户端带 If-None-Match：内容未变则 304，避免重发全量
          if (self.etagMatch(c.headers['if-none-match'], etag)) {
            c.setHeader('etag', etag)
            return c.status(304).to('')
          }

          c.setHeader('content-type', ctype)
            .setHeader('content-length', body.length)
            .setHeader('etag', etag)

          if (useZip) {
            c.setHeader('content-encoding', 'gzip')
          }

          c.sendHeader().to(body)
        } else {
          c.setHeader('content-type', ctype).setHeader('content-length', fst.size);

          self.cacheControl && c.setHeader('cache-control', self.cacheControl);

          /**
           * 缓存进不去时纯流式发送，不累积。
           *
           * pipeData() 一边 pipe 一边把全部 chunk 收进数组再 Buffer.concat，
           * 那份数据唯一的用途就是填缓存；缓存满时它读完即弃，等于每个请求
           * 都白白分配两倍文件大小。判断必须前置到这里。
           */
          if (!self.canCache()) {
            self.noteCacheFull()
            c.sendHeader()

            return await c.pipe(pathfile)
          }

          // 头部已随流发出，读取失败时无法再回退 404，只能直接终止响应
          data = await this.pipeData(pathfile, c, fst.size).catch(() => {
            c.res && c.res.writable && !c.res.writableEnded && c.res.end()
            return null
          })
          //说明数据太大，放弃了缓存
          if (!data) return
        }

        if (!self.canCache()) {
          self.noteCacheFull()
        } else {
          // 内容摘要：文本分支已提前计算；二进制分支（响应已流式发出）在此补算
          if (hash === null) {
            hash = crypto.createHash('sha1').update(data).digest('hex')
          }

          self.setCache(real_path, {
            data : data,            // 始终是原文
            zdata : zipdata,        // gzip 版本，没有则为 null
            type : ctype,
            size : fst.size,        // 本地变更检测：大小
            mtime : fst.mtimeMs,    // 本地变更检测：修改时间
            hash : hash,            // 前端 ETag：内容摘要
            checkTime : Date.now(), // 最近 stat 校验时间
          })
        }
      } catch (err) {
        c.status(404).to('read file failed')
      }

    }

  }

  init(app, group = null) {
    app.get(this.routePath, async c => {}, {group: group || this.routeGroup})
    app.use(this.mid(), {group : group || this.routeGroup})
  }

}

module.exports = Resource
