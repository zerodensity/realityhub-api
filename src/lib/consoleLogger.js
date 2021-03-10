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
