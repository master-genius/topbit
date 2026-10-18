'use strict';

// 参数路由的模式冲突检测契约：
// 同一方法下，参数个数与位置相同、静态段相同的两条参数路由视为冲突（参数名不同也冲突）。
// 冲突检测必须只依赖「已成功注册」的路由：注册中途失败（命名重复等）不能留下痕迹，
// clear() 之后必须能重新注册。
// 用法: node test/test-router-conflict.js

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

const f = async c => {};

// 返回抛出的错误文案，不抛返回 null；console.error 的红字提示在测试里静音
function tryAdd(r, path, method = 'GET', name = '') {
  const orig = console.error;
  console.error = () => {};
  try { r.addPath(path, method, f, name); return null; }
  catch (e) { return e.message; }
  finally { console.error = orig; }
}

// ============ 一、冲突判定 ============
{
  const r = new Router();
  check('首条参数路由可注册', tryAdd(r, '/u/:id'), null);
  check('参数名不同、结构相同 → 冲突，文案含新旧路由',
    tryAdd(r, '/u/:name'), '/u/:name 和 /u/:id模式一致，存在冲突。');
  check('完全相同的参数路由 → 冲突', tryAdd(r, '/u/:id'), '/u/:id 和 /u/:id模式一致，存在冲突。');
  check('参数个数不同 → 不冲突', tryAdd(r, '/u/:id/:sub'), null);
  check('参数与静态段 → 不冲突', tryAdd(r, '/u/list'), null);
  check('参数位置不同 → 不冲突', tryAdd(r, '/u/:id/x'), null);
  check('归一化后相同（多余斜杠）→ 冲突', tryAdd(r, '//u//:v//'), '/u/:v 和 /u/:id模式一致，存在冲突。');
  check('不同方法互不影响', tryAdd(r, '/u/:id', 'POST'), null);
  check('同方法不同前缀 → 不冲突', tryAdd(r, '/w/:id'), null);
}

// ============ 二、星号路由不参与冲突检测（现状契约） ============
{
  const r = new Router();
  check('星号路由可注册', tryAdd(r, '/p/*'), null);
  check('同前缀参数路由不与星号冲突', tryAdd(r, '/p/:a'), null);
  check('两条不同星号路由', tryAdd(r, '/p/q/*'), null);
}

// ============ 三、失败的注册不留痕迹 ============
{
  const r = new Router();
  check('带命名注册', tryAdd(r, '/n/:a', 'GET', 'nm'), null);
  check('命名重复 → 注册失败', tryAdd(r, '/m/:b', 'GET', 'nm'), '路由命名nm 已经存在。');
  check('失败后同结构路由仍可注册（未被记入）', tryAdd(r, '/m/:c'), null);
  check('非法路由字符串 → 注册失败', typeof tryAdd(r, '/k/:'), 'string');
  check('失败后同结构路由仍可注册（非法串）', tryAdd(r, '/k/:ok'), null);
}

// ============ 四、clear() 之后可重新注册 ============
{
  const r = new Router();
  check('首次注册', tryAdd(r, '/u/:id'), null);
  check('冲突', typeof tryAdd(r, '/u/:x'), 'string');
  r.clear();
  check('clear 后同结构路由可重新注册', tryAdd(r, '/u/:id'), null);
  check('clear 后冲突检测仍然有效', typeof tryAdd(r, '/u/:y'), 'string');
}

if (failed > 0) {
  console.log(`\ntest-router-conflict: ${failed} 项失败`);
  process.exit(1);
}
console.log('\ntest-router-conflict: 全部通过');
