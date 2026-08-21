'use strict';

// 分组 / 路由前缀 / 子应用中间件 的行为契约。
// 这些能力最终都落到 findPath 与中间件链上，故对二者的任何优化都必须让本测试通过。
// 用法: node test/test-group-prefix.js

const http = require('node:http');
const Topbit = require('../src/topbit.js');

const PORT = 42011;
const trace = [];
const app = new Topbit({ parseBody: false, debug: false });

app.use(async (c, next) => { trace.push('global'); return await next(c); });

// 一级分组：前缀 /api
const sub = app.group('/api');
sub.pre(async (c, next) => { trace.push('api-pre'); return await next(c); });
sub.get('/t', async c => { trace.push('h:t'); c.data = `t|${c.group}|${c.path}`; });
sub.get('/u/:id', async c => { trace.push('h:u'); c.data = `u|${c.param.id}|${c.group}`; });
sub.get('/f/*', async c => { trace.push('h:f'); c.data = `f|${c.param.starPath}`; });
sub.post('/t', async c => { trace.push('h:post-t'); c.data = 'post-t'; });

// 二级分组：/api/sub
const subsub = sub.group('/sub');
subsub.pre(async (c, next) => { trace.push('sub2-pre'); return await next(c); });
subsub.get('/deep', async c => { trace.push('h:deep'); c.data = `deep|${c.group}`; });
subsub.get('/p/:a/:b', async c => { trace.push('h:dp'); c.data = `dp|${c.param.a}|${c.param.b}`; });

// middleware([...]).group() 形式
const ar = app.middleware([
  async (c, next) => { trace.push('ar1'); return await next(c); },
  async (c, next) => { trace.push('ar2'); return await next(c); }
], { pre: true }).group('/ar');
ar.get('/test', async c => { trace.push('h:ar'); c.data = `ar|${c.group}`; });
ar.get('/w/:k', async c => { trace.push('h:arw'); c.data = `arw|${c.param.k}`; });

// 命名分组中间件（@名字形式）
app.get('/plain', async c => { trace.push('h:plain'); c.data = 'plain'; }, '@mygrp');
app.use(async (c, next) => { trace.push('mygrp-mid'); return await next(c); }, '@mygrp');

app.get('/*', async c => { trace.push('h:all'); c.data = `all|${c.param.starPath}`; });

app.run(PORT);

function req(method, path) {
  return new Promise(r => {
    const q = http.request({ host: '127.0.0.1', port: PORT, path, method, agent: false }, res => {
      let d = ''; res.on('data', x => d += x);
      res.on('end', () => r({ code: res.statusCode, body: d }));
    });
    q.on('error', e => r({ code: 'ERR', body: e.message }));
    q.end();
  });
}

const CASES = [
  { m: 'GET',  p: '/api/t',            body: 't|/api|/api/t',   trace: 'api-pre>global>h:t',
    desc: '分组前缀 + 分组内 pre 中间件先于全局中间件' },
  { m: 'POST', p: '/api/t',            body: 'post-t',          trace: 'api-pre>global>h:post-t',
    desc: '同路径不同方法各自注册' },
  { m: 'GET',  p: '/api/u/9527',       body: 'u|9527|/api',     trace: 'api-pre>global>h:u',
    desc: '分组内参数路由，ctx.group 为分组名' },
  { m: 'GET',  p: '/api/f/x/y/z.png',  body: 'f|x/y/z.png',     trace: 'api-pre>global>h:f',
    desc: '分组内星号路由，starPath 为余段' },
  { m: 'GET',  p: '/api/sub/deep',     body: 'deep|/api/sub',   trace: 'sub2-pre>global>h:deep',
    desc: '二级分组前缀叠加，只跑本级 pre' },
  { m: 'GET',  p: '/api/sub/p/AA/BB',  body: 'dp|AA|BB',        trace: 'sub2-pre>global>h:dp',
    desc: '二级分组内多参数路由' },
  { m: 'GET',  p: '/ar/test',          body: 'ar|/ar',          trace: 'ar1>ar2>global>h:ar',
    desc: 'middleware([...]).group() 的中间件按数组顺序执行' },
  { m: 'GET',  p: '/ar/w/kk',          body: 'arw|kk',          trace: 'ar1>ar2>global>h:arw',
    desc: 'middleware 分组内参数路由' },
  { m: 'GET',  p: '/plain',            body: 'plain',           trace: 'global>mygrp-mid>h:plain',
    desc: '@名字分组中间件只对该分组生效' },
  { m: 'GET',  p: '/other/thing',      body: 'all|other/thing', trace: 'global>h:all',
    desc: '未命中分组则落到全局星号路由' },

  // 连续斜杠：参数与星号路由（走 findPath）容忍多余斜杠
  { m: 'GET',  p: '/api///u///9527',   body: 'u|9527|/api',     trace: 'api-pre>global>h:u',
    desc: '分组内参数路由容忍连续斜杠' },
  { m: 'GET',  p: '///api/sub///p/A//B', body: 'dp|A|B',        trace: 'sub2-pre>global>h:dp',
    desc: '二级分组参数路由容忍连续斜杠' },

  // 静态路由同样容忍多余斜杠：归一化后重查精确表，优先级高于参数/星号路由
  { m: 'GET',  p: '//api//t',          body: 't|/api|//api//t', trace: 'api-pre>global>h:t',
    desc: '分组内静态路由容忍连续斜杠' },
  { m: 'GET',  p: '/ar//test',         body: 'ar|/ar',          trace: 'ar1>ar2>global>h:ar',
    desc: 'middleware 分组的静态路由同样容忍' }
];

setTimeout(async () => {
  let failed = 0;

  for (const t of CASES) {
    trace.length = 0;
    const r = await req(t.m, t.p);
    const got = trace.join('>');
    const ok = r.code === 200 && r.body === t.body && got === t.trace;
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${t.desc}`);
    if (!ok) {
      console.log(`     ${t.m} ${t.p}`);
      console.log(`     期望 body=${JSON.stringify(t.body)} trace=${t.trace}`);
      console.log(`     实际 ${r.code} body=${JSON.stringify(r.body)} trace=${got}`);
    }
  }

  // 分组表内容
  const g = app.router.getGroup();
  const keys = Object.keys(g).sort().join(',');
  const okg = keys === '/api,/api/sub,/ar,mygrp';
  if (!okg) failed++;
  console.log(`${okg ? 'PASS' : 'FAIL'} 分组表登记了全部分组: ${keys}`);

  const apiRoutes = g['/api'].map(x => `${x.method} ${x.path}`).sort().join(' | ');
  const oka = apiRoutes === 'GET /api/f/* | GET /api/t | GET /api/u/:id | POST /api/t';
  if (!oka) failed++;
  console.log(`${oka ? 'PASS' : 'FAIL'} 分组内路由带上了前缀: ${apiRoutes}`);

  console.log(`\ntest-group-prefix: ${failed === 0 ? '全部通过' : failed + ' 项失败'}`);
  process.exit(failed === 0 ? 0 : 1);
}, 400);
