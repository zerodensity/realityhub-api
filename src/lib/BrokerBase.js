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

const { v4: uuid } = require('uuid');
const EventEmitter = require('events');
const BrokerError = require('./BrokerError.js');
const onceMultiple = require('./onceMultiple.js');

const DEFAULT_MAX_WS_PACKET_SIZE = 4 /*MB*/ * 1024 * 1024;

module.exports = class BrokerBase extends EventEmitter {
  constructor(params) {
    super();
    this.moduleName = params.moduleName;

    this.logger = params.logger;

    this.events = new Map();
    this.apiHandlers = new Map();

    this.messageTimeout = 2000;
    
    this.overridenTimeout = NaN; // NaN = use the implementation
    this.destroyed = false;

    try {
      if (typeof window != 'undefined' && typeof localStorage != 'undefined') {
        this.overridenTimeout = Number(localStorage.getItem('BROKER_TIMEOUT')) || NaN;
      } else if (process && process.env) {
        this.overridenTimeout = Number(process.env.BROKER_TIMEOUT) || NaN;
      }
    } catch (ex) {}
    
    if (this.overridenTimeout) {
      const logger = this.logger || console;
      logger.warn(`Broker Timeout is overriden to ${this.overridenTimeout} milliseconds!`);
    }

    let maxPacketSizeRead = DEFAULT_MAX_WS_PACKET_SIZE;
    
    try {
      if (typeof window != 'undefined' && typeof localStorage != 'undefined') {
        maxPacketSizeRead = Number(localStorage.getItem('MAX_WS_PACKET_SIZE')) || NaN;
      } else if (process && process.env) {
        maxPacketSizeRead = Number(process.env.MAX_WS_PACKET_SIZE) || NaN;
      }

      maxPacketSizeRead = Math.max(maxPacketSizeRead, 1024000);
    } catch (ex) {
      const logger = this.logger || console;
      logger.error(`Cannot read maxPacketSize from either localStorage or env, defaulting to ${maxPacketSizeRead}`)
    }

    this.maxPacketSize = maxPacketSizeRead || DEFAULT_MAX_WS_PACKET_SIZE;
    
    if(this.maxPacketSize !== DEFAULT_MAX_WS_PACKET_SIZE) {
      const logger = this.logger || console;
      logger.log(`BrokerBase is created with maxPacketSize: ${this.maxPacketSize}`);
    }

    this.initProxy();
  }

  get errorEmittingEnabled() {
    return this.listeners('error').length > 0;
  }

  getMethodProxy(vendorName, moduleName, options) {
    options = {
      timeout: 2000,
      excludedClients: [],
      ...options,
    };

    return new Proxy({}, {
      get: (_, methodName) => {
        if (methodName === 'emit' && this.moduleName !== `${vendorName}.${moduleName}`) {
          throw new Error('A module can only emit its own events.');
        }

        return (...args) => {
          switch (methodName) {
            case 'emit': {
              this.emitMessage(args, vendorName, moduleName, options);
              break;
            }

            case 'on': {
              const eventName = args.shift();
              const eventHandler = args.shift();

              if (typeof eventName !== 'string') {
                throw new Error('eventName must be a string');
              }

              if (typeof eventHandler !== 'function') {
                throw new Error('eventHandler must be a function');
              }

              const fullyQualifiedName = `${vendorName}.${moduleName}.${eventName}`;

              this
                .subscribeToAPIEvent(fullyQualifiedName, eventHandler)
                .catch((err) => {
                  console.error(`Couldn't subscribe to ${fullyQualifiedName}`);

                  if (err.code !== 'TIMEOUT') {
                    console.trace(err);
                  }
                });

              break;
            }

            case 'once': {
              const eventName = args.shift();
              const eventHandler = args.shift();

              /**
               * If the subscribed event is not emitted within the given timeout then the
               * event handler will be removed automatically to prevent memory leak.
               * If a timeout is not provided by caller than a default timeout of 5 minutes is set.
               */
              const timeout = args.shift() || 60 * 1000 * 5;

              if (typeof eventName !== 'string') {
                throw new Error('eventName must be a string');
              }

              if (typeof eventHandler !== 'function') {
                throw new Error('eventHandler must be a function');
              }

              if (typeof timeout !== 'number' || isNaN(timeout)) {
                throw new Error('timeout must be a number');
              }

              const fullyQualifiedName = `${vendorName}.${moduleName}.${eventName}`;

              this
                .subscribeToAPIEvent(fullyQualifiedName, eventHandler, { once: true })
                .catch((err) => {
                  console.error(`Couldn't subscribe to ${fullyQualifiedName}`);

                  if (err.code !== 'TIMEOUT') {
                    console.trace(err);
                  }
                });
              break;
            }

            case 'off': {
              const eventName = args.shift();
              const eventHandler = args.shift();
              const fullyQualifiedName = `${vendorName}.${moduleName}.${eventName}`;

              if (typeof eventName !== 'string') {
                throw new Error('eventName must be a string');
              }

              if (eventHandler && typeof eventHandler !== 'function') {
                throw new Error('eventHandler must be a function');
              }

              this
                .unsubscribeFromAPIEvent(fullyQualifiedName, eventHandler)
                .catch((err) => {
                  console.error(`Couldn't unsubscribe from ${fullyQualifiedName}`);

                  if (err.code !== 'TIMEOUT') {
                    console.trace(err);
                  }
                });

              break;
            }

            case 'callTimeout': {
              const timeout = args[0];

              if (typeof timeout !== 'number') {
                throw new Error('callTimeout: timeout is required.');
              }

              const clonedOptions = JSON.parse(JSON.stringify(options));
              clonedOptions.timeout = timeout;
              return this.getMethodProxy(vendorName, moduleName, clonedOptions);
            }

            case 'excludeClients': {
              const excludedClients = args[0] || [];

              if (!(excludedClients instanceof Array)) {
                throw new Error('excludedClients requires 1 parameter: an array of strings');
              }

              const clonedOptions = JSON.parse(JSON.stringify(options));
              clonedOptions.excludedClients = clonedOptions.excludedClients.concat(excludedClients);
              return this.getMethodProxy(vendorName, moduleName, clonedOptions);
            }

            default: {
              return this.sendMessage({
                data: args,
                timeout: options.timeout,
                type: `${vendorName}.${moduleName}.${methodName}`,
                targetModuleName: `${vendorName}.${moduleName}`,
                excludedClients: options.excludedClients,
              });
            }
          }
        };
      },
      set: (_, methodName, handler) => {
        if (this.moduleName !== `${vendorName}.${moduleName}`) {
          throw new Error('Cannot register methods to other modules.');
        }

        if (typeof handler !== 'function') {
          throw new Error('Handler must be a function.');
        }

        if (['emit', 'on', 'off'].includes(methodName)) {
          throw new Error(`${methodName} is a reserved method name.`);
        }

        return this.registerAPIHandler(methodName, handler);
      },
    });
  }

  /**
   * Initializes the Proxy object.
   * @private
   */
  initProxy() {
    // These nested proxies allow us to get vendorName, moduleName and methodName.
    // e.g. const pong = await this.api.hub.core.ping();
    this.api = new Proxy({}, {
      get: (_, vendorName) => {
        return new Proxy({}, {
          get: (_, moduleName) => {
            return this.getMethodProxy(vendorName, moduleName);
          },
          set: (_, moduleName, api) => {
            if (this.moduleName !== `${vendorName}.${moduleName}`) {
              throw new Error('Cannot register methods to other modules.');
            }

            if (typeof api !== 'object') {
              throw new Error('API must be set to an object.');
            }

            for (const [methodName, handler] of Object.entries(api)) {
              if (typeof handler !== 'function') {
                throw new Error('Handler must be a function.');
              }

              if (['emit', 'on', 'off'].includes(methodName)) {
                throw new Error(`${methodName} is a reserved method name.`);
              }

              this.registerAPIHandler(methodName, handler);
            }

            return true;
          },
        });
      },
      set: function () {
        console.warn('Module name and method name are required.');
        return false;
      },
    });
  }

  /**
   * Send a response message through `socket`.
   * @private
   * @param {WebSocket} socket Target socket.
   * @param {object} message The message to respond.
   * @param {boolean} success Whether the request was successfully processed or not.
   * @param {array} [data] Additional payload
   * @param {boolean} [relayedMessage=false]
   * @returns {Promise.<array, Error>}
   */
  sendResponse(socket, message, success, data = [], relayedMessage = false) {
    if (!socket) return;

    const { id: requestId, moduleName: targetModuleName, timeout, instigatorId } = message;
    const websocketMessage = {
      type: 'response',
      targetModuleName,
      instigatorId,
      requestId,
      timeout,
      success,
      data,
    };

    if (relayedMessage) {
      websocketMessage.moduleName = message.targetModuleName;
    }

    return this.sendMessage(websocketMessage, socket, relayedMessage);
  }

  /**
   * Registers an API request handler.
   * @param {string} messageType Message type.
   * @param {function} messageHandler Handler function. 
   * @returns {boolean} `false` if a handler has already been assigned to the `messageType`.
   */
  registerAPIHandler(messageType, messageHandler) {
    messageType = `${this.moduleName}.${messageType}`;

    if (this.apiHandlers.has(messageType)) return false;

    this.apiHandlers.set(messageType, {
      relay: false,
      messageHandler,
    });

    return true;
  }

  /**
   * Subscribe to an API event.
   * @param {string} eventName Fully qualified event name.
   * @param {function} eventHandler A function which will be called when the event is received. 
   * @param {object} [options] Options
   * @param {boolean} [options.sendMessage=true] If set to `true`, it will send a subscription message over WebSocket.
   * Otherwise the message will only be registered internally.
   * @param {boolean} [options.once=false] If true then the handler will be invoked only once and it won't be invoked for
   * the future events that are emitted.
   * @returns {Promise.<array, Error>}
   */
  subscribeToAPIEvent(eventName, eventHandler, options) {
    options = {
      sendMessage: true,
      once: false,
      ...options,
    };

    // Add handler to handlers map
    const handlerArray = this.events.get(eventName) || [];
    handlerArray.push({ eventHandler, once: options.once });
    this.events.set(eventName, handlerArray);

    // Send a subscription message over WebSocket
    if (options.sendMessage) {
      const targetModuleName = eventName.split('.')
        .slice(0, 2)
        .join('.');

      return this.sendMessage({
        type: 'subscribe',
        eventName,
        targetModuleName,
      });
    }
  }

  /**
   * Unsubscribe from an API event.
   * @param {string} eventName Fully qualified event name.
   * @param {function} [eventHandler] A previously registered handler function. All handlers of the event will
   * be removed unless `eventHandler` is provided.
   * @param {boolean} [sendMessage=true] Will send an unsubscription request when set to `true`.
   * @returns {Promise.<array, Error>}
   */
  unsubscribeFromAPIEvent(eventName, eventHandler, sendMessage = true) {
    if (eventHandler) {
      const handlerArray = (this.events.get(eventName) || []).filter((entry) => entry.eventHandler !== eventHandler);
      this.events.set(eventName, handlerArray);
    } else {
      this.events.delete(eventName);
    }

    if (sendMessage) {
      const targetModuleName = eventName.split('.')
        .slice(0, 2)
        .join('.');

      return this.sendMessage({
        type: 'unsubscribe',
        eventName,
        targetModuleName,
      });
    }
  }

  /**
   * Send an API message through a socket.
   * @async
   * @private
   * @param {object} message Message object. `time`, `id`, `moduleName` and `data` keys will be added
   * to the message object. Unlike other mentioned fields `data` will not get overridden when provided.
   * @param {object} socket Socket instance.
   * @param {boolean} [relayedMessage=false]
   * @returns {Promise.<array, Error>}
   */
  async sendMessage(message, socket, relayedMessage = false) {
    message.id = uuid();

    if (!relayedMessage) {
      message.moduleName = this.moduleName;
    }

    message.time = new Date().valueOf();
    const packet = JSON.stringify(message);

    if (packet.length > this.maxPacketSize) {
      this.logger.trace(new Error('MAX_WS_PACKET_SIZE'));
    }

    socket.send(packet);

    if (!['event', 'response'].includes(message.type)) {
      let responseMessage;

      try {
        responseMessage = await onceMultiple(this, [`response::${message.id}`], this.overridenTimeout || message.timeout || this.messageTimeout);
      } catch (ex) {
        if (this.errorEmittingEnabled) {
          this.emit('error', ex);
          return;
        }

        const logger = this.logger || console;
        logger.debug(`${this.moduleName} failed to send message ${message.type} to ${message.targetModuleName || ''}`);
        return;
      }

      if (!responseMessage) return;

      if (responseMessage.success) {
        return responseMessage.data;
      } else {
        let errorMessage = `${message.moduleName}'s "${message.type}" request has failed.`;

        if (responseMessage.data instanceof Array && responseMessage.data.length && responseMessage.data[0].error) {
          errorMessage = responseMessage.data[0].error;
        }

        this.logger.error(errorMessage);
        throw new BrokerError(errorMessage);
      }
    }
  }

  /**
   * Send a ping request.
   * @param {string} targetModuleName 
   * @private
   */
  ping(targetModuleName) {
    return this.sendMessage({ type: `${targetModuleName}.ping` });
  }

  /**
   * @private 
   * @param {array} args 
   * @param {string} vendorName 
   * @param {string} moduleName 
   */
  emitMessage(args, vendorName, moduleName, options = {}) {
    const eventName = args.shift();

    if (typeof eventName !== 'string') {
      throw new Error('eventName must be a string');
    }

    const fullyQualifiedName = `${vendorName}.${moduleName}.${eventName}`;

    this.sendMessage({
      type: 'event',
      eventName: fullyQualifiedName,
      data: args,
      excludedClients: options.excludedClients || [],
    })
      .catch((err) => {
        if (this.errorEmittingEnabled) {
          this.emit('error', err);
          return;
        }

        console.error(`Couldn't emit ${fullyQualifiedName}`);

        if (err.code !== 'TIMEOUT') {
          console.trace(err);
        }
      });
  }

  destroy() {
    this.removeAllListeners();
    this.destroyed = true;
  }
}
