'use strict';

// 三个代理（Proxy / ProxyNoAgent / Http2Proxy）的请求头注入规则验证
// 通用规则：
//   1. 代理不自动注入 x-real-host / x-real-proto，默认也不写 x-real-ip（addIP 默认 false）
//   2. 客户端带来的头原样透传，不屏蔽
//   3. 后端配置里的 headers 同名时覆盖（含自动写入的 x-real-ip）
//   4. addIP 为 true 时写入客户端 IP，已有值则追加成逗号链
//
// 运行：node test/test-proxy-auto-headers.js

const Topbit = require('../src/topbit.js')
const http = require('node:http')
const http2 = require('node:http2')

const { Proxy, ProxyNoAgent, Http2Proxy } = Topbit.extensions

let pass = 0, fail = 0
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' ' + extra : ''}`)
  cond ? pass++ : fail++
}

const sleep = ms => new Promise(rv => setTimeout(rv, ms))

const pick = h => JSON.stringify({
  host: h['x-real-host'], proto: h['x-real-proto'], ip: h['x-real-ip']
})

// h1 后端 / h2c 后端：回显收到的三个头
const h1backend = http.createServer((rq, rs) => { rs.end(pick(rq.headers)) })
const h2backend = http2.createServer()
h2backend.on('stream', (stream, headers) => {
  stream.on('error', () => {})
  stream.respond({ ':status': 200 })
  stream.end(pick(headers))
})

function call(port, host, extra = {}) {
  return new Promise(resolve => {
    const r = http.request({ host: '127.0.0.1', port, path: '/', headers: { host, ...extra }, agent: false }, res => {
      let d = ''
      res.on('data', c => d += c)
      res.on('end', () => { try { resolve(JSON.parse(d)) } catch (e) { resolve({ err: d.slice(0, 60) }) } })
    })
    r.on('error', e => resolve({ err: e.message }))
    r.end()
  })
}

const FORGED = { 'x-real-host': 'evil.test', 'x-real-proto': 'https', 'x-real-ip': '9.9.9.9' }
const CFG_HEADERS = { 'x-real-host': 'cfg.example', 'x-real-proto': 'cfg-proto', 'x-real-ip': 'cfg-ip' }

let nextPort = 39960
function startApp(pxy) {
  const port = nextPort++
  const app = new Topbit({ debug: false })
  pxy.init(app)
  app.run(port, '127.0.0.1')
  return port
}

;(async () => {
  await new Promise(rv => h1backend.listen(39950, '127.0.0.1', rv))
  await new Promise(rv => h2backend.listen(39951, '127.0.0.1', rv))

  const classes = [
    ['Proxy', Proxy, 'http://127.0.0.1:39950'],
    ['ProxyNoAgent', ProxyNoAgent, 'http://127.0.0.1:39950'],
    ['Http2Proxy', Http2Proxy, 'http://127.0.0.1:39951']
  ]

  for (const [name, Cls, url] of classes) {
    const opt = { path: '/', url, aliveCheckInterval: 0 }
    const extra = name === 'Http2Proxy' ? { minConnect: 0 } : {}

    // 实例 1：addIP 默认；d.test 无配置头，c.test 配置同名头
    const p1 = startApp(new Cls({
      ...extra,
      config: {
        'd.test': [{ ...opt }],
        'c.test': [{ ...opt, headers: CFG_HEADERS }]
      }
    }))

    // 实例 2：addIP:true；i.test 无配置头，ic.test 配置了 x-real-ip
    const p2 = startApp(new Cls({
      ...extra,
      addIP: true,
      config: {
        'i.test': [{ ...opt }],
        'ic.test': [{ ...opt, headers: { 'x-real-ip': 'cfg-ip' } }]
      }
    }))

    await sleep(300)

    let r = await call(p1, 'd.test')
    check(`${name} 默认：不注入 x-real-host`, r.host === undefined, String(r.host))
    check(`${name} 默认：不注入 x-real-proto`, r.proto === undefined, String(r.proto))
    check(`${name} 默认：不写 x-real-ip`, r.ip === undefined, String(r.ip))

    r = await call(p1, 'd.test', FORGED)
    check(`${name} 客户端的 x-real-host 原样透传`, r.host === 'evil.test', String(r.host))
    check(`${name} 客户端的 x-real-proto 原样透传`, r.proto === 'https', String(r.proto))
    check(`${name} 客户端的 x-real-ip 原样透传（addIP 关闭）`, r.ip === '9.9.9.9', String(r.ip))

    r = await call(p1, 'c.test', FORGED)
    check(`${name} 配置头覆盖客户端 x-real-host`, r.host === 'cfg.example', String(r.host))
    check(`${name} 配置头覆盖客户端 x-real-proto`, r.proto === 'cfg-proto', String(r.proto))
    check(`${name} 配置头覆盖客户端 x-real-ip`, r.ip === 'cfg-ip', String(r.ip))

    r = await call(p2, 'i.test')
    check(`${name} addIP:true 写入客户端 IP`, typeof r.ip === 'string' && r.ip.includes('127.0.0.1'), String(r.ip))

    r = await call(p2, 'i.test', { 'x-real-ip': '9.9.9.9' })
    check(`${name} addIP:true 已有值则追加成逗号链`,
          typeof r.ip === 'string' && r.ip.startsWith('9.9.9.9,') && r.ip.includes('127.0.0.1'), String(r.ip))

    r = await call(p2, 'ic.test', { 'x-real-ip': '9.9.9.9' })
    check(`${name} addIP:true 时配置里的同名头仍然覆盖`, r.ip === 'cfg-ip', String(r.ip))
  }

  console.log(`\n通过 ${pass}，失败 ${fail}`)
  process.exit(fail > 0 ? 1 : 0)
})().catch(err => {
  console.error('测试异常：', err)
  process.exit(1)
})
