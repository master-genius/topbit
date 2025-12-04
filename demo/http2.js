'use strict'

'use strict'

process.chdir(__dirname)

let Topbit = require('../src/topbit.js')
let {Loader} = Topbit

let app = new Topbit({
  debug: true,
  globalLog: true,
  logType: 'stdio',
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
}

app.sched('none')

app.autoWorker(3)

app.daemon(1234, 1)
