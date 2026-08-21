'use strict';

// 中间件链行为契约。任何对 midcore/middleware 的改动都必须让本测试保持通过。
// 覆盖：洋葱顺序、pre 与 use 的次序、method/name/双过滤、分组、短路、
//       中间件与路由回调抛错、rejected promise、回程改写 data、
//       content-type 自动推断、404、并发正确性。
// 用法: node test/test-midware-contract.js

const assert = require('node:assert');
const http = require('node:http');
const Topbit = require('../src/topbit.js');

const PORT = 41041;
const errs = [];

const app = new Topbit({
  parseBody: false,
  debug: false,
  errorHandle: (err, name) => errs.push(`${name}|${err && err.message}`)
});

const trace = [];

app.use(async (c, next) => { trace.push('g1-in'); await next(c); trace.push('g1-out'); });

app.use(async (c, next) => {
  trace.push('g2-in');
  await next(c);
  trace.push('g2-out');
  if (c.path === '/mutate') c.data = String(c.data) + '|g2-appended';
});

app.use(async (c, next) => { trace.push('only-POST'); return await next(c); }, { method: 'POST' });
app.use(async (c, next) => { trace.push('only-named'); return await next(c); }, { name: ['nGet', 'nPost'] });
app.use(async (c, next) => { trace.push('POST+named'); return await next(c); },
        { method: 'POST', name: ['nGet', 'nPost'] });

// pre 先注册先执行
app.pre(async (c, next) => { trace.push('pre1'); return await next(c); });
app.pre(async (c, next) => { trace.push('pre2'); return await next(c); });

app.use(async (c, next) => { trace.push('grp-mid'); return await next(c); }, '@mygrp');

// 短路与抛错的中间件
app.use(async (c, next) => {
  if (c.path === '/midthrow') { trace.push('mid-throw'); throw new Error('mid-boom'); }
  if (c.path === '/short')    { trace.push('short'); c.data = 'SHORT'; return; }
  return await next(c);
});

app.get('/ok',     async c => { trace.push('handler'); c.data = 'OK'; });
app.get('/mutate', async c => { trace.push('handler'); c.data = 'BASE'; });
app.get('/named',  async c => { trace.push('handler'); c.data = 'NAMED'; }, 'nGet');
app.post('/namedp',async c => { trace.push('handler'); c.data = 'NAMED-POST'; }, 'nPost');
app.get('/throw',  async c => { trace.push('handler'); throw new Error('handler-boom'); });
app.get('/reject', async c => { trace.push('handler'); return Promise.reject(new Error('handler-reject')); });
app.get('/grp/x',  async c => { trace.push('handler'); c.data = 'GRP'; }, '@mygrp');
app.get('/nodata', async c => { trace.push('handler'); });
app.get('/json',   async c => { trace.push('handler'); c.data = { a: 1, b: [2, 3] }; });
app.get('/num',    async c => { trace.push('handler'); c.data = 42; });
app.get('/midthrow', async c => { trace.push('SHOULD-NOT-RUN'); });
app.get('/short',    async c => { trace.push('SHOULD-NOT-RUN'); });

app.run(PORT);

// agent:false —— 每个请求独立连接，避免 404 分支销毁连接影响后续用例
function req(method, path) {
  return new Promise(resolve => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path, method, agent: false }, res => {
      let d = '';
      res.on('data', x => d += x);
      res.on('end', () => resolve({ code: res.statusCode, ct: res.headers['content-type'] || '-', body: d }));
    });
    r.on('error', e => resolve({ code: 'ERR', ct: '-', body: e.message }));
    r.end();
  });
}

const ONION = 'pre1>pre2>g1-in>g2-in';
const OUT   = 'g2-out>g1-out';

