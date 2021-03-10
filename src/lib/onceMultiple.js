// Copyright (c) 2019-2021 Zero Density Inc.
//
// This file is part of realityhub-api.
//
// realityhub-api is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License version 2, as published by 
// the Free Software Foundation.
//
// realityhub-api is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with realityhub-api. If not, see <https://www.gnu.org/licenses/>.

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
