'use strict';

// 路由模块在真实场景下的安全性验证。
// findPath 使用模块级共享缓冲（SEG_S / SEG_E / SEG_BUF）加速，安全性依赖两条性质：
//   1) findPath 全程同步且不重入——从 onRequest 一路同步调下来，中间没有 await，
//      也没有任何能插入用户代码的回调或 getter；
//   2) 缓冲区内容不逃逸——args 里存的是字符串值（不可变），key 也是字符串，
//      没有任何返回结果持有缓冲槽位的引用。
// 本测试用真实 HTTP 服务、高并发混合请求来验证这两条在实际运行中成立。
// 用法: node test/test-router-concurrency.js

const http = require('node:http');
const Topbit = require('../src/topbit.js');

const PORT_A = 47001;
const PORT_B = 47002;
let failed = 0;

function ok(desc, cond, extra) {
  if (!cond) { failed++; console.log(`FAIL ${desc}${extra ? '\n     ' + extra : ''}`); }
  else console.log(`PASS ${desc}`);
}

// —— 两个独立实例，共享同一份模块级缓冲 ——
function mkApp(tag) {
  const app = new Topbit({ parseBody: false, debug: false });

  app.get('/s/fixed',                async c => { c.data = `${tag}|static`; });
  app.get('/p/:a',                   async c => { c.data = `${tag}|p1|${c.param.a}`; });
  app.get('/p/:a/:b',                async c => { c.data = `${tag}|p2|${c.param.a}|${c.param.b}`; });
  app.get('/deep/:a/x/:b/y/:c',      async c => { c.data = `${tag}|p3|${c.param.a}|${c.param.b}|${c.param.c}`; });
  app.get('/w/*',                    async c => { c.data = `${tag}|star|${c.param.starPath}`; });
  app.get('/n/a/b/c',                async c => { c.data = `${tag}|nested`; });

  // 在路由回调内部再次调用 findRealPath，模拟用户在中间件里手动查路由，
  // 验证嵌套调用不会破坏外层已经取到的结果
  app.get('/re/:a', async c => {
    const before = c.param.a;
    const inner = app.router.findRealPath('/deep/QQ/x/WW/y/EE', 'GET');
    c.data = `${tag}|re|${before}|${c.param.a}|${inner.args.a}${inner.args.b}${inner.args.c}`;
  });

  // 参数名为原型键，验证不会污染原型也不会误判
  app.get('/proto/:__proto__/:constructor', async c => {
    c.data = `${tag}|proto|${typeof c.param.__proto__}|${c.param.constructor}`;
  });

  return app;
}

mkApp('A').run(PORT_A);
mkApp('B').run(PORT_B);

function req(port, path) {
  return new Promise(r => {
    const q = http.request({ host: '127.0.0.1', port, path, agent: false }, res => {
      let d = '';
      res.on('data', x => d += x);
      res.on('end', () => r({ code: res.statusCode, body: d }));
    });
    q.on('error', e => r({ code: 'ERR', body: e.message }));
    q.end();
  });
}

// 生成 (请求, 期望) 对；tag 由端口决定
function cases(port, tag, i) {
  return [
    [`/s/fixed`,                    `${tag}|static`],
    [`//s//fixed`,                  `${tag}|static`],
    [`/p/a${i}`,                    `${tag}|p1|a${i}`],
    [`/p/a${i}/b${i}`,              `${tag}|p2|a${i}|b${i}`],
    [`/p//a${i}///b${i}`,           `${tag}|p2|a${i}|b${i}`],
    [`/deep/d${i}/x/e${i}/y/f${i}`, `${tag}|p3|d${i}|e${i}|f${i}`],
    [`/w/u${i}/v${i}/w${i}`,        `${tag}|star|u${i}/v${i}/w${i}`],
    [`/n/a/b/c`,                    `${tag}|nested`],
    [`//n///a//b////c`,             `${tag}|nested`],
    [`/re/r${i}`,                   `${tag}|re|r${i}|r${i}|QQWWEE`],
    [`/proto/x${i}/y${i}`,          `${tag}|proto|object|y${i}`]
  ].map(([p, e]) => ({ port, path: p, expect: e }));
}