const cases = [
  { m: 'GET',  p: '/ok',     code: 200, ct: 'text/plain;charset=utf-8',       body: 'OK',
    trace: `${ONION}>handler>${OUT}`, desc: '基本洋葱：去程 pre→全局，回程逆序' },

  { m: 'GET',  p: '/mutate', code: 200, ct: 'text/plain;charset=utf-8',       body: 'BASE|g2-appended',
    trace: `${ONION}>handler>${OUT}`, desc: '回程可改写 c.data' },

  { m: 'GET',  p: '/named',  code: 200, ct: 'text/plain;charset=utf-8',       body: 'NAMED',
    trace: `${ONION}>only-named>handler>${OUT}`, desc: 'name 过滤命中，method 过滤不命中' },

  { m: 'POST', p: '/namedp', code: 200, ct: 'text/plain;charset=utf-8',       body: 'NAMED-POST',
    trace: `${ONION}>only-POST>only-named>POST+named>handler>${OUT}`,
    desc: 'method / name / 双过滤三者同时命中' },

  { m: 'GET',  p: '/grp/x',  code: 200, ct: 'text/plain;charset=utf-8',       body: 'GRP',
    trace: `${ONION}>grp-mid>handler>${OUT}`, desc: '分组中间件只对该分组生效' },

  { m: 'GET',  p: '/nodata', code: 200, ct: '-',                              body: '',
    trace: `${ONION}>handler>${OUT}`, desc: '无 data 时空响应且不设 content-type' },

  { m: 'GET',  p: '/json',   code: 200, ct: 'application/json;charset=utf-8', body: '{"a":1,"b":[2,3]}',
    trace: `${ONION}>handler>${OUT}`, desc: 'object 自动 JSON 序列化并设 content-type' },

  { m: 'GET',  p: '/num',    code: 200, ct: '-',                              body: '42',
    trace: `${ONION}>handler>${OUT}`, desc: 'number 转字符串输出' },

  { m: 'GET',  p: '/short',  code: 200, ct: 'text/plain;charset=utf-8',       body: 'SHORT',
    trace: `${ONION}>short>${OUT}`, desc: '中间件不调 next 时短路，回程仍执行' },

  { m: 'GET',  p: '/midthrow', code: 500, ct: '-',                            body: '',
    trace: `${ONION}>mid-throw`, desc: '中间件抛错 → 500，回程不执行' },

  { m: 'GET',  p: '/throw',  code: 500, ct: '-',                              body: '',
    trace: `${ONION}>handler`, desc: '路由回调抛错 → 500' },

  { m: 'GET',  p: '/reject', code: 500, ct: '-',                              body: '',
    trace: `${ONION}>handler`, desc: '路由回调返回 rejected promise → 500' },

  { m: 'GET',  p: '/nope',   code: 404, ct: '-',                              body: 'not found',
    trace: '', desc: '路由未命中 → 404，中间件链不执行' },

  { m: 'POST', p: '/ok',     code: 404, ct: '-',                              body: 'not found',
    trace: '', desc: '方法不匹配 → 404' }
];

setTimeout(async () => {
  let failed = 0;

  for (const t of cases) {
    trace.length = 0;
    const r = await req(t.m, t.p);
    const got = trace.join('>');

    const ok = r.code === t.code && r.ct === t.ct && r.body === t.body && got === t.trace;
    if (!ok) failed++;

    console.log(`${ok ? 'PASS' : 'FAIL'} ${t.desc}`);
    if (!ok) {
      console.log(`     期望 ${t.code} ${t.ct} ${JSON.stringify(t.body)} trace=${t.trace}`);
      console.log(`     实际 ${r.code} ${r.ct} ${JSON.stringify(r.body)} trace=${got}`);
    }
  }

  // errorHandle 收到了三次错误，且 message 正确
  const wanted = ['--ERR-res--|mid-boom', '--ERR-res--|handler-boom', '--ERR-res--|handler-reject'];
  for (const w of wanted) {
    const ok = errs.includes(w);
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'} errorHandle 收到 ${w}`);
  }

  // 并发下每个请求拿到自己的响应
  const conc = await Promise.all(Array.from({ length: 30 }, () => req('GET', '/json')));
  const same = new Set(conc.map(x => `${x.code}:${x.body}`)).size === 1 && conc[0].body === '{"a":1,"b":[2,3]}';
  if (!same) failed++;
  console.log(`${same ? 'PASS' : 'FAIL'} 并发 30 请求各自响应正确`);

  console.log(`\ntest-midware-contract: ${failed === 0 ? '全部通过' : failed + ' 项失败'}`);
  process.exit(failed === 0 ? 0 : 1);
}, 400);
