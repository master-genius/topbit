'use strict';

// 端到端验证：h1 代理全链路（proxy.js）
// 覆盖：GET/POST 转发、路径+query 透传、配置头覆盖、resHeaders/resHeadersCallback、
//       rewrite 字符串重写、rewrite 重定向 302、权重分布、requestTimeout、
//       后端无响应断连错误页、存活检测回退

const Topbit = require('../src/topbit.js');
const http = require('node:http');

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' ' + extra : ''}`);
  cond ? pass++ : fail++;
}

function req(opts, body = null) {
  return new Promise(resolve => {
    let done = false;
    const finish = r => { if (!done) { done = true; resolve(r); } };
    const r = http.request(opts, res => {
      let d = '';
      let ended = false;
      res.on('data', c => d += c);
      res.on('end', () => { ended = true; finish({ code: res.statusCode, headers: res.headers, body: d }); });
      // 连接被切断（如 requestTimeout）：无 end，close 兜底
      res.on('close', () => {
        if (!ended) finish({ code: res.statusCode, headers: res.headers, body: d, aborted: true });
      });
    });
    r.on('error', e => finish({ code: 'ERR', headers: {}, body: e.message }));
    if (body) r.write(body);
    r.end();
  });
}

// b1: echo 服务
const b1 = http.createServer((rq, rs) => {
  let d = '';
  rq.on('data', c => d += c);
  rq.on('end', () => {
    rs.setHeader('x-backend', 'b1');
    rs.end(JSON.stringify({
      m: rq.method, url: rq.url, body: d,
      ip: rq.headers['x-real-ip'], ua: rq.headers['x-custom-h'] || null
    }));
  });
});
const b2 = http.createServer((rq, rs) => rs.end('W1'));
const b3 = http.createServer((rq, rs) => rs.end('W2'));
const b4 = http.createServer((rq, rs) => {
  rs.writeHead(200, { 'content-type': 'text/plain' });
  rs.flushHeaders();
  setTimeout(() => rs.end('slow-body'), 2000);
});
const b5 = http.createServer((rq, rs) => rs.socket.destroy());

Promise.all([
  new Promise(r => b1.listen(39811, r)),
  new Promise(r => b2.listen(39812, r)),
  new Promise(r => b3.listen(39813, r)),
  new Promise(r => b4.listen(39814, r)),
  new Promise(r => b5.listen(39815, r)),
]).then(() => {
  const { Proxy } = Topbit.extensions;

  const pxy = new Proxy({
    config: {
      'basic.test': [{
        path: '/', url: 'http://127.0.0.1:39811',
        headers: { 'x-custom-h': 'cv' },
        resHeaders: { 'x-res-static': 'S' }
      }],
      'cb.test': [{
        path: '/', url: 'http://127.0.0.1:39811',
        resHeadersCallback: c => ({ 'x-res-cb': c.host })
      }],
      'rw.test': [{
        path: '/old', url: 'http://127.0.0.1:39811',
        rewrite: (c, p) => '/newpath' + p.substring('/old'.length)
      }],
      'jump.test': [{
        path: '/jump', url: 'http://127.0.0.1:39811',
        rewrite: (c, p) => ({ redirect: 'https://example.com/target' })
      }],
      'w.test': [
        { path: '/', url: 'http://127.0.0.1:39812', weight: 3 },
        { path: '/', url: 'http://127.0.0.1:39813', weight: 1 }
      ],
      'rt.test': [{
        path: '/', url: 'http://127.0.0.1:39814', requestTimeout: 300
      }],
      'dead.test': [{ path: '/', url: 'http://127.0.0.1:39815' }],
      'alive.test': [
        { path: '/', url: 'http://127.0.0.1:39819', aliveCheckInterval: 1 },
        { path: '/', url: 'http://127.0.0.1:39811', aliveCheckInterval: 1 }
      ]
    }
  });

  const app = new Topbit({ debug: false });
  pxy.init(app);
  app.run(39810, '127.0.0.1');

  const H = p => ({ host: '127.0.0.1', port: 39810, path: p });

  setTimeout(async () => {
    // 1. GET 基础转发
    let r = await req({ ...H('/api/data?x=1&y=2'), headers: { host: 'basic.test' } });
    let j = {};
    try { j = JSON.parse(r.body); } catch (e) { }
    check('GET 状态 200', r.code === 200);
    check('GET 路径+query 透传', j.url === '/api/data?x=1&y=2', `实际 ${j.url}`);
    check('GET x-real-ip 注入', typeof j.ip === 'string' && j.ip.length > 0);
    check('GET 配置请求头覆盖', j.ua === 'cv');
    check('GET resHeaders 静态响应头', r.headers['x-res-static'] === 'S');
    check('GET 后端响应头透传', r.headers['x-backend'] === 'b1');

    // 2. POST 主体转发
    r = await req({ ...H('/upload'), method: 'POST', headers: { host: 'basic.test' } }, 'hello-body');
    try { j = JSON.parse(r.body); } catch (e) { j = {}; }
    check('POST 主体转发', j.body === 'hello-body', `实际 ${j.body}`);

    // 3. resHeadersCallback
    r = await req({ ...H('/'), headers: { host: 'cb.test' } });
    check('resHeadersCallback 生效', r.headers['x-res-cb'] === 'cb.test');

    // 4. rewrite 字符串重写
    r = await req({ ...H('/old/sub?a=9'), headers: { host: 'rw.test' } });
    try { j = JSON.parse(r.body); } catch (e) { j = {}; }
    check('rewrite 路径重写', j.url === '/newpath/sub?a=9', `实际 ${j.url}`);

    // 5. rewrite 重定向 302
    r = await req({ ...H('/jump/x'), headers: { host: 'jump.test' } });
    check('redirect 状态码 302', r.code === 302, `实际 ${r.code}`);
    check('redirect location 头', r.headers.location === 'https://example.com/target');

    // 6. 权重 3:1 分布（40 次期望 30/10，容差 ±4）
    let c1 = 0, c2 = 0;
    for (let i = 0; i < 40; i++) {
      r = await req({ ...H('/'), headers: { host: 'w.test' } });
      r.body === 'W1' ? c1++ : c2++;
    }
    check('权重 3:1 分布', Math.abs(c1 - 30) <= 4 && Math.abs(c2 - 10) <= 4, `W1=${c1} W2=${c2}`);

    // 7. requestTimeout：300ms 上限，客户端应提前断开且拿不到 body
    let t0 = Date.now();
    r = await req({ ...H('/slow'), headers: { host: 'rt.test' } });
    let el = Date.now() - t0;
    check('requestTimeout 提前断开', el < 1500 && r.body !== 'slow-body', `耗时 ${el}ms`);

    // 8. 无响应断连 → 错误页
    r = await req({ ...H('/x'), headers: { host: 'dead.test' } });
    check('无响应断连错误页', (r.code === 502 || r.code === 503) && r.body.includes('5'), `实际 ${r.code}`);

    // 9. 存活检测回退：等待死后端被标记
    setTimeout(async () => {
      let okB = 0;
      for (let i = 0; i < 8; i++) {
        r = await req({ ...H('/probe'), headers: { host: 'alive.test' } });
        if (r.code === 200) okB++;
      }
      check('存活检测回退到健康后端', okB >= 7, `成功 ${okB}/8`);

      console.log(`\n结果: ${pass} pass, ${fail} fail`);
      process.exit(fail > 0 ? 1 : 0);
    }, 2600);
  }, 300);
});
