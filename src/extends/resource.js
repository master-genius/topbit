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

    if (this.maxFileSize < 10000 || this.maxFileSize > 500_000_000) {
      this.maxFileSize = 10_000_000
    }

    if (this.staticPath.length > 1 && this.staticPath[ this.staticPath.length-1 ] === '/') {
      this.staticPath = this.staticPath.substring(0, this.staticPath.length-1)
    }

    this.ctypeMap = _typemap

    for (let k in this.ctypeMap) {
      this.ctypeMap[ k.toUpperCase() ] = _typemap[k]
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
    let extind = filename.length - 1
    let extstart = filename.length - 6

    while (extind > 0 && extind >= extstart) {
      if (filename[extind] === '.') break

      extind -= 1
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
    let keys = this.cache.keys()
    for (let k of keys) {
      if (k.lastIndexOf(name) >= 0) this.cache.delete(k)
    }
  }

  removeCache(filepath) {
    if (this.cache.has(filepath)) {
      this.cache.delete(filepath)
    }
  }

  clearCache() {
    this.size = 0
    this.cacheFailed = 0
    this.cache.clear()
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
            self.size -= r.data.length
          } else {
            r.checkTime = Date.now()
          }
        }

        if (self.cache.has(real_path)) {
          let etag = `"${r.size}-${r.hash}"`
          let inm = c.headers['if-none-match']

          // RFC 9110：If-None-Match 支持 * 与逗号分隔的多值
          if (inm && (inm === '*' || inm.split(',').map(s => s.trim()).includes(etag))) {
            c.setHeader('etag', etag)
            if (self.cacheControl) {
              c.setHeader('cache-control', self.cacheControl)
            }
            return c.status(304).to('')
          }

          c.setHeader('content-type', r.type)
          c.setHeader('content-length', r.data.length)
          c.setHeader('etag', etag)

          if (r.gzip) {
            c.setHeader('content-encoding', 'gzip')
          }

          if (self.cacheControl) {
            c.setHeader('cache-control', self.cacheControl)
          }

          return c.to(r.data)
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

          // 缓存未命中但客户端带 If-None-Match：内容未变则 304，避免重发全量
          let etag = `"${fst.size}-${hash}"`
          let inm = c.headers['if-none-match']
          if (inm && (inm === '*' || inm.split(',').map(s => s.trim()).includes(etag))) {
            c.setHeader('etag', etag)
            if (self.cacheControl) {
              c.setHeader('cache-control', self.cacheControl)
            }
            return c.status(304).to('')
          }

          //若文件很小，压缩后的数据很可能要比源文件还大，所以对超过1k的文件进行压缩，否则不进行压缩。
          if (fst.size > 1024) {
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
          }

          c.setHeader('content-type', ctype)
            .setHeader('content-length', zipdata ? zipdata.length : data.length)
            .setHeader('etag', etag)

          if (zipdata) {
            c.setHeader('content-encoding', 'gzip')
          }

          self.cacheControl && c.setHeader('cache-control', self.cacheControl);

          c.sendHeader().to(zipdata || data)
        } else {
          c.setHeader('content-type', ctype).setHeader('content-length', fst.size);

          self.cacheControl && c.setHeader('cache-control', self.cacheControl);

          data = await this.pipeData(pathfile, c, fst.size)
          //说明数据太大，放弃了缓存
          if (!data) return
        }

        if (self.cacheFailed >= self.failedLimit) {
          //以{self.prob}%概率决定是否释放缓存。
          if (((Math.random() * 100) | 0) < self.prob) {
            self.clearCache()
            self.cacheFailed = 0
          } else {
            self.cacheFailed--
          }
        } else if (self.maxCacheSize > 0 && self.size >= self.maxCacheSize) {

          if (self.cacheFailed < 1000_0000)
            self.cacheFailed++

        } else {
          // 内容摘要：文本分支已提前计算；二进制分支（响应已流式发出）在此补算
          if (hash === null) {
            hash = crypto.createHash('sha1').update(data).digest('hex')
          }

          self.cache.set(real_path, {
            data : zipdata || data,
            type : ctype,
            gzip : zipdata ? true : false,
            size : fst.size,        // 本地变更检测：大小
            mtime : fst.mtimeMs,    // 本地变更检测：修改时间
            hash : hash,            // 前端 ETag：内容摘要
            checkTime : Date.now(), // 最近 stat 校验时间
          })

          self.size += zipdata ? zipdata.length : data.length
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
