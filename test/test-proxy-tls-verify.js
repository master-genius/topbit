'use strict';

// 代理到 https 后端时，后端证书校验开关的验证（Proxy / ProxyNoAgent）
// 约定：
//   1. 默认不校验后端证书（保持原行为）
//   2. 经 connectOptions.rejectUnauthorized 显式开启后必须生效，实例级与后端级都可以
//   3. 可配合 connectOptions.ca 让自签证书通过校验
//
// 依赖 openssl 现场生成带 SAN 的临时证书（演示证书已过期且无 SAN）；没有 openssl 则跳过。
//
// 运行：node test/test-proxy-tls-verify.js

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const https = require('node:https')
const http = require('node:http')
const { execFileSync } = require('node:child_process')

let dir
try {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-tls-'))
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'),
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'
  ], { stdio: 'ignore' })
} catch (e) {
  console.log('SKIP: 无法用 openssl 生成临时证书')
  process.exit(0)
}

const KEY = fs.readFileSync(path.join(dir, 'k.pem'))
const CERT = fs.readFileSync(path.join(dir, 'c.pem'))

const Topbit = require('../src/topbit.js')
const { Proxy, ProxyNoAgent } = Topbit.extensions

let pass = 0, fail = 0
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' ' + extra : ''}`)
  cond ? pass++ : fail++
}

const sleep = ms => new Promise(rv => setTimeout(rv, ms))

// 端口取在系统临时端口范围（32768+）之外，避免与其他进程的外连源端口冲突
const BACKEND_PORT = 28901
let nextPort = 28910

let served = 0
const backend = https.createServer({ key: KEY, cert: CERT }, (rq, rs) => { served++; rs.end('ok') })

function call(port, host) {
  return new Promise(resolve => {
    const r = http.request({ host: '127.0.0.1', port, path: '/', headers: { host }, agent: false }, res => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    r.on('error', () => resolve('ERR'))
    r.end()
  })
}

function startApp(pxy) {
  const port = nextPort++
  const app = new Topbit({ debug: false })
  pxy.init(app)
  app.run(port, '127.0.0.1')
  return port
}

;(async () => {
  await new Promise(rv => backend.listen(BACKEND_PORT, '127.0.0.1', rv))
  const url = `https://localhost:${BACKEND_PORT}`
  const base = { path: '/', url, aliveCheckInterval: 0 }

  for (const [name, Cls] of [['Proxy', Proxy], ['ProxyNoAgent', ProxyNoAgent]]) {
    // 后端级配置：每个 host 一种 connectOptions
    const pBackend = startApp(new Cls({
      config: {
        'default.test': [{ ...base }],                                                    // 不配置
        'verify.test': [{ ...base, connectOptions: { rejectUnauthorized: true } }],       // 开启，证书不受信
        'ca.test': [{ ...base, connectOptions: { rejectUnauthorized: true, ca: CERT } }], // 开启，并信任这张证书
        'off.test': [{ ...base, connectOptions: { rejectUnauthorized: false } }]          // 显式关闭
      }
    }))

    // 实例级配置：所有后端继承
    const pInst = startApp(new Cls({
      connectOptions: { rejectUnauthorized: true },
      config: {
        'inst.test': [{ ...base }],
        // 实例级开启校验 + 后端级补充 ca：两者合并，校验通过
        'instca.test': [{ ...base, connectOptions: { ca: CERT } }],
        // 后端级显式关闭，覆盖实例级
        'instoff.test': [{ ...base, connectOptions: { rejectUnauthorized: false } }]
      }
    }))

    await sleep(300)

    let before = served
    check(`${name} 默认不校验后端证书`, await call(pBackend, 'default.test') === 200)
    check(`${name} 默认：请求到达后端`, served === before + 1, `served ${served - before}`)

    before = served
    const rv = await call(pBackend, 'verify.test')
    check(`${name} 后端级 rejectUnauthorized:true 生效（证书不受信被拒）`, rv !== 200, `实际 ${rv}`)
    check(`${name} 被拒的请求没有到达后端`, served === before, `served ${served - before}`)

    before = served
    const ri = await call(pInst, 'inst.test')
    check(`${name} 实例级 rejectUnauthorized:true 生效`, ri !== 200, `实际 ${ri}`)
    check(`${name} 实例级：被拒的请求没有到达后端`, served === before, `served ${served - before}`)

    check(`${name} 实例级校验 + 后端级 ca 合并后通过`, await call(pInst, 'instca.test') === 200)
    check(`${name} 后端级 false 覆盖实例级 true`, await call(pInst, 'instoff.test') === 200)
    check(`${name} 配合 ca 后校验通过`, await call(pBackend, 'ca.test') === 200)
    check(`${name} 显式 rejectUnauthorized:false 仍可访问`, await call(pBackend, 'off.test') === 200)
  }

  fs.rmSync(dir, { recursive: true, force: true })
  console.log(`\n通过 ${pass}，失败 ${fail}`)
  process.exit(fail > 0 ? 1 : 0)
})().catch(err => {
  process.stderr.write(`测试异常：${err && err.stack}\n`)
  process.exit(1)
})
