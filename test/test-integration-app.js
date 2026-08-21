'use strict';
// test-integration-app：单进程 + 3 个实例 + 3 种协议形态，每个实例同时挂
// 业务路由 / 分组前缀 / 代理 / 静态资源 / 中间件，并发交错验证。
const http = require('node:http');
const https = require('node:https');
const http2 = require('node:http2');
const fs = require('node:fs');
const Topbit = require('../src/topbit.js');
const { Proxy, Resource, SNI } = Topbit.extensions;

const CERT = __dirname + '/../demo/cert/';
const PUB = __dirname + '/pubdir';
const P_H1 = 48001, P_TLS = 48002, P_H2 = 48003, P_BK = 48010;

let failed = 0;
const ok = (d, c, e) => { if (!c) { failed++; console.log(`FAIL ${d}${e ? '\n     ' + e : ''}`); } else console.log(`PASS ${d}`); };

// —— 上游后端（供代理转发）——
http.createServer((q, r) => {
  let b = '';
  q.on('data', c => b += c);
  q.on('end', () => r.end(`BK|${q.method}|${q.url}|${b}`));
}).listen(P_BK);

function mkApp(tag, opts, port) {
  const app = new Topbit(Object.assign({ debug: false }, opts));
  const trace = [];
  app.__trace = trace;

  app.use(async (c, next) => { trace.push('g'); return await next(c); });

  // 业务路由
  app.get('/biz/static', async c => { c.data = `${tag}|bs`; });
  app.get('/biz/:id', async c => { c.data = `${tag}|bp|${c.param.id}`; });
  app.get('/biz/w/*', async c => { c.data = `${tag}|bw|${c.param.starPath}`; });
  app.post('/biz/form', async c => { c.data = `${tag}|form|${JSON.stringify(c.body)}`; });
  app.put('/biz/:id', async c => { c.data = `${tag}|put|${c.param.id}`; });
  app.delete('/biz/:id', async c => { c.data = `${tag}|del|${c.param.id}`; });
  app.get('/biz/boom', async c => { throw new Error('boom'); });

  // 分组 + 前缀 + 分组中间件
  const g = app.group('/grp');
  g.pre(async (c, next) => { trace.push('gp'); return await next(c); });
  g.get('/x', async c => { c.data = `${tag}|grp|${c.group}`; });
  g.get('/p/:v', async c => { c.data = `${tag}|grpp|${c.param.v}`; });
  const g2 = g.group('/sub');
  g2.get('/y/:z', async c => { c.data = `${tag}|grp2|${c.param.z}|${c.group}`; });

  // 静态资源
  new Resource({ staticPath: PUB, routePath: '/pub/*' }).init(app);

  // 代理（含 defaultServer 与跨 host 降级）
  new Proxy({
    port: port,
    defaultServer: 'fallback.com',
    config: {
      'a.com': [{ path: '/api', url: `http://127.0.0.1:${P_BK}` }],
      'b.com': [{ path: '/', url: `http://127.0.0.1:${P_BK}` }],
      'fallback.com': [{ path: '/', url: `http://127.0.0.1:${P_BK}` }]
    }
  }).init(app);

  // 代理未命中处理
  app.use(async (c, next) => c.status(404).html('MISS'), '@topbit_proxy');

  return app;
}

const a1 = mkApp('H1', { parseBody: true }, P_H1);
a1.run(P_H1);

const a2 = mkApp('TLS', { parseBody: true, https: true,
  key: CERT + 'localhost-privkey.pem', cert: CERT + 'localhost-cert.pem' }, P_TLS);
new SNI({ 'x.com': { key: CERT + 'x.com.key', cert: CERT + 'x.com.cert' },
          'api.x.com': { key: CERT + 'api.x.com.key', cert: CERT + 'api.x.com.cert' } }).init(a2);
a2.run(P_TLS);

const a3 = mkApp('H2', { parseBody: true, https: true, http2: true, allowHTTP1: true,
  key: CERT + 'localhost-privkey.pem', cert: CERT + 'localhost-cert.pem' }, P_H2);
a3.run(P_H2);

