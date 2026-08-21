'use strict';

// 路由优先级与排序契约。argsRouteSort 的排序规则与 findPath 的线性扫描共同决定
// 「哪条路由先被选中」，代理扩展的跨 host 路径降级（pathFallback）也依赖「最长星号
// 优先」这一条。任何触及 addPath / argsRouteSort / findPath / findRealPath 的改动，
// 都必须让本测试保持通过。
// 用法: node test/test-route-order.js

const assert = require('node:assert');
const Topbit = require('../src/topbit.js');

const app = new Topbit();

// —— 同一位置同时存在多种形态，用于验证优先级 ——
app.get('/p/fixed',        async c => {});   // 静态
app.get('/p/:one',         async c => {});   // 一个参数
app.get('/p/*',            async c => {});   // 星号

app.get('/q/a/b/c',        async c => {});   // 静态，三段
app.get('/q/a/b/:x',       async c => {});   // 一个参数
app.get('/q/a/:y/:x',      async c => {});   // 两个参数
app.get('/q/:z/:y/:x',     async c => {});   // 三个参数

app.get('/s/a/b/c/*',      async c => {});   // 四段星号（最长）
app.get('/s/a/b/*',        async c => {});   // 三段星号
app.get('/s/a/*',          async c => {});   // 两段星号
app.get('/s/*',            async c => {});   // 一段星号

app.get('/m/only-get',     async c => {});
app.post('/m/only-post',   async c => {});

app.router.argsRouteSort();

function key(path, method = 'GET') {
  const r = app.router.findRealPath(path, method);
  return r === null ? null : r.key;
}
function args(path, method = 'GET') {
  const r = app.router.findRealPath(path, method);
  return r === null ? null : r.args;
}

let failed = 0;
function check(desc, actual, expect) {
  let ok;
  try { assert.deepStrictEqual(actual, expect); ok = true; } catch (e) { ok = false; }
  if (!ok) { failed++; console.log(`FAIL ${desc}`); console.log(`     期望 ${JSON.stringify(expect)}  实际 ${JSON.stringify(actual)}`); }
  else console.log(`PASS ${desc}`);
}

// ---- 优先级 1：静态 > 参数 > 星号 ----
check('静态路由优先于参数与星号', key('/p/fixed'), '/p/fixed');
check('参数路由优先于星号',       key('/p/other'), '/p/:one');
check('段数不符时才落到星号',     key('/p/a/b'),   '/p/*');

// ---- 优先级 2：参数越少（静态段越多）越优先 ----
check('三段全静态最优先',   key('/q/a/b/c'),   '/q/a/b/c');
check('一个参数次之',       key('/q/a/b/zz'),  '/q/a/b/:x');
check('两个参数再次之',     key('/q/a/yy/zz'), '/q/a/:y/:x');
check('三个参数最后',       key('/q/xx/yy/zz'),'/q/:z/:y/:x');
check('参数值提取正确',     args('/q/xx/yy/zz'), { z: 'xx', y: 'yy', x: 'zz' });

// ---- 优先级 3：星号之间，静态前缀越长越优先（代理路径降级依赖此规则）----
check('四段星号优先', key('/s/a/b/c/zzz'), '/s/a/b/c/*');
check('三段星号次之', key('/s/a/b/zzz'),   '/s/a/b/*');
check('两段星号再次', key('/s/a/zzz'),     '/s/a/*');
check('一段星号兜底', key('/s/zzz'),       '/s/*');
check('星号可匹配空余段', key('/s/a/b/c'), '/s/a/b/c/*');
check('星号余段提取',     args('/s/a/b/c/x/y'), { starPath: 'x/y' });

// ---- 方法隔离 ----
check('GET 路由不被 POST 命中',  key('/m/only-get', 'POST'), null);
check('POST 路由不被 GET 命中',  key('/m/only-post', 'GET'), null);
check('各自方法正常命中',        key('/m/only-get', 'GET'),  '/m/only-get');

// ---- 多余斜杠不改变优先级 ----
check('多余斜杠下静态仍优先',   key('//p//fixed'),    '/p/fixed');
check('多余斜杠下参数仍优先',   key('//p//other'),    '/p/:one');
check('多余斜杠下最长星号优先', key('//s//a//b//c//zzz'), '/s/a/b/c/*');
check('多余斜杠下参数值正确',   args('/q//xx///yy//zz'), { z: 'xx', y: 'yy', x: 'zz' });

// ---- argsRoute 排序结果本身 ----
const order = app.router.argsRoute.GET.map(r => r.path);
const idx = p => order.indexOf(p);
check('排序：参数路由排在星号之前',
  idx('/q/:z/:y/:x') < idx('/s/*'), true);
check('排序：星号按静态前缀长度降序',
  idx('/s/a/b/c/*') < idx('/s/a/b/*') && idx('/s/a/b/*') < idx('/s/a/*') && idx('/s/a/*') < idx('/s/*'),
  true);
check('排序：参数路由按参数个数升序',
  idx('/q/a/b/:x') < idx('/q/a/:y/:x') && idx('/q/a/:y/:x') < idx('/q/:z/:y/:x'),
  true);

console.log(`\ntest-route-order: ${failed === 0 ? '全部通过' : failed + ' 项失败'}`);
process.exit(failed === 0 ? 0 : 1);
