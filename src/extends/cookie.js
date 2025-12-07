'use strict';

class Cookie {
  constructor() {

  }

  mid() {
    return async (rr, next) => {
      rr.box.cookie = {}

      if (rr.headers['cookie']) {
        let cookies = rr.headers['cookie'].split(';').filter(c => c.length > 0)
    
        let tmpList = []
        let name = ''

        for (let i = 0; i < cookies.length; i++) {
          tmpList = cookies[i].split('=').filter(p => p.length > 0)
          name = tmpList[0].trim()

          if (name.length == 0) {
            continue
          }

          if (tmpList.length < 2) {
            rr.box.cookie[name] = ''
          } else {
            rr.box.cookie[name] = tmpList[1]
          }
        }
      }

      await next(rr)
      
      rr.box.cookie = null
    }

  }

}

module.exports = Cookie
