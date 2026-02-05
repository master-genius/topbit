'use strict'

let Topbit = require('../src/topbit.js')

let {Http2Proxy} = Topbit.extensions

let app = new Topbit({
  debug: true,
  globalLog: true,
  loadInfoFile: '--mem',
  http2: true
})

if (app.isWorker) {
  let h2proxy = new Http2Proxy({
    config: {
      'v.com': [
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

  h2proxy.init(app)
}

app.printServInfo().daemon(1234, 2)