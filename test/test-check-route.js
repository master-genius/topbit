/**
 * router.checkRoute() —— 路由字符串格式自检
 *
 * 该方法只判断「字符串本身是否是一个合法的路由」，不注册、不抛错、无副作用，
 * 供上层应用（如从配置文件生成路由的网关类应用）在注册前自检配置。
 * 模式冲突与命名重复取决于路由表已注册了什么，属运行期状态，不在其职责内。
 */
'use strict';

const Router = require('../src/router.js');

let total = 0, bad = 0;

function check(title, actual, expect) {
  total++;
  const ok = JSON.stringify(actual) === JSON.stringify(expect);
  if (!ok) bad++;
  console.log(`${ok ? '  ok' : '✗ FAIL'}  ${title}`);
  if (!ok) console.log(`         期望 ${JSON.stringify(expect)}\n         实际 ${JSON.stringify(actual)}`);
}

const r = new Router();

// ---- 合法：ok 为 true 且不带其他字段 ----
for (const p of [
  '/', '', '   ', 'api',
  '/api/:id', '/api/:a/:b', '/static/*', '/*',
  '/api//v2', '//api//', '/api/',            // 连续斜杠与末尾斜杠都会被归一化
  '/v1.0/x@y', '/a-b_c/:id'                  // . @ - _ 均在允许集内
]) {
  check(`合法：${JSON.stringify(p)}`, r.checkRoute(p), {ok: true});
}

// ---- 非法：ok 为 false，message 与 route 都要给出 ----
const illegal = [
  ['/x\\y',         '存在非法字符',       '路径分隔符只能是 /'],
  ['/a b',          '存在非法字符',       '空格'],
  ['/a?b=1',        '存在非法字符',       '查询串'],
  ['/a#f',          '存在非法字符',       '片段'],
  ['/a%2Fb',        '存在非法字符',       '百分号编码'],
  ['/中文',          '存在非法字符',       '非 ASCII'],
  ['/a/*/b',        '只能出现在最后',      '* 不在末尾'],
  ['/a/**',         '多个 *',            '多个 *'],
  ['/a/:id/*',      ': 和 * 不能同时出现', ': 与 * 共存'],
  ['/a/:',          '参数不能没有名称',    '参数无名'],
  ['/x/:__proto__', '__proto__',        '参数名为 __proto__'],
  ['/a/:x/:__proto__/:y', '__proto__',  '__proto__ 出现在中间'],
];

for (const [p, frag, title] of illegal) {
  const res = r.checkRoute(p);
  check(`非法：${title}`, {ok: res.ok, hit: String(res.message).includes(frag), hasRoute: typeof res.route === 'string'},
        {ok: false, hit: true, hasRoute: true});
}

// ---- 非字符串输入不抛错 ----
for (const v of [undefined, null, 123, {}, [], () => {}]) {
  const res = r.checkRoute(v);
  check(`非字符串输入 ${Object.prototype.toString.call(v)} 返回 ok:false 而非抛错`,
        {ok: res.ok, hasMsg: typeof res.message === 'string'}, {ok: false, hasMsg: true});
}

// ---- route 字段是归一化后的路由串，与实际注册的 key 一致 ----
{
  const res = r.checkRoute('/a/*/b');
  check('route 为归一化后的串', res.route, '/a/*/b');
  check('归一化合并连续斜杠', r.checkRoute('//a//b//*/c').route, '/a/b/*/c');
}

// ---- checkRoute 与 addPath 的判定必须完全一致 ----
{
  const probes = [
    '/ok/x', '/ok/:id', '/ok/*', '/o.k/@x', '/a//b',
    '/bad\\x', '/bad y', '/bad/*/x', '/bad/**', '/bad/:id/*', '/bad/:', '/bad/:__proto__'
  ];
  let mismatch = [];
  for (const p of probes) {
    const t = new Router();
    const declared = t.checkRoute(p).ok;
    let real = true;
    try { t.addPath(p, 'GET', async c => {}, ''); } catch (e) { real = false; }
    if (declared !== real) mismatch.push(`${p}: checkRoute=${declared} addPath=${real}`);
  }
  check('checkRoute 与 addPath 判定一致', mismatch, []);
}

// ---- checkRoute 无副作用：调用后路由表仍为空 ----
{
  const t = new Router();
  for (const p of ['/a', '/b/:id', '/bad\\x']) t.checkRoute(p);
  const totalRoutes = t.methods.reduce((n, m) => n + Object.keys(t.routeTable()[m] || {}).length, 0);
  check('checkRoute 不注册任何路由', totalRoutes, 0);
}

// ---- 归一化后的路由串就是 addPath 实际注册的 key ----
{
  const t = new Router();
  t.addPath('//api//v2//', 'GET', async c => {}, '');
  check('归一化结论与注册 key 一致',
        Object.keys(t.routeTable().GET), [t.normalizeRoute('//api//v2//')]);
}

console.log(`\n${bad === 0 ? '全部通过' : `失败 ${bad} 项`}：${total - bad}/${total}`);
process.exit(bad === 0 ? 0 : 1);
