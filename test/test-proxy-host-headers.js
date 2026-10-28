'use strict';

// 端到端验证：代理配置的自定义头语义（Proxy → h1 后端、Http2Proxy → h2 后端）
// 覆盖：
//   1. 配置 headers 里 host / :authority 两种写法，对两类后端都应等价地改写目标 Host
//   2. 配置 headers / resHeaders 的 key 大小写混用（'X-Foo'），应覆盖同名头而不是与之合并
// 入站协议三种：ALPN h1、ALPN h2（Http2ServerResponse）、纯 h2（ServerHttp2Stream）
// 依赖 demo/cert/ 证书（仅测试用途，客户端 rejectUnauthorized:false）

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const http2 = require('node:http2');
const https = require('node:https');

const KEY = path.join(__dirname, '../demo/cert/localhost-privkey.pem');
const CERT = path.join(__dirname, '../demo/cert/localhost-cert.pem');

if (!fs.existsSync(KEY) || !fs.existsSync(CERT)) {
  console.log('SKIP: demo/cert/ 证书缺失');
  process.exit(0);
}

const Topbit = require('../src/topbit.js');
const { Proxy, Http2Proxy } = Topbit.extensions;

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' ' + extra : ''}`);
  cond ? pass++ : fail++;
}

const H1_BACKEND_PORT = 39921;
const H2_BACKEND_PORT = 39922;

// 后端统一回显：实际收到的目标 Host、x-foo、x-bar-baz，响应头带 x-res: backend
function echo(h) {
  return JSON.stringify({
    authority: h[':authority'] || h.host,
    xfoo: h['x-foo'],
    xbar: h['x-bar-baz'],
  });
}

const h1backend = http.createServer((rq, rs) => {
  rs.setHeader('x-res', 'backend');
  rs.end(echo(rq.headers));
});

const h2backend = http2.createServer();
h2backend.on('stream', (stream, headers) => {
  stream.on('error', () => {});
  stream.respond({ ':status': 200, 'x-res': 'backend', 'content-type': 'application/json' });
  stream.end(echo(headers));
});

// 同一份配置喂给两类代理；key 为客户端请求的 host
function makeConfig(port) {
  const url = `http://127.0.0.1:${port}`
  return {
    // 对照组：不配 headers，目标 Host 应是后端自己的地址，而不是客户端的原值
    'plain.test': [{ path: '/', url, aliveCheckInterval: 0 }],
    // 配置 :authority 写法
    'auth.test': [{ path: '/', url, aliveCheckInterval: 0, headers: { ':authority': 'override-a.example' } }],
    // 配置 host 写法
    'host.test': [{ path: '/', url, aliveCheckInterval: 0, headers: { host: 'override-h.example' } }],
    // 大小写混用：请求头与响应头都应"覆盖"而非"合并"
    'case.test': [{
      path: '/', url, aliveCheckInterval: 0,
      headers: { 'X-Foo': 'cfg', 'X-Bar-Baz': 'cfg2' },
      resHeaders: { 'X-Res': 'cfg' },
    }],
  }
}

// 三种入站客户端；统一返回 { code, json, xres }
const CLIENT_HEADERS = { 'x-foo': 'client', 'x-bar-baz': 'client2' }

function callH1(port, host) {
  return new Promise(resolve => {
    const r = https.request({
      host: '127.0.0.1', port, path: '/t', rejectUnauthorized: false,
      ALPNProtocols: ['http/1.1'], headers: { host, ...CLIENT_HEADERS },
    }, res => {
      let d = ''
      res.on('data', c => d += c)
      res.on('end', () => resolve(parse(res.statusCode, d, res.headers['x-res'])))
    })
    r.on('error', e => resolve({ code: 'ERR', json: {}, xres: undefined, err: e.message }))
    r.end()
  })
}

