'use strict';

function createLogger(silent = false) {
  function print(method, message) {
    if (!silent) console[method](message);
  }
  return {
    info: message => print('log', message),
    warn: message => print('warn', `警告：${message}`),
    error: message => print('error', `错误：${message}`)
  };
}

module.exports = { createLogger };

