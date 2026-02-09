'use strict'

const ext = require('./ext.js')
const moveFile = require('./movefile.js')

class Context {

  constructor () {

    this.version = '1.1'

    //主版本号
    this.major = 1

    this.maxBody = 0

    this.method    = ''

    this.host = ''

    this.protocol = ''

    this.ip      = ''

    //实际的访问路径
    this.path    = ''

    this.name    = ''

    this.headers   = {}

    //实际执行请求的路径
    this.routepath   = ''

    this.param     = {}

    this.query     = {}

    this.body    = {}

    this.isUpload  = false

    this.group     = ''

    this.rawBody   = ''

    this.bodyLength = 0

    this.files     = {}

    this.requestCall = null

    this.ext     = ext

    this.port    = 0

    this.data = ''
    this.dataEncoding = 'utf8'

    this.req   = null
    this.res  = null

    this.box = {}

    this.service = null

    this.user    = null
  }

  json(data) {
    return this.setHeader('content-type', 'application/json').to(data)
  }

  text(data, encoding='utf-8') {
    return this.setHeader('content-type', `text/plain;charset=${encoding}`).to(data)
  }

  html(data, encoding='utf-8') {
    return this.setHeader('content-type', `text/html;charset=${encoding}`).to(data)
  }

  to(d) {
    this.data = d
  }

  getFile(name, ind = 0) {
    if (ind < 0) {
      return this.files[name] || []
    }

    if (this.files[name] === undefined) {
      return null
    }
    
    if (ind >= this.files[name].length) {
      return null
    }

    return this.files[name][ind]
  }

  setHeader(name, val) {
    this.res.setHeader(name, val)
    return this
  }

  sendHeader() {
    !this.res
      && !this.res.headersSent
      && this.res.writeHead(this.res.statusCode)

    return this
  }

  status(stcode = null) {
    if (stcode === null) {
      return this.res.statusCode
    }

    if (this.res) {
      this.res.statusCode = stcode
    }

    return this
  }

  moveFile(upf, target) {
    return moveFile(this, upf, target)
  }
  
  /**
   * @param {(fs.ReadStream|string)} filename
   * @param {object} options
   * */
  pipe(filename, options={}) {
    return ext.pipe(filename, this.res, options)
  }

  pipeJson(filename) {
    return this.setHeader('content-type', 'application/json').pipe(filename)
  }

  pipeText(filename, encoding='utf-8') {
    return this.setHeader('content-type', `text/plain;charset=${encoding}`).pipe(filename)
  }

  pipeHtml(filename, encoding='utf-8') {
    return this.setHeader('content-type', `text/html;charset=${encoding}`).pipe(filename)
  }

  removeHeader(name) {
    this.res.removeHeader(name)
    return this
  }

  write(data) {
    this.res.write(data)
    return this
  }

}

Object.defineProperties(Context.prototype, {
  oo: {
    enumerable: false,
    writable: true,
    configurable: true,
    value: Context.prototype.to
  },

  ok: {
    enumerable: false,
    writable: true,
    configurable: true,
    value: Context.prototype.to
  }
})

module.exports = Context
