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

class RawRequest {
  setCallback(callback) {
    if (typeof callback !== 'function') {
      throw new Error('callback must be a function.');
    }

    this.callback = callback;
  }

  setInstigatorId(value) {
    this.instigatorId = value;
  }

  getInstigatorId() {
    return this.instigatorId;
  }

  call(...args) {
    if (this.callback) {
      return this.callback(...args);
    }
  }
}

module.exports = RawRequest;
