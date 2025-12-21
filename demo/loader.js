'use strict'

process.chdir(__dirname)

let Topbit = require('../src/topbit.js')
let {Loader} = Topbit
const npargv = Topbit.npargv

let {args} = npargv({
  '--loadtype': {
    name: 'loadtype',
    default: 'text',
    limit: ['text', 'json', 'orgjson', 'obj', 'orgobj']
  },
  '--load': {
    name: 'load',
    default: false
  },
  '-w': {
    name: 'worker',
    default: 2,
    min: 1,
    max: 5
  }
})

let app = new Topbit({
  debug: true,
  loadMonitor: true,
  loadInfoType : args.loadtype,
  globalLog : false,
  logType: 'stdio',
  loadInfoFile : args.load ? '' : '/tmp/topbit-loadinfo.log',
  maxLoadRate: 0.85
})

if (app.isWorker) {
  app.get('/', async ctx => {
    ctx.ok('ok')
  })
}

let ld = new Loader()

ld.daemonInit(app, () => {
  app.sched('none')
    .autoWorker(12)
    .printServInfo(100)
    .daemon(1234, args.worker)
})

//console.log(app.midware.midGroup)
//console.log({...app.router})