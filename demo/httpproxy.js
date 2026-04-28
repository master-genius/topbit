'use strict'

process.chdir(__dirname)

let Topbit = require('../src/topbit.js')

let {Proxy, ProxyNoAgent} = Topbit.extensions

const npargv = Topbit.npargv

let {args} = npargv({
  '--httpc': {
    name: 'httpc',
    default: false,
  },

  '--agent': {
    name: 'agent',
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

let proxy_class = ProxyNoAgent
if (args.agent) proxy_class = Proxy

if (app.isWorker) {
  let pxy = new proxy_class({
    config: {
      'w.com': [
        {
          url: 'http://127.0.0.1:3001',
          weight: 10,
          path : '/',
          reconnDelay: 20,
          max: 1000,
          headers: {
            'x-test-key': `${Date.now()}-${Math.random()}`
          },
          connectTimeout: 20000,
          aliveCheckInterval: 20000
        },

        {
          url: 'http://127.0.0.1:3002',
          weight: 4,
          path : '/',
          max: 1000,
          reconnDelay: 10,
          headers: {
            'x-test-key2': `${Date.now()}-${Math.random()}`
          },
          aliveCheckInterval: 20000

        }
      ]
    },
    debug: true
  })

  pxy.init(app)
}

app.printServInfo().daemon(1234, 2)