function callH2(port, host) {
  return new Promise(resolve => {
    const client = http2.connect(`https://127.0.0.1:${port}`, { rejectUnauthorized: false })
    client.on('error', e => resolve({ code: 'ERR', json: {}, xres: undefined, err: e.message }))
    const r = client.request({ ':method': 'GET', ':path': '/t', ':authority': host, ...CLIENT_HEADERS })
    let code, xres, d = ''
    r.on('response', h => { code = h[':status']; xres = h['x-res'] })
    r.on('data', c => d += c)
    r.on('end', () => { client.close(); resolve(parse(code, d, xres)) })
    r.on('error', e => { client.close(); resolve({ code: 'ERR', json: {}, xres: undefined, err: e.message }) })
    r.end()
  })
}

function parse(code, body, xres) {
  let json = {}
  try { json = JSON.parse(body) } catch (e) { }
  return { code, json, xres, body }
}

// 单个用例的期望：[host key] → 后端应收到的目标 Host
// DEFAULT 表示未配置覆盖：后端应收到它自己的地址 127.0.0.1:<后端端口>
const EXPECT_AUTHORITY = {
  'plain.test': 'DEFAULT',
  'auth.test': 'override-a.example',
  'host.test': 'override-h.example',
  'case.test': 'DEFAULT',
}

async function runMatrix(label, port, backendPort, clients) {
  for (const [cname, call] of clients) {
    for (const host of Object.keys(EXPECT_AUTHORITY)) {
      const r = await Promise.race([
        call(port, host),
        new Promise(res => setTimeout(() => res({ code: 'TIMEOUT', json: {} }), 4000)),
      ])
      const tag = `${label} ← ${cname} [${host}]`

      check(`${tag} 状态 200`, r.code === 200, `实际 ${r.code} ${r.err || (r.body || '').slice(0, 60)}`)
      const expectAuthority = EXPECT_AUTHORITY[host] === 'DEFAULT'
        ? `127.0.0.1:${backendPort}`
        : EXPECT_AUTHORITY[host]
      check(`${tag} 目标 Host`, r.json.authority === expectAuthority,
        `期望 ${expectAuthority} 实际 ${r.json.authority}`)

      if (host === 'case.test') {
        check(`${tag} 请求头大小写覆盖 x-foo`, r.json.xfoo === 'cfg', `实际 ${r.json.xfoo}`)
        check(`${tag} 请求头大小写覆盖 x-bar-baz`, r.json.xbar === 'cfg2', `实际 ${r.json.xbar}`)
        check(`${tag} 响应头大小写覆盖 x-res`, r.xres === 'cfg', `实际 ${r.xres}`)
      }
    }
  }
}

function startApp(pxy, port, allowHTTP1) {
  const app = new Topbit({ debug: false, http2: true, allowHTTP1, key: KEY, cert: CERT })
  pxy.init(app)
  app.run(port, '127.0.0.1')
}

h1backend.listen(H1_BACKEND_PORT, '127.0.0.1', () => {
  h2backend.listen(H2_BACKEND_PORT, '127.0.0.1', async () => {
    // h1 后端：Proxy；h2 后端：Http2Proxy。每个代理各起 ALPN 与纯 h2 两个入口
    startApp(new Proxy({ config: makeConfig(H1_BACKEND_PORT) }), 39911, true)
    startApp(new Proxy({ config: makeConfig(H1_BACKEND_PORT) }), 39912, false)
    startApp(new Http2Proxy({ config: makeConfig(H2_BACKEND_PORT) }), 39913, true)
    startApp(new Http2Proxy({ config: makeConfig(H2_BACKEND_PORT) }), 39914, false)

    await new Promise(r => setTimeout(r, 600))

    await runMatrix('Proxy(h1后端)', 39911, H1_BACKEND_PORT, [['ALPN h1', callH1], ['ALPN h2', callH2]])
    await runMatrix('Proxy(h1后端)', 39912, H1_BACKEND_PORT, [['纯 h2', callH2]])
    await runMatrix('Http2Proxy(h2后端)', 39913, H2_BACKEND_PORT, [['ALPN h1', callH1], ['ALPN h2', callH2]])
    await runMatrix('Http2Proxy(h2后端)', 39914, H2_BACKEND_PORT, [['纯 h2', callH2]])

    console.log(`\n结果: ${pass} pass, ${fail} fail`)
    process.exit(fail > 0 ? 1 : 0)
  })
})

setTimeout(() => { console.log('FAIL 整体超时'); process.exit(2) }, 120000)
