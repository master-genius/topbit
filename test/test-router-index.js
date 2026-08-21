'use strict';

// 路由前缀索引（argsIndex / argsDyn）的正确性契约。
// 索引是在 argsRoute 之上额外建立的加速结构，必须做到「完全无感知」：
// 任何路由表、任何路径下的匹配结果都必须与不使用索引时逐字节一致。
// 用法: node test/test-router-index.js

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

function build(routes) {
  const r = new Router();
  for (const [m, p] of routes) r.addPath(p, m, async c => {});
  r.argsRouteSort();
  return r;
}
const paths = list => list.map(x => x.path);

// ============ 一、索引结构：内容与顺序 ============
{
  const R = build([
    ['GET', '/api/user/:id'], ['GET', '/api/user/list/*'], ['GET', '/api/order/:id'],
    ['GET', '/api/:res/count'], ['GET', '/static/*'], ['GET', '/*']
  ]);

  // 排序后的全序列，后面所有桶都必须是它的子序列
  const all = paths(R.argsRoute.GET);
  check('全序列按优先级排序（参数在前、星号按前缀长度降序）', all,
    ['/api/user/:id', '/api/order/:id', '/api/:res/count', '/api/user/list/*', '/static/*', '/*']);

  check('argsDyn 只含首段可通配的路由', paths(R.argsDyn.GET), ['/*']);
  check('索引桶键为出现过的首段字面量', Object.keys(R.argsIndex.GET).sort(), ['api', 'static']);

  check('api 桶 = 首段为 api 的 + 首段可通配的，且保持全序列顺序',
    paths(R.argsIndex.GET['api'].list),
    ['/api/user/:id', '/api/order/:id', '/api/:res/count', '/api/user/list/*', '/*']);

  check('static 桶同理', paths(R.argsIndex.GET['static'].list), ['/static/*', '/*']);

  // 仅 5 条，低于阈值 20，不建第二层
  check('桶小于阈值时不建第二层', R.argsIndex.GET['api'].sub, null);
  check('未建第二层时 subDyn 为 null', R.argsIndex.GET['api'].subDyn, null);
}

// ============ 二、第二层结构 ============
{
  const routes = [['GET', '/*']];
  // 24 个资源，第二段分散，触发建二层
  for (let i = 0; i < 24; i++) routes.push(['GET', `/api/res${i}/:id`]);
  routes.push(['GET', '/api/:any/count']);          // 第二段可通配
  const R = build(routes);
  const node = R.argsIndex.GET['api'];

  check('桶达到阈值且切得动时建第二层', node.sub !== null, true);
  check('subDyn 只含第二段可通配的', paths(node.subDyn).sort(), ['/*', '/api/:any/count']);
  check('子桶 = 第二段匹配的 + 第二段可通配的',
    paths(node.sub['res7']).sort(), ['/*', '/api/:any/count', '/api/res7/:id']);
  check('子桶键覆盖全部第二段字面量', Object.keys(node.sub).length, 24);

  // 子桶必须是父桶的子序列
  const parent = paths(node.list);
  let subseqOk = true;
  for (const k of Object.keys(node.sub)) {
    const sub = paths(node.sub[k]);
    let j = 0;
    for (const x of sub) { while (j < parent.length && parent[j] !== x) j++; if (j >= parent.length) { subseqOk = false; break; } j++; }
    if (!subseqOk) break;
  }
  check('每个子桶都是父桶的子序列', subseqOk, true);
}

// ============ 三、阈值行为 ============
{
  // 刚好 19 条（含 /*）不建，20 条建
  function mk(n) {
    const routes = [['GET', '/*']];
    for (let i = 0; i < n; i++) routes.push(['GET', `/api/res${i}/:id`]);
    return build(routes).argsIndex.GET['api'];
  }
  check('桶内 19 条不建第二层', mk(18).sub, null);
  check('桶内 20 条建第二层', mk(19).sub !== null, true);

  // 第二段全是参数：切不动，不建
  const routes2 = [['GET', '/*']];
  for (let i = 0; i < 40; i++) routes2.push(['GET', `/api/:id/act${i}`]);
  check('第二段全可通配（切不动）时不建第二层', build(routes2).argsIndex.GET['api'].sub, null);

  // 第二段一半可通配：正好在边界上，不建
  const routes3 = [];
  for (let i = 0; i < 15; i++) routes3.push(['GET', `/api/res${i}/:id`]);
  for (let i = 0; i < 15; i++) routes3.push(['GET', `/api/:p/act${i}`]);
  const n3 = build(routes3).argsIndex.GET['api'];
  check('第二段可通配占比恰好一半时仍建（<=）', n3.sub !== null, true);
}

