'use strict';

const Topbit = require('../src/topbit.js');
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

  '--http2': {
    name: 'http2',
    default: false
  }
})

const app = new Topbit({
    debug : true,
    allow : new Set(['127.0.0.1']),
    maxIPRequest: 2,
    unitTime: 10,
    useLimit: true,
    maxConn: 2000,
    http2: args.http2,
    loadMonitor: true,
    loadInfoType : args.loadtype,
    globalLog : false,
    logType: 'stdio',
    loadInfoFile : args.load ? '' : '/tmp/topbit-loadinfo.log',
    maxLoadRate: 0.56
});

app.get('/', async c => {
    c.to('ok');
}, 'home');

app.get('/test', async c => {
    //await c.ext.delay(10)
    let sum = 0
    for (let i = 0; i < 90000; i++) {
        sum += Math.random() * i;
    }
    c.to({sum});
}, {group: 'test', name : 'test'});

app.post('/test', async c => {
    c.to(c.body);
}, {group: 'test', name : 'test-post'});

app.post('/transmit', async c => {
    c.to('ok');
}, 'transmit');

app.use(async (c, next) => {
    let total = 0;
    
    c.box.dataHandle = (data) => {
        total += data.length;
        if (total > 32) {
            c.response.statusCode = 413;
            c.response.end('太多了，限制32字节以内');
            return ;
        }
    };

    await next(c);

    console.log(total, 'bytes');

}, {pre: true, method: 'POST', name: 'transmit'});

app.autoWorker(4)

app.printServInfo().daemon(2034, 1)
