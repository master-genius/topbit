#!/usr/bin/env node

'use strict'

let simple_mode = false

let type_context = `
/**
 * ----------------------------- 请求上下文 -----------------------------------
 *
 * @typedef {object} context
 * @property {string} version - 协议版本，字符串类型，为'1.1' 或 '2' 或 '3'。
 * @property {number} major - 协议主要版本号，1、2、3分别表示HTTP/1.1 HTTP/2 HTTP/3。
 * @property {string} method - 请求类型，GET POST等HTTP请求类型，大写字母的字符串。
 * @property {string} path - 具体请求的路径，比如 /x/y。
 * @property {string} routepath - 实际执行请求的路由字符串。
 * @property {object} box - 默认为空对象，可以添加任何属性值，用来动态传递给下一层组件需要使用的信息。
 * @property {object} query - url传递的参数。
 * @property {object} param - 路由参数。
 * @property {object} headers - 指向req.headers。
 * @property {(object|string|buffer)} body - body请求体的数据，具体格式需要看content-type，一般为字符串或者对象，也可能是buffer。
 * @property {object} req HTTP/1.1 - 就是http模块request事件的参数IncomingMessage对象，HTTP/2 指向stream对象。
 * @property {object} res - HTTP/1.1协议，指向response，HTTP/2 指向stream。
 * @property {object} service - 用于依赖注入的对象，指向app.service。
 * @property {function} moveFile(file: object) - 用来移动上传的文件到指定路径。
 * @property {function} getFile() - 根据上传名获取上传的文件。
 * @property {function} setHeader(key: string, value: string|array)
 * @property {function} to(body: string|object|buffer) - 设置要返回的body数据。
 * @property {function} status(code: null | number) - 设置状态码，默认为null表示返回状态码。
 */
`

let head_hint = ''

function fmt_ctx_param(text) {
  let ctx_param = `
  /**
   * ${text}
   * @param {context} ctx
   * @returns 
   */
`
  return ctx_param
}

const fs = require('fs')

function makeController(name) {
  let modname = name
  if (!(/^[A-Z].*/).test(name)) {
    modname = name.substring(0, 1).toUpperCase() + name.substring(1)
  }

  return `'use strict'\n\n`
        + (simple_mode ? '' : head_hint)
        + `class ${modname} {\n\n`
        + `  constructor() {\n`
        + `    //若要改变路由，则设置此属性，比如设置为/:name\n`
        + `    //this.param = '/:id'\n`
        + `  }\n\n`
        + `  //加载器初始化后会执行此函数。service默认是app.service。\n`
        + `  async init(service) {\n`
        + `    \n`
        + `  }\n\n`
        + (simple_mode ? '' : `  // 根据实际需要增加或删除请求方法。\n`)
        + `${fmt_ctx_param('获取资源具体内容')}`
        + `  async get(ctx) {\n\n`
        + `  }\n`
        + `${fmt_ctx_param('创建资源')}`
        + `  async post(ctx) {\n\n`
        + `  }\n`
        + `${fmt_ctx_param('更新资源')}`
        + `  async put(ctx) {\n\n`
        + `  }\n`
        + `${fmt_ctx_param('GET请求，用于获取资源列表')}`
        + `  async list(ctx) {\n\n`
        + `  }\n`
        + `${fmt_ctx_param('删除资源')}`
        + `  async _delete(ctx) {\n\n`
        + `  }\n\n`
        + `}\n\nmodule.exports = ${modname}\n`
        + (simple_mode ? '' : `${type_context}`)

}

let limitName = [
  'async', 'await', 'for', 'of', 'if', 'else', 'switch', 'function', 'delete', 'new', 'case', 
  'require', 'import', 'export', 'exports', 'process', 'global', 'this', 'let', 'const', 'var',
  'class', 'return', 'module', 'do', 'while', 'catch', 'try', 'break', 'boolean', 'instanceof',
  'typeof', 'continue', 'fetch', 'globalThis', 'queueMicrotask'
]

let name_preg = /^[A-Za-z_][A-Za-z0-9_\-]{0,50}$/i

function checkName (name) {
  return name_preg.test(name)
}

function parseNameDir (name) {
  let ind = name.indexOf('/')
  let hasJS = (name.length > 3 && name.substring(name.length-3) === '.js')

  if (ind > 0) {
    let narr = name.split('/')
    let real_name = narr[narr.length-1]
    return {
      dir: `/${narr[narr.length-2]}`,
      name: hasJS ? real_name.substring(0, real_name.length-3) : real_name
    }
  }

  return {
    dir : '',
    name: hasJS ? name.substring(0, name.length-3) : name
  }
}

function filterName (name) {
  return (limitName.indexOf(name) >= 0 ? `_${name}` : name)
}

let cdir = 'controller'

let clist = []

//let model_name = ''

for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].indexOf('--cdir=') === 0) {

    let t = process.argv[i].substring('--cdir='.length)

    if (t.length > 0) {
      cdir = t
    }

    continue
  }

  if (process.argv[i] === '-s' || process.argv[i] === '--pure' || process.argv[i] === '--simple')
  {
    simple_mode = true
    continue
  }

  /* if (process.argv.indexOf('--model=') === 0) {
    let mname = process.argv[i].substring('--model='.length)
    if (mname.length > 0 && (/^[a-z0-9_][a-z\-_0-9]{0,100}$/i).test(mname)) {
      model_name = mname
    }

    continue
  } */

  clist.push(process.argv[i])
}

try {
  fs.accessSync(cdir) 
} catch (err) {
  fs.mkdirSync(cdir)
}

let nd 
let cpath

for (let c of clist) {
  nd = parseNameDir(c)

  if (!checkName(nd.name)) {
    console.error(`${nd.name} 不符合命名要求，要求字母数字，字母开头，支持连字符和下划线(- 和 _)。(the name is illegal.)`)
    continue
  }

  let modname = nd.name.replace(/\-+/ig, '')

  if (nd.dir) {
    try {
      fs.accessSync(`${cdir}${nd.dir}`)
    } catch (err) {
      fs.mkdirSync(`${cdir}${nd.dir}`)
    }
  }

  cpath = `${cdir}${nd.dir}/${nd.name}.js`

  try {
    fs.accessSync(cpath)
    console.error(`${c} 已经存在。`)
    continue
  } catch (err) {}

  try {
    fs.writeFileSync(cpath, makeController(filterName(modname)), {encoding: 'utf8'})
  } catch (err) {
    console.error(err)
  }

}