// —— 请求工具 ——
function h1(port, path, opt = {}) {
  return new Promise(r => {
    const mod = opt.tls ? https : http;
    const q = mod.request(Object.assign({ host: '127.0.0.1', port, path, agent: false,
      rejectUnauthorized: false, method: opt.method || 'GET', headers: opt.headers || {} }, {}), res => {
      let d = ''; res.on('data', x => d += x);
      res.on('end', () => r({ code: res.statusCode, body: d, ct: res.headers['content-type'] || '-' }));
    });
    q.on('error', e => r({ code: 'ERR', body: e.message }));
    if (opt.body) q.write(opt.body);
    q.end();
  });
}
function h2req(port, path, headers = {}) {
  return new Promise(r => {
    const s = http2.connect(`https://127.0.0.1:${port}`, { rejectUnauthorized: false });
    s.on('error', e => r({ code: 'ERR', body: e.message }));
    const st = s.request(Object.assign({ ':path': path, ':method': 'GET' }, headers));
    let d = '', code = 0;
    st.on('response', h => code = h[':status']);
    st.on('data', c => d += c);
    st.on('end', () => { s.close(); r({ code, body: d }); });
    st.on('error', e => { s.close(); r({ code: 'ERR', body: e.message }); });
    st.end();
  });
}

