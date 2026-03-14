'use strict'

process.chdir(__dirname)

let Topbit = require('../src/topbit.js')

let {Proxy} = Topbit.extensions

const npargv = Topbit.npargv

let {args} = npargv({
  '--httpc': {
    name: 'httpc',
    default: false,
  }
})

let app = new Topbit({
  debug: true,
  globalLog: true,
  loadInfoFile: '--mem',
  http2: args.httpc,
  allowHTTP1: args.httpc,
  cert: args.httpc ? './cert/x.com.cert' : '',
  key: args.httpc ? './cert/x.com.key' : '',
})

if (app.isWorker) {
  let pxy = new Proxy({
    config: {
      'w.com': [
        {
          url: 'http://localhost:3001',
          weight: 10,
          path : '/',
          reconnDelay: 200,
          max: 2,
          headers: {
            'x-test-key': `${Date.now()}-${Math.random()}`
          },
          connectTimeout: 2000
        },

        {
          url: 'http://localhost:3002',
          weight: 4,
          path : '/',
          max: 2,
          reconnDelay: 100,
          headers: {
            'x-test-key2': `${Date.now()}-${Math.random()}`
          }
        }
      ]
    },
    debug: true
  })

  pxy.init(app)
}

app.printServInfo().daemon(1234, 2)