// ============ 四、回退路径 ============
{
  // 未调用 argsRouteSort：索引未建，必须回退到全量数组且结果正确
  const r = new Router();
  r.addPath('/api/:id', 'GET', async c => {});
  r.addPath('/*', 'GET', async c => {});
  const got = r.findRealPath('/api/9', 'GET');
  check('未调用 argsRouteSort 时回退全量且结果正确', got && got.key, '/api/:id');

  const R = build([['GET', '/api/:id'], ['GET', '/other/x/:y'], ['GET', '/*']]);
  check('首段未建桶时走 argsDyn', R.findRealPath('/zzz/1/2', 'GET').key, '/*');
  check('n===0（纯斜杠路径）回退全量', R.findRealPath('/', 'GET').key, '/*');

  const routes = [['GET', '/*']];
  for (let i = 0; i < 24; i++) routes.push(['GET', `/api/res${i}/:id`]);
  routes.push(['GET', '/api/:any/count']);
  const R2 = build(routes);
  check('第二段未建子桶时走 subDyn（未命中不退化为全表）',
    R2.findRealPath('/api/nores/count', 'GET').key, '/api/:any/count');
  check('第二段未建子桶且无匹配时正确落到兜底',
    R2.findRealPath('/api/nores/zzz', 'GET').key, '/*');
}

// ============ 五、不变量 + 大规模随机差分 ============
{
  const SEG = ['api', 'user', 'order', 'list', 'admin', 'v1', 'v2', 'file', 'img', 'res'];
  const METHODS = ['GET', 'POST'];
  const rnd = n => Math.floor(Math.random() * n);

  let invBad = 0, diffBad = 0, total = 0;

  for (let t = 0; t < 60; t++) {
    // 随机路由表
    const seen = new Set();
    const routes = [];
    const cnt = 5 + rnd(45);

    for (let i = 0; i < cnt; i++) {
      const depth = 1 + rnd(4);
      let p = '';
      for (let d = 0; d < depth; d++) {
        const roll = Math.random();
        p += '/' + (roll < 0.55 ? SEG[rnd(SEG.length)] + (rnd(3) ? '' : i)
                  : roll < 0.85 ? ':p' + d : '*');
        if (p.endsWith('*')) break;
      }
      const m = METHODS[rnd(METHODS.length)];
      if (p.indexOf('/:') >= 0 && p.indexOf('*') >= 0) continue;
      if (seen.has(m + p)) continue;
      seen.add(m + p);
      routes.push([m, p]);
    }
    if (routes.length === 0) continue;

    let R;
    try { R = build(routes); } catch (e) { continue; }   // 冲突路由由 addPath 自己拒绝

    // —— 不变量 1：每个桶都是全序列的子序列 ——
    for (const m of METHODS) {
      const all = paths(R.argsRoute[m]);
      const check1 = list => {
        let j = 0;
        for (const x of paths(list)) { while (j < all.length && all[j] !== x) j++; if (j >= all.length) return false; j++; }
        return true;
      };
      if (!check1(R.argsDyn[m])) invBad++;
      for (const k in R.argsIndex[m]) {
        const node = R.argsIndex[m][k];
        if (!check1(node.list)) invBad++;
        if (node.sub) for (const k2 in node.sub) if (!check1(node.sub[k2])) invBad++;
        if (node.subDyn && !check1(node.subDyn)) invBad++;
      }
    }

    // —— 差分：同一实例，关闭索引后重跑，结果必须逐字段一致 ——
    const savedIdx = R.argsIndex;
    for (let q = 0; q < 300; q++) {
      const depth = 1 + rnd(5);
      let p = '';
      for (let d = 0; d < depth; d++) p += '/' + (rnd(2) ? SEG[rnd(SEG.length)] : SEG[rnd(SEG.length)] + rnd(50));
      if (rnd(4) === 0) p = p.replace('/', '//');
      const m = METHODS[rnd(METHODS.length)];

      R.argsIndex = savedIdx;
      const withIdx = R.findRealPath(p, m);

      R.argsIndex = {};              // 强制走回退：全量扫描
      const noIdx = R.findRealPath(p, m);

      total++;
      const a = withIdx === null ? 'null' : JSON.stringify({ key: withIdx.key, args: withIdx.args });
      const b = noIdx === null ? 'null' : JSON.stringify({ key: noIdx.key, args: noIdx.args });
      if (a !== b) {
        diffBad++;
        if (diffBad <= 3) console.log(`  差异 ${m} ${JSON.stringify(p)}\n    有索引 ${a}\n    无索引 ${b}`);
      }
    }
    R.argsIndex = savedIdx;
  }

  check('不变量：所有桶均为全序列的子序列', invBad, 0);
  check(`大规模随机差分（${total} 次，有索引 vs 无索引结果一致）`, diffBad, 0);
}

console.log(`\ntest-router-index: ${failed === 0 ? '全部通过' : failed + ' 项失败'}`);
process.exit(failed === 0 ? 0 : 1);
