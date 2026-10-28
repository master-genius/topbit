'use strict';

// Http2Proxy queueTimeout 选项验证
// 覆盖：
//   1. 配置传递：默认 3000；实例级继承；后端级覆盖；非法值报错并继承
//   2. 功能：冷启动握手慢于 3s 时，默认配置下并发排队请求会超时 503；
//      实例级或后端级调大 queueTimeout 后全部成功
//
// 运行：node test/test-http2proxy-queuetimeout.js

const Topbit = require('../src/topbit.js')
const http = require('node:http')
const http2 = require('node:http2')
const net = require('node:net')

const { Http2Proxy } = Topbit.extensions

let pass = 0, fail = 0
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' ' + extra : ''}`)
  cond ? pass++ : fail++
}

const sleep = ms => new Promise(rv => setTimeout(rv, ms))

function captureErrors() {
  const msgs = []
  const orig = console.error
  console.error = (...a) => { msgs.push(a.join(' ')) }
  return { msgs, restore: () => { console.error = orig } }
}

// minConnect:0 避免构造期向不存在的后端发起连接；读取各后端 Pool 上实际生效的 queueTimeout
function poolTimeouts(pxy, host) {
  // path '/' 在内部被归一为 '/*'，这里不写死 key，取该 host 下唯一的 path
  const t = pxy.hostProxy[host]
  return t[Object.keys(t)[0]].map(b => b.h2Pool.queueTimeout)
}

// h2c 后端 + 前置一层延迟转发，使对端 SETTINGS 迟到 delay 毫秒
async function slowBackend(delay) {
  const up = http2.createServer()
  up.on('stream', stream => { stream.respond({ ':status': 200 }); stream.end('ok') })
  await new Promise(rv => up.listen(0, '127.0.0.1', rv))

  const front = net.createServer(sock => {
    sock.pause()
    sock.on('error', () => {})
    setTimeout(() => {
      if (!up.listening) return sock.destroy()
      const u = net.connect(up.address().port, '127.0.0.1')
      u.on('error', () => {})
      sock.pipe(u).pipe(sock)
      sock.resume()
    }, delay)
  })
  await new Promise(rv => front.listen(0, '127.0.0.1', rv))

  return { port: front.address().port, close() { front.close(); up.close() } }
}

function request(port, host) {
  return new Promise(resolve => {
    const r = http.request({ host: '127.0.0.1', port, path: '/', headers: { host }, agent: false }, res => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    r.on('error', () => resolve('ERR'))
    r.end()
  })
}

// 冷启动：3 个并发请求，对端 SETTINGS 迟到 3.5s
async function coldStart(aport, proxyOpts, backendCfg) {
  const be = await slowBackend(3500)

  const pxy = new Http2Proxy({
    minConnect: 0,
    ...proxyOpts,
    config: { 'q.test': [{ path: '/', url: `http://127.0.0.1:${be.port}`, ...backendCfg }] }
  })
  const app = new Topbit({ debug: false })
  pxy.init(app)
  app.run(aport, '127.0.0.1')
  await sleep(300)

  const codes = await Promise.all([1, 2, 3].map(() => request(aport, 'q.test')))
  be.close()
  return codes
}

;(async () => {
  // ---------- 1. 配置传递 ----------
  {
    const cap = captureErrors()

    const base = { path: '/', minConnect: 0 }
    const d = new Http2Proxy({ config: { 'q.test': [{ ...base, url: 'http://127.0.0.1:1' }] } })
    check('1.1 默认 3000', poolTimeouts(d, 'q.test')[0] === 3000, `实际 ${poolTimeouts(d, 'q.test')}`)

    const inst = new Http2Proxy({
      queueTimeout: 5000,
      config: {
        'q.test': [
          { ...base, url: 'http://127.0.0.1:1' },
          { ...base, url: 'http://127.0.0.1:2', queueTimeout: 7000 }
        ]
      }
    })
    const t = poolTimeouts(inst, 'q.test')
    check('1.2 实例级传递给未设置的后端', t[0] === 5000, `实际 ${t[0]}`)
    check('1.3 后端级覆盖实例级', t[1] === 7000, `实际 ${t[1]}`)

    const bad = new Http2Proxy({
      queueTimeout: 'abc',
      config: {
        'q.test': [
          { ...base, url: 'http://127.0.0.1:1', queueTimeout: 0 },
          { ...base, url: 'http://127.0.0.1:2', queueTimeout: -5 },
          { ...base, url: 'http://127.0.0.1:3', queueTimeout: NaN }
        ]
      }
    })
    await sleep(700)  // 越过「未知选项」告警的 500ms 延迟
    cap.restore()

    check('1.4 非法值全部回退默认 3000', poolTimeouts(bad, 'q.test').every(v => v === 3000),
          `实际 ${poolTimeouts(bad, 'q.test')}`)
    check('1.5 实例级非法值报错', cap.msgs.some(m => m.includes('queueTimeout 必须是大于 0 的数字: abc')))
    check('1.6 后端级非法值报错（0 / -5 / NaN）',
          [': 0', ': -5', ': NaN'].every(s => cap.msgs.some(m => m.includes('queueTimeout 必须是大于 0 的数字' + s))))
    check('1.7 queueTimeout 不触发「未知选项」', !cap.msgs.some(m => m.includes('未知选项')))
  }

  // ---------- 2. 功能：冷启动慢握手并发 ----------
  {
    const codes = await coldStart(39920, {}, {})
    check('2.1 默认 3s：排队请求超时 503', codes.includes(503) && codes.includes(200), `实际 ${codes}`)
  }
  {
    const codes = await coldStart(39921, { queueTimeout: 8000 }, {})
    check('2.2 实例级 8s：并发请求全部成功', codes.every(c => c === 200), `实际 ${codes}`)
  }
  {
    const codes = await coldStart(39922, {}, { queueTimeout: 8000 })
    check('2.3 后端级 8s（实例默认）：并发请求全部成功', codes.every(c => c === 200), `实际 ${codes}`)
  }

  console.log(`\n通过 ${pass}，失败 ${fail}`)
  process.exit(fail > 0 ? 1 : 0)
})().catch(err => {
  // 异常可能发生在 captureErrors 期间，console.error 已被替换，直接写 stderr
  process.stderr.write(`测试异常：${err && err.stack}\n`)
  process.exit(1)
})
