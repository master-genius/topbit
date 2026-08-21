'use strict';

// 路由路径匹配契约。findPath 用一遍扫描记录段起止（连续 / 天然跳过），
// 静态段用 startsWith 就地比对不物化子串，只有参数段才 slice。
// 本测试固化匹配语义，任何对 findPath 的改动都必须让它保持通过。
// 用法: node test/test-router-path-scan.js

const assert = require('node:assert');
const Router = require('../src/router.js');

const r = new Router();
const ROUTES = [
  ['GET', '/'], ['GET', '/api'], ['GET', '/api/:uid'], ['GET', '/api/user/:id'],
  ['GET', '/api/v1/order/:oid/item/:iid'], ['GET', '/a/b/:c'], ['GET', '/a/:b/c/:d/e/:f'],
  ['GET', '/blog/:year/:month/:day/:slug'], ['GET', '/static/*'], ['GET', '/a/b/*'],
  ['GET', '/assets/js/*'], ['GET', '/*'],
  ['POST', '/api/:uid'], ['PUT', '/api/:uid/edit'], ['DELETE', '/api/:uid']
];
for (const [m, p] of ROUTES) r.addPath(p, m, async c => {});
r.argsRouteSort();

function got(path, method = 'GET') {
  const x = r.findRealPath(path, method);
  return x === null ? null : { key: x.key, args: x.args };
}

let failed = 0;
function check(desc, path, expect, method = 'GET') {
  let ok;
  try {
    assert.deepStrictEqual(got(path, method), expect);
    ok = true;
  } catch (e) {
    ok = false;
  }
  if (!ok) { failed++; console.log(`FAIL ${desc}`); console.log(`     ${method} ${JSON.stringify(path)}`);
    console.log(`     期望 ${JSON.stringify(expect)}`); console.log(`     实际 ${JSON.stringify(got(path, method))}`); }
  else console.log(`PASS ${desc}`);
}

// ---- 连续斜杠：多余的 / 必须被跳过，等价于旧的 filter 行为 ----
check('连续斜杠开头 + 中间',    '///api/123///3324', { key: '/*', args: { starPath: '//api/123///3324' } });
check('中间双斜杠不影响匹配',   '/api///user/345',   { key: '/api/user/:id', args: { id: '345' } });
check('多处连续斜杠 + 参数',    '/a//b///c/x/e/z',   { key: '/a/:b/c/:d/e/:f', args: { b: 'b', d: 'x', f: 'z' } });
// findRealPath 在 ignoreSlash 下会先去掉一个末尾斜杠，再进入匹配
check('// 去尾斜杠后精确命中 /', '//',               { key: '/', args: {} });
check('/// 无实际段落到 /*',     '///',              { key: '/*', args: { starPath: '/' } });
check('首尾都有多余斜杠',        '//a//',            { key: '/*', args: { starPath: '/a/' } });

// ---- starPath 取自原始路径，保留多余斜杠 ----
check('星号余段保留原始形态',   '/static//a.css',    { key: '/static/*', args: { starPath: '/a.css' } });
check('星号余段正常',           '/static/a/b.css',   { key: '/static/*', args: { starPath: 'a/b.css' } });
check('星号前缀恰好用完',       '/static',           { key: '/static/*', args: { starPath: '' } });

// ---- 参数提取 ----
check('单参数',                 '/api/123',          { key: '/api/:uid', args: { uid: '123' } });
check('多参数',                 '/api/v1/order/A1/item/B2',
      { key: '/api/v1/order/:oid/item/:iid', args: { oid: 'A1', iid: 'B2' } });
check('四参数',                 '/blog/2026/08/21/hello-world',
      { key: '/blog/:year/:month/:day/:slug', args: { year: '2026', month: '08', day: '21', slug: 'hello-world' } });

// ---- 方法隔离 ----
check('POST 走自己的表',        '/api/123', { key: '/api/:uid', args: { uid: '123' } }, 'POST');
check('PUT 深一层',             '/api/9/edit', { key: '/api/:uid/edit', args: { uid: '9' } }, 'PUT');
check('PATCH 无对应路由',       '/api/123', null, 'PATCH');

// ---- 排序语义：参数路由优先于星号，星号之间更长的优先（C5 的路径降级依赖此语义）----
check('参数路由优先于星号',     '/a/b/zzz',   { key: '/a/b/:c', args: { c: 'zzz' } });
check('段数不符时落到星号',     '/a/b/c/d',   { key: '/a/b/*', args: { starPath: 'c/d' } });
check('更长的星号优先于 /*',    '/a/b/c/d/e', { key: '/a/b/*', args: { starPath: 'c/d/e' } });

// ---- 深度上限：多余斜杠不计入真实段数 ----
check('13 段恰好允许',          '/a/b/c/d/e/f/g/h/i/j/k/l/m',
      { key: '/a/b/*', args: { starPath: 'c/d/e/f/g/h/i/j/k/l/m' } });
check('14 段超出 maxDepth',     '/a/b/c/d/e/f/g/h/i/j/k/l/m/n', null);
// 关键：多余斜杠不计入真实段数，40 个斜杠仍然只是 a/b/c 三段
check('大量多余斜杠不计入段数',  '/a/b' + '/'.repeat(40) + 'c',
      { key: '/a/b/:c', args: { c: 'c' } });
check('50 个斜杠无实际段',      '/'.repeat(50), { key: '/*', args: { starPath: '/'.repeat(48) } });

console.log(`\ntest-router-path-scan: ${failed === 0 ? '全部通过' : failed + ' 项失败'}`);
process.exit(failed === 0 ? 0 : 1);
