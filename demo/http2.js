'use strict'

'use strict'

process.chdir(__dirname)

let Topbit = require('../src/topbit.js')
let {Loader, npargv} = Topbit

let {args} = npargv({
  '--httpc': 'httpc'
})

let app = new Topbit({
  debug: true,
  globalLog: true,
  logType: 'stdio',
  allowHTTP1: args.httpc,
  loadInfoFile: '--mem',
  cert: './cert/localhost-cert.pem',
  key: './cert/localhost-privkey.pem',
  http2: true
})

if (app.isWorker) {
  app.get('/', async ctx => {
    ctx.ok('ok')
  })

  let ld = new Loader()

  ld.init(app)

  app.get('/httpc/:id', async ctx => {
    console.log(ctx.headers, ctx.method, ctx.path, ctx.name, ctx.group)
    ctx.to({
      major: ctx.major,
      protocol: ctx.protocol,
      port: ctx.port,
      group: ctx.group
    })
  })
}


app.sched('none')

app.autoWorker(3)

app.daemon(1234, 1)
