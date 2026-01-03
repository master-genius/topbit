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
  http2: true,
  server: {
    peerMaxConcurrentStreams: 200,
    settings: {
      maxConcurrentStreams: 201,
      maxHeaderListSize: 16384,
      maxHeaderSize: 16384
    }
  }
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

app.on('connection', sock => {
  console.log(sock)
})

app.sched('none')
  .autoWorker(3)
  .printServInfo()
  .daemon(1234, 2)

let settings = {
  maxConcurrentStreams: 200,
  maxHeaderListSize: 16384
}

app.on('session', sess => {
  console.log(sess.localSettings, sess.remoteSettings)

  sess.on('localSettings', s => {
    console.log('local', s)
  })

  sess.on('remoteSettings', s => {
    console.log('remote', s)
  })
  /* sess.settings(settings, (err, setting, dura) => {
    console.log(setting, dura)
  }) */
  
})