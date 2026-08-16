'use strict';

// 端到端验证：ALPN 混合模式（http2 + allowHTTP1）下 http2proxy 的双协议下游支持
// 覆盖：ALPN h1 客户端、ALPN h2 客户端分别代理到 h2 上游（request_stream 归一化路径）
// 依赖 demo/cert/ 证书（仅测试用途，过期不影响）

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

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' ' + extra : ''}`);
  cond ? pass++ : fail++;
}

// h2c echo 后端
const h2backend = http2.createServer();
h2backend.on('stream', (stream, headers) => {
  stream.on('error', () => {});
  let d = '';
  stream.on('data', c => d += c);
  stream.on('end', () => {
    if (stream.destroyed || stream.closed) return;
    stream.respond({ ':status': 200, 'content-type': 'application/json' });
    stream.end(JSON.stringify({ method: headers[':method'], path: headers[':path'], body: d }));
    d = '';
  });
  stream.on('close', () => { d = ''; });
});

h2backend.listen(39896, '127.0.0.1', () => {
  const { Http2Proxy } = Topbit.extensions;

  const pxy = new Http2Proxy({
    config: { 'alpn2.test': [{ path: '/', url: 'http://127.0.0.1:39896', aliveCheckInterval: 0 }] }
  });

  const app = new Topbit({
    debug: false, http2: true, allowHTTP1: true, key: KEY, cert: CERT
  });

  pxy.init(app);
  app.run(39895, '127.0.0.1');

  setTimeout(() => {
    // 1. ALPN h2 客户端
    const client = http2.connect('https://127.0.0.1:39895', { rejectUnauthorized: false });
    client.on('error', e => { check('h2 客户端连接', false, e.message); process.exit(1); });

    const req2 = client.request({ ':method': 'GET', ':path': '/via-alpn-h2?x=2', ':authority': 'alpn2.test' });
    let d2 = '';
    req2.on('data', c => d2 += c);
    req2.on('end', () => {
      let j = {};
      try { j = JSON.parse(d2); } catch (e) { }
      check('ALPN h2 客户端 :path 透传', j.path === '/via-alpn-h2?x=2', `实际 ${j.path || d2.slice(0, 60)}`);

      // 2. ALPN h1 客户端
      const req1 = https.request({
        host: '127.0.0.1', port: 39895, path: '/via-alpn-h1?x=1',
        headers: { host: 'alpn2.test' }, rejectUnauthorized: false, ALPNProtocols: ['http/1.1']
      }, res => {
        let d1 = '';
        res.on('data', c => d1 += c);
        res.on('end', () => {
          let j1 = {};
          try { j1 = JSON.parse(d1); } catch (e) { }
          check('ALPN h1 客户端 :path 透传（fmtHeaders）', j1.path === '/via-alpn-h1?x=1', `实际 ${j1.path || d1.slice(0, 60)}`);
          console.log(`\n结果: ${pass} pass, ${fail} fail`);
          client.close();
          process.exit(fail > 0 ? 1 : 0);
        });
      });
      req1.on('error', e => { check('ALPN h1 客户端请求', false, e.message); process.exit(1); });
      req1.end();
    });
    req2.on('error', e => { check('ALPN h2 客户端请求', false, e.message); process.exit(1); });
    req2.end();
  }, 600);
});
