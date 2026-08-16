'use strict';

// 端到端验证：h1 下游 → h2 上游（http2proxy.js + Http2Pool.js）
// 覆盖：fmtHeaders 伪头转换、POST 主体、响应头转 h1、未配置 host 放行、path 尾斜杠初始化

const Topbit = require('../src/topbit.js');
const http = require('node:http');
const http2 = require('node:http2');

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' ' + extra : ''}`);
  cond ? pass++ : fail++;
}

// h2c echo 后端（明文 prior-knowledge）
const h2backend = http2.createServer();

h2backend.on('stream', (stream, headers) => {
  stream.on('error', () => {});
  if (stream.aborted) return;

  let d = '';
  stream.on('data', c => d += c);
  stream.on('end', () => {
    if (stream.destroyed || stream.closed) return;
    stream.respond({
      ':status': 200,
      'x-h2-backend': 'yes',
      'content-type': 'application/json'
    });
    stream.end(JSON.stringify({
      method: headers[':method'],
      path: headers[':path'],
      body: d
    }));
    d = '';
  });
  stream.on('close', () => { d = ''; });
});

h2backend.listen(39881, '127.0.0.1', () => {
  const { Http2Proxy } = Topbit.extensions;

  // path 尾斜杠初始化不应崩溃
  let pxy;
  try {
    pxy = new Http2Proxy({
      config: {
        'h2c.test': [{ path: '/api/', url: 'http://127.0.0.1:39881', aliveCheckInterval: 0 }]
      }
    });
    check('path=/api/ 初始化不崩溃', true);
  } catch (e) {
    check('path=/api/ 初始化不崩溃', false, e.message);
    process.exit(1);
  }

  const app = new Topbit({ debug: false });
  pxy.init(app);
  app.run(39880, '127.0.0.1');

  function req(host, p, method = 'GET', body = null) {
    return new Promise(resolve => {
      const r = http.request({ host: '127.0.0.1', port: 39880, path: p, method, headers: { host } }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => resolve({ code: res.statusCode, headers: res.headers, body: d }));
      });
      r.on('error', e => resolve({ code: 'ERR', headers: {}, body: e.message }));
      if (body) r.write(body);
      r.end();
    });
  }

  setTimeout(async () => {
    // 基础转发 + 路径/query 透传（fmtHeaders）
    let r = await req('h2c.test', '/api/user?id=7');
    let j = {};
    try { j = JSON.parse(r.body); } catch (e) { }
    check('状态 200', r.code === 200, `实际 ${r.code} ${r.body.slice(0, 50)}`);
    check(':path 透传（fmtHeaders）', j.path === '/api/user?id=7', `实际 ${j.path}`);
    check('method 透传', j.method === 'GET');
    check('响应头转 h1', r.headers['x-h2-backend'] === 'yes');

    // POST 主体
    r = await req('h2c.test', '/api/post', 'POST', 'h2c-body');
    try { j = JSON.parse(r.body); } catch (e) { j = {}; }
    check('POST 主体转发', j.body === 'h2c-body', `实际 ${j.body}`);

    // 未配置 host → next() 放行 → 占位路由 200 空响应（非 full 模式）
    // 路径需落在已注册路由 /api/* 下，否则框架按无路由返回 404
    r = await req('unknown.test', '/api/notproxied');
    check('未配置 host 放行（200 空响应）', r.code === 200 && r.body === '', `实际 ${r.code}`);

    console.log(`\n结果: ${pass} pass, ${fail} fail`);
    process.exit(fail > 0 ? 1 : 0);
  }, 600);
});
