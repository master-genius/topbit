'use strict';

// 三个代理（Proxy / ProxyNoAgent / Http2Proxy）的请求头注入规则验证
// 通用规则：
//   1. 代理不自动注入 x-real-host / x-real-proto；客户端带来的这类头原样透传
//   2. x-real-ip 由 setRealIP 控制，默认 false：不写入，并丢弃客户端带来的同名头
//   3. setRealIP 为 true：由代理写入真实请求 IP，客户端的值不能覆盖
//   4. addIP 为 true（多级代理）：把本级 IP 追加到已有值后面；仅在 setRealIP 为 true 时生效
//   5. 后端配置 headers 里的同名头最后覆盖，对所有头一视同仁
//   6. realIPHeader 可自定义头名，大小写不敏感
//
// 运行：node test/test-proxy-auto-headers.js

const Topbit = require('../src/topbit.js')
const http = require('node:http')
const http2 = require('node:http2')

const { Proxy, ProxyNoAgent, Http2Proxy } = Topbit.extensions

// 端口固定在 28950–28951（后端）与 28960–28974（应用）：位于系统临时端口范围（32768+）之外，
// 且不与其他测试文件重叠

let pass = 0, fail = 0
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' ' + extra : ''}`)
  cond ? pass++ : fail++
}

const sleep = ms => new Promise(rv => setTimeout(rv, ms))

const pick = h => JSON.stringify({
  host: h['x-real-host'], proto: h['x-real-proto'], ip: h['x-real-ip'], cip: h['x-client-ip']
})

// h1 后端 / h2c 后端：回显收到的几个头
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

let nextPort = 28960
function startApp(pxy) {
  const port = nextPort++
  const app = new Topbit({ debug: false })
  pxy.init(app)
  app.run(port, '127.0.0.1')
  return port
}

// 捕获构造期间的 console.error
function withCapturedErrors(fn) {
  const msgs = []
  const orig = console.error
  console.error = (...a) => { msgs.push(a.join(' ')) }
  try { return [fn(), msgs] } finally { console.error = orig }
}

;(async () => {
  await new Promise(rv => h1backend.listen(28950, '127.0.0.1', rv))
  await new Promise(rv => h2backend.listen(28951, '127.0.0.1', rv))

  const classes = [
    ['Proxy', Proxy, 'http://127.0.0.1:28950'],
    ['ProxyNoAgent', ProxyNoAgent, 'http://127.0.0.1:28950'],
    ['Http2Proxy', Http2Proxy, 'http://127.0.0.1:28951']
  ]

  for (const [name, Cls, url] of classes) {
    const opt = { path: '/', url, aliveCheckInterval: 0 }
    const extra = name === 'Http2Proxy' ? { minConnect: 0 } : {}

    // 默认：d.test 无配置头，c.test 配置同名头
    const pDef = startApp(new Cls({
      ...extra,
      config: { 'd.test': [{ ...opt }], 'c.test': [{ ...opt, headers: CFG_HEADERS }] }
    }))

    // setRealIP:true：i.test 无配置头，ic.test 配置了 x-real-ip
    const pSet = startApp(new Cls({
      ...extra,
      setRealIP: true,
      config: { 'i.test': [{ ...opt }], 'ic.test': [{ ...opt, headers: { 'x-real-ip': 'cfg-ip' } }] }
    }))

    // setRealIP + addIP：多级代理
    const pChain = startApp(new Cls({
      ...extra,
      setRealIP: true,
      addIP: true,
      config: { 'a.test': [{ ...opt }] }
    }))

    // 仅 addIP：不应生效，并给出提示
    const [pxyOnlyAdd, warns] = withCapturedErrors(() => new Cls({
      ...extra,
      addIP: true,
      config: { 'w.test': [{ ...opt }] }
    }))
    const pOnlyAdd = startApp(pxyOnlyAdd)

    // 自定义头名（混合大小写）
    const pName = startApp(new Cls({
      ...extra,
      setRealIP: true,
      realIPHeader: 'X-Client-Ip',
      config: { 'n.test': [{ ...opt }] }
    }))

    await sleep(300)

    // ---- 默认 ----
    let r = await call(pDef, 'd.test')
    check(`${name} 默认：不注入 x-real-host`, r.host === undefined, String(r.host))
    check(`${name} 默认：不注入 x-real-proto`, r.proto === undefined, String(r.proto))
    check(`${name} 默认：不写 x-real-ip`, r.ip === undefined, String(r.ip))

    r = await call(pDef, 'd.test', FORGED)
    check(`${name} 默认：客户端的 x-real-host 原样透传`, r.host === 'evil.test', String(r.host))
    check(`${name} 默认：客户端的 x-real-proto 原样透传`, r.proto === 'https', String(r.proto))
    check(`${name} 默认：客户端的 x-real-ip 被丢弃，不传给后端`, r.ip === undefined, String(r.ip))

    r = await call(pDef, 'c.test', FORGED)
    check(`${name} 配置头覆盖 x-real-host`, r.host === 'cfg.example', String(r.host))
    check(`${name} 配置头覆盖 x-real-proto`, r.proto === 'cfg-proto', String(r.proto))
    check(`${name} 配置头设置 x-real-ip（客户端值已被丢弃）`, r.ip === 'cfg-ip', String(r.ip))

    // ---- setRealIP:true ----
    r = await call(pSet, 'i.test')
    check(`${name} setRealIP:true 写入真实请求 IP`,
          typeof r.ip === 'string' && r.ip.includes('127.0.0.1'), String(r.ip))

    r = await call(pSet, 'i.test', { 'x-real-ip': '9.9.9.9' })
    check(`${name} setRealIP:true 客户端的值不能覆盖`,
          typeof r.ip === 'string' && r.ip.includes('127.0.0.1') && !r.ip.includes('9.9.9.9'), String(r.ip))

    r = await call(pSet, 'ic.test', { 'x-real-ip': '9.9.9.9' })
    check(`${name} setRealIP:true 时配置里的同名头最后覆盖`, r.ip === 'cfg-ip', String(r.ip))

    // ---- setRealIP + addIP ----
    r = await call(pChain, 'a.test')
    check(`${name} addIP：没有已有值时只写本级 IP`,
          typeof r.ip === 'string' && r.ip.includes('127.0.0.1') && !r.ip.includes(','), String(r.ip))

    r = await call(pChain, 'a.test', { 'x-real-ip': '9.9.9.9' })
    check(`${name} addIP：已有值则追加成逗号链`,
          typeof r.ip === 'string' && r.ip.startsWith('9.9.9.9,') && r.ip.includes('127.0.0.1'), String(r.ip))

    // ---- 仅 addIP ----
    check(`${name} 仅 addIP 时给出提示`, warns.some(m => m.includes('addIP 仅在 setRealIP 为 true 时生效')),
          warns.join('|').slice(0, 80))
    r = await call(pOnlyAdd, 'w.test', { 'x-real-ip': '9.9.9.9' })
    check(`${name} 仅 addIP 不写入，客户端的值同样被丢弃`, r.ip === undefined, String(r.ip))

    // ---- 自定义头名 ----
    r = await call(pName, 'n.test', { 'x-client-ip': 'forged', 'x-real-ip': '9.9.9.9' })
    check(`${name} 自定义 realIPHeader（大小写不敏感）写入真实 IP`,
          typeof r.cip === 'string' && r.cip.includes('127.0.0.1') && !r.cip.includes('forged'), String(r.cip))
    check(`${name} 自定义头名后，x-real-ip 不再受管，原样透传`, r.ip === '9.9.9.9', String(r.ip))
  }

  console.log(`\n通过 ${pass}，失败 ${fail}`)
  process.exit(fail > 0 ? 1 : 0)
})().catch(err => {
  process.stderr.write(`测试异常：${err && err.stack}\n`)
  process.exit(1)
})
