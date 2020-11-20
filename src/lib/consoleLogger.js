// Copyright 2019-2020 Zero Density, Inc. All Rights Reserved.

module.exports = function consoleLogger(moduleName, options = { silent: false }) {
  const { silent } = options;

  return ['log', 'info', 'warn', 'error', 'trace', 'debug'].reduce((o, item) => {
    o[item] = (...args) => {
      if (!silent) {
        args = [
          `NOTICE (${item}): Current module: ${moduleName} has no Logger object available, outputting to the console`,
          ...args,
        ];
      }

      if (['trace', 'debug'].includes(item)) {
        for (const arg of (args || [])) {
          console.log(arg);
        }
      }

      return console[item](...args);
    }
    return o;
  }, {});
};
