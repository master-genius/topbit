'use strict';

// 请求方法名取自网络（HTTP/2 的 :method 伪头可以是任意字符串），
// 以它为键取表时，'constructor' 之类的名字会取到 Object.prototype 上的函数而不是
// undefined，在 findPath 中解引用时抛出 TypeError（HTTP/2 下为未捕获异常，会拖垮进程）。
// 因此入口闸门 apiTable 必须是无原型对象。
// 用法: node test/test-router-method-guard.js

const assert = require('node:assert');
const Router = require('../src/router.js');

let failed = 0;
function check(desc, actual, expect) {
  let ok;
  try { assert.deepStrictEqual(actual, expect); ok = true; } catch (e) { ok = false; }
  if (!ok) {
    failed++;
    console.log(`FAIL ${desc}`);
    console.log(`     期望 ${JSON.stringify(expect)}`);
    console.log(`     实际 ${JSON.stringify(actual)}`);
  } else console.log(`PASS ${desc}`);
}

// 无论是否抛错都收敛成可比较的值
function probe(r, path, method) {
  try { return r.findRealPath(path, method); } catch (e) { return `THROW ${e.message}`; }
}

const PROTO_KEYS = [
  'constructor', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable',
  'toString', 'toLocaleString', 'valueOf', '__proto__',
  '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__'
];

function build(sorted) {
  const r = new Router();
  r.get('/a/b', async c => {});
  r.get('/u/:id', async c => {});
  r.get('/s/*', async c => {});
  sorted && r.argsRouteSort();
  return r;
}

// ============ 一、原型键作为方法名：一律 null，不抛错 ============
for (const sorted of [true, false]) {
  const r = build(sorted);
  const tag = sorted ? '已排序' : '未排序';

  for (const m of PROTO_KEYS) {
    check(`${tag} 方法名 ${m} + 静态路径`, probe(r, '/a/b', m), null);
    check(`${tag} 方法名 ${m} + 参数路径`, probe(r, '/u/1', m), null);
    check(`${tag} 方法名 ${m} + 星号路径`, probe(r, '/s/x/y', m), null);
  }
}

// ============ 二、闸门表无原型；findPath 单独调用同样受保护 ============
{
  const t = build(true);
  check('apiTable 无原型', Object.getPrototypeOf(t.apiTable), null);
  t.clear();
  check('clear() 后 apiTable 仍无原型', Object.getPrototypeOf(t.apiTable), null);
}
{
  const r = build(true);
  for (const m of PROTO_KEYS) {
    let res;
    try { res = r.findPath('/u/1', m); } catch (e) { res = `THROW ${e.message}`; }
    check(`findPath 直接调用 方法名 ${m}`, res, null);
  }
}

// ============ 三、正常方法不受影响 ============
{
  const r = build(true);
  check('GET 静态', probe(r, '/a/b', 'GET').key, '/a/b');
  check('GET 参数', probe(r, '/u/9', 'GET').args, { id: '9' });
  check('GET 星号', probe(r, '/s/x/y', 'GET').args, { starPath: 'x/y' });
  check('未注册的 POST', probe(r, '/a/b', 'POST'), null);
  check('methods 列表完整', r.methods, ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH', 'TRACE']);
}

if (failed > 0) {
  console.log(`\ntest-router-method-guard: ${failed} 项失败`);
  process.exit(1);
}
console.log('\ntest-router-method-guard: 全部通过');
