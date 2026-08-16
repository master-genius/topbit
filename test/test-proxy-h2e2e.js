'use strict';

// 端到端验证：纯 h2 下游（http2.js / Context2）→ h1 上游（proxy.js）
// 覆盖：路径/query 透传、POST 主体、响应头与状态码透传、连续请求稳定性
// 依赖 demo/cert/ 证书（仅测试用途，过期不影响，客户端 rejectUnauthorized:false）

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const http2 = require('node:http2');

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

// h1 echo 后端
const backend = http.createServer((rq, rs) => {
  if (rq.url.indexOf('/err') === 0) {
    rs.statusCode = 404;
    rs.setHeader('x-code', 'nf');
    return rs.end('not-found-body');
  }
  let d = '';
  rq.on('data', c => d += c);
  rq.on('end', () => {
    rs.setHeader('x-backend', 'h1-echo');
    rs.end(JSON.stringify({ m: rq.method, url: rq.url, body: d }));
  });
});

backend.listen(39851, '127.0.0.1', () => {
  const { Proxy } = Topbit.extensions;

  const pxy = new Proxy({
    config: { 'h2.test': [{ path: '/', url: 'http://127.0.0.1:39851' }] }
  });

  const app = new Topbit({ debug: false, http2: true, key: KEY, cert: CERT });

  pxy.init(app);
  app.run(39850, '127.0.0.1');

  setTimeout(() => {
    const client = http2.connect('https://127.0.0.1:39850', { rejectUnauthorized: false });

    client.on('error', e => {
      check('h2 客户端连接', false, e.message);
      process.exit(1);
    });

    function h2req(method, reqPath, body = null) {
      return new Promise(resolve => {
        const req = client.request({
          ':method': method,
          ':path': reqPath,
          ':authority': 'h2.test'
        });

        let status = 0, headers = {}, d = '';
        req.on('response', h => {
          status = h[':status'];
          headers = h;
        });
        req.on('data', c => d += c);
        req.on('end', () => resolve({ status, headers, body: d }));
        req.on('error', e => resolve({ status: 'ERR', headers: {}, body: e.message }));

        if (body) req.write(body);
        req.end();
      });
    }

    (async () => {
      // GET 路径 + query 透传（P1 核心断言）
      let r = await h2req('GET', '/api/h2path?x=1&y=2');
      let j = {};
      try { j = JSON.parse(r.body); } catch (e) { }
      check('h2 GET 状态 200', r.status === 200, `实际 ${r.status} ${r.body.slice(0, 40)}`);
      check('h2 路径不丢失（含 query）', j.url === '/api/h2path?x=1&y=2', `实际 ${j.url}`);
      check('h2 响应头透传', r.headers['x-backend'] === 'h1-echo');

      // POST 主体经 h2 转发
      r = await h2req('POST', '/submit/form?act=create', 'h2-body-data');
      try { j = JSON.parse(r.body); } catch (e) { j = {}; }
      check('h2 POST 路径正确', j.url === '/submit/form?act=create', `实际 ${j.url}`);
      check('h2 POST 主体转发', j.body === 'h2-body-data', `实际 ${j.body}`);

      // 连续请求稳定
      r = await h2req('GET', '/again/p1?q=ok');
      try { j = JSON.parse(r.body); } catch (e) { j = {}; }
      check('h2 连续请求路径稳定', j.url === '/again/p1?q=ok', `实际 ${j.url}`);

      // 非 200 状态码 + 自定义响应头透传
      r = await h2req('GET', '/err/page?x=1');
      check('h2 后端 404 状态码透传', r.status === 404, `实际 ${r.status}`);
      check('h2 非 200 响应头透传', r.headers['x-code'] === 'nf');
      check('h2 非 200 body 透传', r.body === 'not-found-body');

      console.log(`\n结果: ${pass} pass, ${fail} fail`);
      client.close();
      process.exit(fail > 0 ? 1 : 0);
    })();
  }, 400);
});
