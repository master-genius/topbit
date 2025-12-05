'use strict';

const topbit = require('../src/topbit.js');
const fs = require('fs');
const tls = require('tls');

let certs = {
    'x.com' : {
        cert : fs.readFileSync('./cert/x.com.cert'),
        key  : fs.readFileSync('./cert/x.com.key')
    },

    'api.x.com' : {
        cert : fs.readFileSync('./cert/api.x.com.cert'),
        key  : fs.readFileSync('./cert/api.x.com.key')
    }
}

let app = new topbit({
    debug: true,
    loadMonitor: false,
    http2: true,
    https: true,
    server : {
        SNICallback : (servername, cb) => {
            return cb(null, tls.createSecureContext(certs[servername]));
        }
    },
    pidFile: '/tmp/mymaster.pid'
});


app.use(async (c, next) => {
    if (!c.getFile('image')) {
        return c.status().oo('image not found');
    }
    await next(c);
}, {method:'POST', group: 'upload'});

app.get('/', async c => {
    c.oo('ok');
})

app.post('/p', async c => {
    c.ok(c.body);
});

app.post('/upload', async c => {
    try {
        c.res.body = await c.moveFile(c.getFile('image'), {
            path: process.env.HOME + '/tmp/buffer'
        });
    } catch (err) {
        c.res.body = err.message;
    }
}, '@upload');

app.daemon(1990, 2);

