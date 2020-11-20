// Copyright 2019-2020 Zero Density, Inc. All Rights Reserved.

class TimeoutError extends Error {
  constructor(params) {
    super(params);
    this.code = 'TIMEOUT';
    this.name = this.constructor.name;
  }
}

module.exports = function onceMultiple(target, eventNames, timeout = null) {
  return new Promise((resolve, reject) => {
    let timer;
    let handler;
    let removeListeners;

    removeListeners = () => {
      for (const eventName of eventNames) {
        target.removeListener(eventName, handler);
      }
    };

    handler = (...args) => {
      removeListeners();
      clearTimeout(timer);
      resolve(...args);
    };

    for (const eventName of eventNames) {
      target.once(eventName, handler);
    }

    if (timeout) {
      timer = setTimeout(() => {
        removeListeners();
        reject(new TimeoutError('Timeout exceeded.'));
      }, timeout);
    }
  });
}