setTimeout(async () => {
  // ============ 一、高并发混合请求，两个实例交错 ============
  const ROUNDS = 400;
  const all = [];
  for (let i = 0; i < ROUNDS; i++) {
    all.push(...cases(PORT_A, 'A', i));
    all.push(...cases(PORT_B, 'B', i));
  }
  // 打乱，确保两个实例的请求彻底交错
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }

  let bad = 0, firstBad = null;
  const CONC = 128;
  let idx = 0;

  await new Promise(resolve => {
    let inflight = 0, done = 0;
    const kick = () => {
      while (inflight < CONC && idx < all.length) {
        const t = all[idx++];
        inflight++;
        req(t.port, t.path).then(r => {
          if (r.body !== t.expect) {
            bad++;
            if (firstBad === null) firstBad = `${t.path}\n     期望 ${t.expect}\n     实际 ${r.body}`;
          }
          inflight--; done++;
          if (done === all.length) return resolve();
          kick();
        });
      }
    };
    kick();
  });

  ok(`并发 ${CONC}、两实例交错、共 ${all.length} 个请求全部返回正确结果`, bad === 0,
     bad ? `${bad} 个错误，首个：${firstBad}` : null);

  // ============ 二、原型未被污染 ============
  ok('参数名为 __proto__ 不污染 Object.prototype', ({}).x === undefined && Object.prototype.x === undefined);
  const probe = {};
  ok('参数名为 constructor 不改写原型链', probe.constructor === Object);

  // ============ 三、缓冲区内容不逃逸：结果在后续调用后仍然正确 ============
  {
    const app = new Topbit({ parseBody: false });
    app.get('/x/:a/:b', async c => {});
    app.get('/y/:c/:d/:e', async c => {});
    app.run(47003);

    const r1 = app.router.findRealPath('/x/AA/BB', 'GET');
    const snapshot = JSON.stringify(r1.args);

    // 大量后续调用，反复覆写共享缓冲
    for (let i = 0; i < 5000; i++) {
      app.router.findRealPath(`/y/c${i}/d${i}/e${i}`, 'GET');
      app.router.findRealPath(`/x/p${i}/q${i}`, 'GET');
    }

    ok('先前返回的 args 不受后续调用覆写影响', JSON.stringify(r1.args) === snapshot,
       `快照 ${snapshot}  现在 ${JSON.stringify(r1.args)}`);
    ok('先前返回的 key 不受影响', r1.key === '/x/:a/:b');
  }

  // ============ 四、多实例交替直接调用 findRealPath ============
  {
    const a1 = new Topbit({ parseBody: false });
    a1.get('/i1/:v', async c => {});
    a1.run(47004);

    const a2 = new Topbit({ parseBody: false });
    a2.get('/i2/:v/:w', async c => {});
    a2.run(47005);

    let mix = 0;
    for (let i = 0; i < 20000; i++) {
      const x = a1.router.findRealPath(`/i1/n${i}`, 'GET');
      const y = a2.router.findRealPath(`/i2/p${i}/q${i}`, 'GET');
      if (x.key !== '/i1/:v' || x.args.v !== `n${i}`) mix++;
      if (y.key !== '/i2/:v/:w' || y.args.v !== `p${i}` || y.args.w !== `q${i}`) mix++;
    }
    ok('两个实例交替调用 4 万次互不干扰', mix === 0, mix ? `${mix} 次错乱` : null);
  }

  // ============ 五、worker_threads 下缓冲不跨线程共享 ============
  {
    const { Worker } = require('node:worker_threads');
    const THREADS = 4, PER = 50000;

    const code = `
      const { workerData, parentPort } = require('node:worker_threads');
      const Router = require(workerData.dir + '/../src/router.js');
      const r = new Router();
      const tag = workerData.tag;
      r.addPath('/' + tag + '/:a/:b', 'GET', async c => {});
      r.addPath('/*', 'GET', async c => {});
      r.argsRouteSort();
      let bad = 0;
      for (let i = 0; i < workerData.n; i++) {
        const x = r.findRealPath('/' + tag + '/' + tag + 'a' + i + '/' + tag + 'b' + i, 'GET');
        if (!x || x.key !== '/' + tag + '/:a/:b'
          || x.args.a !== tag + 'a' + i || x.args.b !== tag + 'b' + i) bad++;
      }
      parentPort.postMessage(bad);
    `;

    let totalBad = await new Promise(resolve => {
      let done = 0, sum = 0;
      for (let t = 0; t < THREADS; t++) {
        const w = new Worker(code, { eval: true, workerData: { tag: 'w' + t, n: PER, dir: __dirname } });
        w.on('message', b => { sum += b; if (++done === THREADS) resolve(sum); });
        w.on('error', e => { sum += 1; if (++done === THREADS) resolve(sum); });
      }

      // 主线程在 worker 运行期间同时匹配，制造真正的并行
      const app = new Topbit({ parseBody: false });
      app.get('/mt/:a/:b', async c => {});
      app.run(47006);
      for (let i = 0; i < PER; i++) {
        const x = app.router.findRealPath(`/mt/ma${i}/mb${i}`, 'GET');
        if (!x || x.args.a !== `ma${i}` || x.args.b !== `mb${i}`) sum++;
      }
    });

    ok(`${THREADS} 个 worker 线程与主线程并行各 ${PER} 次匹配，模块级缓冲未跨线程共享`,
       totalBad === 0, totalBad ? `${totalBad} 次错误` : null);
  }

  console.log(`\ntest-router-concurrency: ${failed === 0 ? '全部通过' : failed + ' 项失败'}`);
  process.exit(failed === 0 ? 0 : 1);
}, 400);
