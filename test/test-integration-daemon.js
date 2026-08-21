'use strict';
// test-integration-daemon：daemon/cluster 真实运行。
// clear() 只在 daemon 的 primary 分支被调用，本轮刚改过它（补清三张索引），
// 必须验证 primary 清空后 worker 仍能正常服务、worker 崩溃能补活、日志能汇总。
const cluster = require('node:cluster');
const http = require('node:http');
const Topbit = require('../src/topbit.js');

const PORT = 48201;
const WORKERS = 3;

const app = new Topbit({
  parseBody: true,
  debug: false,
  globalLog: true,
  logType: 'stdio',
  loadMonitor: false
});

app.use(async (c, next) => { c.box.hit = 1; return await next(c); });

app.get('/w/:id', async c => { c.data = `W${process.pid}|${c.param.id}|${c.box.hit}`; });
app.get('/w/static/x', async c => { c.data = `W${process.pid}|static`; });
app.get('/w/star/*', async c => { c.data = `W${process.pid}|star|${c.param.starPath}`; });
app.get('/w/kill', async c => { c.res.end('bye'); setTimeout(() => process.exit(1), 30); });

const grp = app.group('/g');
grp.get('/p/:v', async c => { c.data = `W${process.pid}|g|${c.param.v}`; });

const seen = new Set();
let exited = 0;
let logCount = 0;

if (cluster.isPrimary) {
  cluster.on('listening', w => seen.add(w.process.pid));
  cluster.on('exit', () => exited++);
  app.setMsgEvent('_log', () => { logCount++; });
}

// daemon 内部自行分支：primary 负责 fork，worker 转发到 run()。
// 必须在两个分支都调用——worker 会重新执行整个入口脚本。
app.daemon(PORT, WORKERS);

if (cluster.isPrimary) {

  // primary 在 fork 前调用了 clear()，此处验证三张索引确实已清空
  setTimeout(() => {
    const r = app.router;
    const cleared = Object.keys(r.apiTable.GET).length === 0
      && r.argsRoute.GET.length === 0
      && Object.keys(r.argsIndex).length === 0
      && Object.keys(r.argsDyn).length === 0
      && Object.keys(r.staticTree).length === 0;
    console.log(cleared ? 'PASS primary 侧 clear() 已清空路由表与三张索引'
                        : 'FAIL primary 侧仍有残留');
    global.__cleared = cleared;
  }, 300);

  const req = (path, cb) => {
    const q = http.get({ host: '127.0.0.1', port: PORT, path, agent: false }, res => {
      let d = ''; res.on('data', x => d += x);
      res.on('end', () => cb(res.statusCode, d));
    });
    q.on('error', e => cb('ERR', e.message));
  };
  const p = path => new Promise(r => req(path, (c, d) => r({ code: c, body: d })));

  setTimeout(async () => {
    let failed = global.__cleared === true ? 0 : 1;
    const ok = (d, c, e) => { if (!c) { failed++; console.log(`FAIL ${d}${e ? '  ' + e : ''}`); } else console.log(`PASS ${d}`); };

    ok(`fork 出 ${WORKERS} 个 worker 并全部 listening`, seen.size === WORKERS, `实际 ${seen.size}`);

    // 各类路由在 worker 中正常
    const pids = new Set();
    let bad = 0;
    for (let i = 0; i < 300; i++) {
      const r = await p(`/w/${i}`);
      if (!/^W\d+\|\d+\|1$/.test(r.body) || r.body.split('|')[1] !== String(i)) bad++;
      else pids.add(r.body.split('|')[0]);
    }
    ok('worker 中参数路由 + 中间件正常（300 次）', bad === 0, bad ? `${bad} 个错误` : null);
    ok('请求分发到多个 worker', pids.size > 1, `命中 ${pids.size} 个 worker`);

    ok('worker 中静态路由', /\|static$/.test((await p('/w/static/x')).body));
    ok('worker 中星号路由', /\|star\|a\/b$/.test((await p('/w/star/a/b')).body));
    ok('worker 中分组前缀路由', /\|g\|vv$/.test((await p('/g/p/vv')).body));
    ok('worker 中多余斜杠归一化', /\|static$/.test((await p('//w//static//x')).body));

    ok('worker 上报的日志被 primary 汇总', logCount > 0, `收到 ${logCount} 条`);

    // 杀掉一个 worker，验证自动补活
    const before = Object.keys(cluster.workers).length;
    await p('/w/kill');
    await new Promise(r => setTimeout(r, 1200));
    const after = Object.keys(cluster.workers).length;
    ok('worker 异常退出后被自动补活', exited >= 1 && after === before,
       `退出 ${exited} 次，补活后 ${after}/${before}`);

    // 补活后服务仍然正常
    let bad2 = 0;
    for (let i = 0; i < 100; i++) {
      const r = await p(`/w/r${i}`);
      if (!r.body.endsWith(`|r${i}|1`)) bad2++;
    }
    ok('补活后服务恢复正常（100 次）', bad2 === 0, bad2 ? `${bad2} 个错误` : null);

    console.log(`\ntest-integration-daemon: ${failed === 0 ? '全部通过' : failed + ' 项失败'}`);
    for (const id in cluster.workers) cluster.workers[id].process.kill('SIGKILL');
    process.exit(failed === 0 ? 0 : 1);
  }, 2500);
}