setTimeout(async () => {
  // ===== 一、HTTP/1.1 全链路 =====
  const T = 'H1';
  ok('h1 静态路由', (await h1(P_H1, '/biz/static')).body === `${T}|bs`);
  ok('h1 参数路由', (await h1(P_H1, '/biz/77')).body === `${T}|bp|77`);
  ok('h1 星号路由', (await h1(P_H1, '/biz/w/x/y')).body === `${T}|bw|x/y`);
  ok('h1 多余斜杠命中静态', (await h1(P_H1, '//biz//static')).body === `${T}|bs`);
  ok('h1 多余斜杠命中参数', (await h1(P_H1, '/biz///88')).body === `${T}|bp|88`);
  ok('h1 PUT', (await h1(P_H1, '/biz/9', { method: 'PUT' })).body === `${T}|put|9`);
  ok('h1 DELETE', (await h1(P_H1, '/biz/9', { method: 'DELETE' })).body === `${T}|del|9`);

  const fr = await h1(P_H1, '/biz/form', { method: 'POST', body: 'a=1&b=2',
    headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  ok('h1 POST 表单解析', fr.body === `${T}|form|{"a":"1","b":"2"}`, fr.body);

  const jr = await h1(P_H1, '/biz/form', { method: 'POST', body: '{"x":[1,2]}',
    headers: { 'content-type': 'application/json' } });
  ok('h1 POST JSON 解析', jr.body === `${T}|form|{"x":[1,2]}`, jr.body);

  const er = await h1(P_H1, '/biz/boom');
  ok('h1 回调抛错 → 500', er.code === 500, `${er.code}`);
  // defaultServer 指向的 host 含 / 路由（即 /*），未匹配 host 的请求都会被它兜走。
  // 这是配置语义的必然结果，不是缺陷；业务路由因不在代理 pathTable 中而不受影响。
  ok('未注册路径被 defaultServer 兜走并代理',
    (await h1(P_H1, '/nope/zz')).body === 'BK|GET|/nope/zz|');
  ok('业务路由不被 defaultServer 抢走', (await h1(P_H1, '/biz/static')).body === 'H1|bs');

  // ===== 二、分组与前缀 =====
  ok('h1 分组路由', (await h1(P_H1, '/grp/x')).body === `${T}|grp|/grp`);
  ok('h1 分组参数路由', (await h1(P_H1, '/grp/p/vv')).body === `${T}|grpp|vv`);
  ok('h1 二级分组', (await h1(P_H1, '/grp/sub/y/zz')).body === `${T}|grp2|zz|/grp/sub`);
  ok('h1 分组 + 多余斜杠', (await h1(P_H1, '//grp//sub//y//qq')).body === `${T}|grp2|qq|/grp/sub`);

  // ===== 三、静态资源 =====
  const st = await h1(P_H1, '/pub/a.txt');
  ok('静态资源读取', st.code === 200 && st.body.trim() === 'STATIC-FILE-CONTENT', `${st.code} ${st.body}`);
  ok('静态资源 404', (await h1(P_H1, '/pub/none.txt')).code === 404);
  ok('静态资源路径穿越被拒', (await h1(P_H1, '/pub/../../etc/passwd')).body.indexOf('root:') < 0);

  // ===== 四、代理 =====
  const p1 = await h1(P_H1, '/api/u', { headers: { host: `a.com:${P_H1}` } });
  ok('代理 host+path 命中', p1.body === 'BK|GET|/api/u|', p1.body);
  const p2 = await h1(P_H1, '/anything', { headers: { host: `b.com:${P_H1}` } });
  ok('代理根路径 host', p2.body === 'BK|GET|/anything|', p2.body);
  const p3 = await h1(P_H1, '/api/u', { headers: { host: `nohost.com:${P_H1}` } });
  ok('代理 defaultServer 回退', p3.body === 'BK|GET|/api/u|', p3.body);
  const p4 = await h1(P_H1, '/api/deep/x', { headers: { host: `b.com:${P_H1}` } });
  ok('代理跨 host 路径降级', p4.body === 'BK|GET|/api/deep/x|', p4.body);
  const p5 = await h1(P_H1, '/api/u', { method: 'POST', body: 'hello',
    headers: { host: `a.com:${P_H1}`, 'content-type': 'text/plain' } });
  ok('代理 POST 透传请求体', p5.body === 'BK|POST|/api/u|hello', p5.body);

  // ===== 五、HTTPS + SNI =====
  ok('https 静态路由', (await h1(P_TLS, '/biz/static', { tls: true })).body === 'TLS|bs');
  ok('https 参数路由', (await h1(P_TLS, '/biz/55', { tls: true })).body === 'TLS|bp|55');
  ok('https 分组', (await h1(P_TLS, '/grp/sub/y/k', { tls: true })).body === 'TLS|grp2|k|/grp/sub');
  {
    const s = require('node:tls').connect({ port: P_TLS, host: '127.0.0.1',
      servername: 'x.com', rejectUnauthorized: false });
    const cn = await new Promise(r => { s.on('secureConnect', () => { const c = s.getPeerCertificate(); s.destroy(); r(c.subject && c.subject.CN); }); s.on('error', () => r('ERR')); });
    ok('SNI 按域名返回 x.com 专属证书（该证书 CN 为 Wang）', cn === 'Wang', String(cn));

    const s2 = require('node:tls').connect({ port: P_TLS, host: '127.0.0.1',
      servername: 'api.x.com', rejectUnauthorized: false });
    const cn2 = await new Promise(r => { s2.on('secureConnect', () => { const c = s2.getPeerCertificate(); s2.destroy(); r(c.subject && c.subject.CN); }); s2.on('error', () => r('ERR')); });
    ok('SNI 按域名返回 api.x.com 专属证书（CN 为 Brave）', cn2 === 'Brave', String(cn2));

    const s3 = require('node:tls').connect({ port: P_TLS, host: '127.0.0.1', rejectUnauthorized: false });
    const cn3 = await new Promise(r => { s3.on('secureConnect', () => { const c = s3.getPeerCertificate(); s3.destroy(); r(c.subject && c.subject.CN); }); s3.on('error', () => r('ERR')); });
    ok('无 SNI 时回退默认证书（CN 为 localhost）', cn3 === 'localhost', String(cn3));
  }

  // ===== 六、HTTP/2（含 ALPN 兼容 h1）=====
  ok('h2 静态路由', (await h2req(P_H2, '/biz/static')).body === 'H2|bs');
  ok('h2 参数路由', (await h2req(P_H2, '/biz/66')).body === 'H2|bp|66');
  ok('h2 分组二级', (await h2req(P_H2, '/grp/sub/y/mm')).body === 'H2|grp2|mm|/grp/sub');
  ok('h2 多余斜杠', (await h2req(P_H2, '//biz///77')).body === 'H2|bp|77');
  ok('h2 端口上的 h1 回退（ALPN）', (await h1(P_H2, '/biz/static', { tls: true })).body === 'H2|bs');

  // ===== 七、三实例并发交错 =====
  {
    const jobs = [];
    for (let i = 0; i < 300; i++) {
      jobs.push(h1(P_H1, `/biz/${i}`).then(r => r.body === `H1|bp|${i}`));
      jobs.push(h1(P_TLS, `/biz/${i}`, { tls: true }).then(r => r.body === `TLS|bp|${i}`));
      jobs.push(h2req(P_H2, `/biz/${i}`).then(r => r.body === `H2|bp|${i}`));
      jobs.push(h1(P_H1, `/grp/p/${i}`).then(r => r.body === `H1|grpp|${i}`));
      jobs.push(h1(P_H1, '/api/x' + i, { headers: { host: `a.com:${P_H1}` } })
        .then(r => r.body === `BK|GET|/api/x${i}|`));
    }
    const res = await Promise.all(jobs);
    const bad = res.filter(x => !x).length;
    ok(`三实例三协议并发交错 ${jobs.length} 个请求全部正确`, bad === 0, bad ? `${bad} 个错误` : null);
  }

  // ===== 八、无兜底代理的实例上，未注册路径确实 404 =====
  {
    const clean = new Topbit({ parseBody: false, debug: false });
    clean.get('/only/:x', async c => { c.data = 'only'; });
    clean.run(48004);
    await new Promise(r => setTimeout(r, 200));
    ok('无兜底代理时未注册路径 → 404', (await h1(48004, '/nope/zz')).code === 404);
    ok('无兜底代理时已注册路径正常', (await h1(48004, '/only/1')).body === 'only');
  }

  console.log(`\ntest-integration-app: ${failed === 0 ? '全部通过' : failed + ' 项失败'}`);
  process.exit(failed === 0 ? 0 : 1);
}, 800);
