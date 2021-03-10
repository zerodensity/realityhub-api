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
const BrokerBase = require('./BrokerBase.js');
const BrokerError = require('./BrokerError.js');
const RawRequest = require('./RawRequest.js');
const consoleLogger = require('./consoleLogger.js');
const onceMultiple = require('./onceMultiple.js');

let ws;

const runningInBrowser = typeof window !== 'undefined';

if (runningInBrowser) {
  ws = WebSocket;
} else {
  ws = require('ws');
}

module.exports = class BrokerClient extends BrokerBase {
  /**
   * BrokerClient constructor
   * @param {object} params Parameters
   * @param {string} params.webSocketURL WebSocket URL
   * @param {Logger} [params.logger] Logger instance
   * @param {boolean} [params.isDuplicate] [Private property, used internally]
   * @param {boolean} [params.parent] [Private property, used internally]
   */
  constructor(params = {}) {
    super(params);

    this.setMaxListeners(20);

    for (const func of [
      this.onOpen,
      this.onClose,
      this.onError,
      this.connect,
      this.onSocketMessage,
    ]) {
      const name = func.name;
      this[name] = func.bind(this);
    }

    this.logger = params.logger || consoleLogger(this.moduleName, { silent: true });

    this.isDuplicate = params.isDuplicate;
    this.parent = params.parent;
    this.duplicates = new Set();

    // moduleName of the server (will be set when we receive a ping message)
    this.serverModuleName = null;

    /**
     * A set of module names
     * Each time registerHandlersToRemote is called, the `remote` is added to this set.
     * BrokerClient uses the list of the remote endpoints for re-registering after a
     * reconnect.
     * @type {Set<string>}
     */
    this.registrars = new Set();

    this.webSocketURL = params.webSocketURL;
    this.connected = false;

    if (this.isDuplicate) {
      this.connected = this.isConnected();
    }
  }

  /**
   * Returns a `Promise` that will resolve once a `connect` event is emitted.
   * If BrokerClient is already connected then it will resolve in the next
   * event loop.
   * @returns {Promise}
   */
  getConnectPromise() {
    return new Promise((resolve) => {
      const looper = setInterval(() => {
        if (this.connected) {
          clearInterval(looper);
          resolve();
        }
      }, 0);
    });
  }

  forceReconnect() {
    this.removeSocketListeners();
    this.socket = null;
    this.connect(this.connectOptions);
  }

  /**
   * Connect to server.
   * @param {object} options Options
   * @param {string} options.host Hostname or IP of the target server.
   * @param {number} options.port WebSocket port of the target server.
   */
  connect(options) {
    if (this.isDuplicate) return;

    this.connectOptions = options;
    let url;

    if (!options) {
      url = new URL(location.href);
    } else {
      url = { hostname: options.host, port: options.port };
    }

    const webSocketURL = url.port
      ? `ws://${url.hostname}:${url.port}${this.webSocketURL}`
      : `ws://${url.hostname}${this.webSocketURL}`;

    this.socket = new ws(webSocketURL);
    this.addSocketListeners();
  }

  /**
   * Duplicates a BrokerClient in order to share the same WebSocket.
   * @param {object} params Parameters
   * @param {string} params.moduleName Module name of the duplicate BrokerClient (a duplicate 
   * can have a different name than its parent)
   * @returns {BrokerClient}
   */
  duplicate(params) {
    const { moduleName } = params;
    let duplicates;
    let duplicate;

    if (this.isDuplicate) {
      duplicates = this.parent.duplicates;
      duplicate = new BrokerClient({
        parent: this.parent,
        isDuplicate: true,
        webSocketURL: this.webSocketURL,
        logger: this.logger,
        moduleName,
      });
    } else {
      duplicates = this.duplicates;
      duplicate = new BrokerClient({
        parent: this,
        isDuplicate: true,
        webSocketURL: this.webSocketURL,
        logger: this.logger,
        moduleName,
      });
    }

    duplicate.on('destroy', () => duplicates.delete(duplicate));
    duplicates.add(duplicate);

    duplicate
      .ping()
      .catch((ex) => {
        console.error(`Failed to send ping`);
        console.trace(ex.message);
      });

    return duplicate;
  }

  /**
   * Returns `true` if WebSocket connection is established.
   * @returns {boolean}
   */
  isConnected() {
    if (this.isDuplicate) {
      return this.parent.isConnected();
    }

    return this.connected;
  }

  /**
   * Sends a ping message to server.
   * @private
   */
  ping() {
    return this.sendMessage({ type: 'ping' });
  }

  /**
   * Returns the WebSocket instance.
   * @private
   */
  getSocket() {
    return this.socket;
  }

  async onSocketMessage(event) {
    try {
      await this.handleMessage(event.data, this.socket);
    } catch (ex) {
      console.trace(ex);
    }
  }

  /**
   * Handles incoming messages.
   * @param {string} rawMessage Raw message
   * @async
   * @private
   */
  async handleMessage(rawMessage) {
    let message;

    try {
      message = JSON.parse(rawMessage);
      const socket = this.isDuplicate ? this.parent.getSocket() : this.socket;

      switch (message.type) {
        case 'response': {
          this.emit(`response::${message.requestId}`, message);

          // Send the response to other duplicates (if we are parent)
          if (!this.isDuplicate) {
            for (const duplicate of this.duplicates) {
              duplicate.handleMessage(rawMessage);
            }
          }

          break;
        }

        case 'event': {
          // Run previously registered event handlers
          for (const [subscribedEvent, entries] of this.events.entries()) {
            if (subscribedEvent === message.eventName) {
              for (const entry of entries) {
                try {
                  entry.eventHandler(...message.data);
                } catch (ex) {
                  this.logger.warn(ex);
                } finally {
                  if (entry.once) {
                    this.unsubscribeFromAPIEvent(subscribedEvent, entry.eventHandler);
                  }
                }
              }
            }
          }

          // Send the event to other duplicates (if we are parent)
          if (!this.isDuplicate) {
            for (const duplicate of this.duplicates) {
              duplicate.handleMessage(rawMessage);
            }
          }

          break;
        }

        case 'subscribe': {
          const arr = message.eventName.split('.');
          const eventName = arr.pop();
          const targetModuleName = arr.join('.');

          if (this.moduleName === targetModuleName) {
            this.emit('subscribe', { eventName });
            await this.sendResponse(socket, message, true);
          } else {
            // Check if the target is one of the duplicates (if we are parent)
            if (!this.isDuplicate) {
              for (const duplicate of this.duplicates) {
                if (duplicate.moduleName === targetModuleName) {
                  duplicate.handleMessage(rawMessage);
                  return;
                }
              }
            }

            await this.sendResponse(
              socket,
              message,
              false,
              [{ error: `${message.eventName} sent to ${this.moduleName}. This is probably a mistake.` }],
            );
          }

          break;
        }

        case 'unsubscribe': {
          const arr = message.eventName.split('.');
          const eventName = arr.pop();
          const targetModuleName = arr.join('.');

          if (this.moduleName === targetModuleName) {
            this.emit('unsubscribe', { eventName });
            await this.sendResponse(socket, message, true);
          } else {
            // Check if the target is one of the duplicates (if we are parent)
            if (!this.isDuplicate) {
              for (const duplicate of this.duplicates) {
                if (duplicate.moduleName === targetModuleName) {
                  duplicate.handleMessage(rawMessage);
                  return;
                }
              }
            }

            await this.sendResponse(
              socket,
              message,
              false,
              [{ error: `${message.eventName} sent to ${this.moduleName}. This is probably a mistake.` }],
            );
          }

          break;
        }

        case 'ping': {
          this.serverModuleName = message.moduleName;

          if (!this.isDuplicate && message.targetModuleName !== this.moduleName) {
            for (const duplicate of this.duplicates) {
              if (duplicate.moduleName === message.targetModuleName) {
                duplicate.handleMessage(rawMessage);
                return;
              }
            }
          }

          await Promise.all([
            this.sendResponse(socket, message, true),
            this.resubscribeModuleEvents(),
            this.subscribeToAPIEvent(`${message.moduleName}.moduleconnect`, ({ moduleName }) => {
              this.emit('moduleconnect', { moduleName });
              this.resubscribeModuleEvents();
            }),
            this.subscribeToAPIEvent(`${message.moduleName}.moduledisconnect`, ({ moduleName }) => {
              this.emit('moduledisconnect', { moduleName });
            }),
          ]);

          break;
        }

        default: {
          if (!this.apiHandlers.has(message.type)) {
            await this.sendResponse(
              socket,
              message,
              false,
              [{ error: `There is no handler registered for this type of message: ${message.type}` }],
            );
            return;
          }

          const { messageHandler, relay } = this.apiHandlers.get(message.type);

          try {
            let responseMessage = await messageHandler(...message.data);

            if (responseMessage instanceof RawRequest) {
              const rawRequest = responseMessage;
              rawRequest.setInstigatorId(message.instigatorId);
              responseMessage = await rawRequest.call(...message.data);
            }

            await this.sendResponse(socket, message, true, responseMessage, relay);
          } catch (ex) {
            if (ex instanceof BrokerError) {
              this.logger.error(ex.message);
              await this.sendResponse(socket, message, false, [{ error: ex.message }], relay);
              return;
            }

            this.logger.trace(ex);
            await this.sendResponse(socket, message, false, [{ error: 'ERROR' }], relay);
          }

          break;
        }
      }
    } catch (ex) {
      if (ex.code === 'TIMEOUT') {
        console.warn('Message timed out.');
        console.log(message);
        return;
      }

      console.trace(ex);
    }
  }

  /**
   * Sends a message.
   * @async
   * @param {object} message 
   * @returns {Promise.<Array, Error>}
   */
  async sendMessage(message) {
    const id = uuid();
    const socket = this.isDuplicate ? this.parent.getSocket() : this.socket;
    const webSocketMessage = Object.assign(
      {},
      message,
      {
        id,
        time: new Date().valueOf(),
        moduleName: this.moduleName,
      },
    );

    if (socket.readyState !== ws.OPEN) {
      try {
        await onceMultiple(this, ['connect'], webSocketMessage.timeout || this.messageTimeout);
      } catch (ex) {
        console.error(`Timeout: Socket is not ready`);
        throw ex;
      }
    }

    let ret;

    try {
      ret = super.sendMessage(webSocketMessage, socket);
    } catch (ex) {
      console.error(`BrokerBase::sendMessage throwed an exception`);
      throw ex;
    }

    return ret;
  }

  /**
   * @private
   */
  addSocketListeners() {
    if (this.isDuplicate) return;

    this.socket.addEventListener('open', this.onOpen);
    this.socket.addEventListener('message', this.onSocketMessage);
    this.socket.addEventListener('error', this.onError);
    this.socket.addEventListener('close', this.onClose);
  }

  removeSocketListeners() {
    if (!this.socket) return;

    this.socket.removeEventListener('open', this.onOpen);
    this.socket.removeEventListener('message', this.onSocketMessage);
    this.socket.removeEventListener('error', this.onError);
    this.socket.removeEventListener('close', this.onClose);
  }

  /**
   * @private
   */
  resubscribeModuleEvents() {
    for (const eventName of this.events.keys()) {
      const moduleName = eventName
        .split('.')
        .slice(0, 2)
        .join('.');

      this
        .sendMessage({
          type: 'subscribe',
          eventName,
          targetModuleName: moduleName,
        })
        .catch(new Function());
    }
  }

  /**
   * @async
   * @private
   */
  async onOpen() {
    try {
      this.connected = true;
      this.emit('connect');

      if (this.isDuplicate) {
        await this.ping();
      }

      for (const registrar of this.registrars) {
        await this.registerHandlersToRemote(registrar);
      }

      if (!this.isDuplicate) {
        for (const duplicate of this.duplicates) {
          duplicate.onOpen();
        }
      }
    } catch (ex) {
      console.trace(ex.message);
    }
  }

  /**
   * @private
   * @param {ErrorEvent} err 
   */
  onError(err) {
    if (err.error instanceof Error) {
      err = err.error.message;
    }

    if (!this.isDuplicate) {
      this.logger.trace(err);
    }

    if (!this.isDuplicate) {
      this.logger.warn(`${this.moduleName} couldn't connect to WebSocket server.`);

      for (const duplicate of this.duplicates) {
        duplicate.onError(err);
      }
    }
  }

  /**
   * @private
   */
  onClose() {
    if (this.connected) {
      this.connected = false;
      this.emit('disconnect');
      this.events.delete(`${this.serverModuleName}.moduleconnect`);

      if (!this.isDuplicate) {
        for (const duplicate of this.duplicates) {
          duplicate.onClose();
        }
      }
    }

    setTimeout(() => this.connect(this.connectOptions), 1000);
  }

  /**
   * Send the local API handler list to the `targetModuleName` so it will relay
   * messages targeting those handlers.
   * @param {string} targetModuleName Module name of the API Server
   * @returns {Promise.<Array, Error>}
   */
  registerHandlersToRemote(targetModuleName) {
    this.registrars.add(targetModuleName);

    return this.sendMessage({
      type: `${targetModuleName}.registerAPIHandlers`,
      data: Array.from(this.apiHandlers.keys()),
      targetModuleName,
    });
  }

  /**
   * Send a message to all remote endpoints telling them not to relay any messages
   * to this module anymore.
   * @async
   * @returns {Promise.<Array, Error>[]}
   */
  async deregisterHandlersFromRemotes() {
    try {
      const promises = [];

      for (const registrar of this.registrars) {
        promises.push(
          this.sendMessage({
            type: `${targetModuleName}.deregisterAPIHandlers`,
            data: Array.from(this.apiHandlers.keys()),
            targetModuleName: registrar,
          })
        );
      }

      return Promise.all(promises);
    } catch (ex) {
      console.trace(ex.message);
    }
  }

  /**
   * Unsubscribes from all subscriptions.
   * @returns {Promise.<Array, Error>[]}
   */
  unsubscribeFromAllEvents() {
    const promises = [];

    for (const eventName of this.events.keys()) {
      promises.push(this.unsubscribeFromAPIEvent(eventName));
    }

    return Promise.all(promises);
  }

  /**
   * Performs cleanup.
   * @async
   */
  async destroy() {
    try {
      if (this.isDuplicate) {
        await Promise.all([
          this.deregisterHandlersFromRemotes(),
          this.unsubscribeFromAllEvents(),
          this.sendMessage({
            type: 'event',
            eventName: `${this.moduleName}.disconnect`,
            targetModuleName: this.serverModuleName,
          }),
        ]);
        this.emit('destroy');
      } else {
        this.socket.close();
        this.removeSocketListeners();
        super.destroy();
      }
    } catch (ex) {
      console.trace(ex.message);
    }
  }

  /** 
   * Register a module's API handlers to Reality Hub
   * @async
   * @param {Object.<string, function>} handlers Key will be registered to the API tree. 
   * @param {*} [context=null] Handlers' `this` will be set to this context.
   * The value (function) will handle the API calls. 
   * @param {string} [remote='hub.core'] Remote 
   * @example
   * // server.js
   * brokerClient.registerAPIHandlers(this, {
   *   addNumbers: function (number1, number2) {
   *     return number1 + number2;
   *   },
   * }).catch((ex) => console.trace(ex));
   * 
   * // client.js
   * brokerClient.api.moduleVendor.moduleName.addNumber(3, 5)
   *   .then((result) => {
   *     // Will log 15
   *     console.log(result);
   *   })
   *   .catch((ex) => console.trace(ex));
   * @returns {Promise}
   */
  async registerAPIHandlers(handlers, context = null, remote = 'hub.core') {
    for (const [handlerName, handler] of Object.entries(handlers)) {
      this.registerAPIHandler(handlerName, handler.bind(context));
    }

    return this.registerHandlersToRemote(remote);
  }

  /**
   * Third-party modules can use this method to initialize a BrokerClient
   * and register themselves to Reality Hub.
   * @async
   * @static
   * @param {{ moduleName: string, serverURL: string, webSocketURL?: string, hub: {host: string, port: number }}} params Parameters
   * @param {string} params.moduleName Module Name (`<vendor>.<product name>`)
   * @param {string} params.serverURL Your module has to serve your client files over HTTP or HTTPS.
   * Reality Hub will look for an `index.js` file in this path. This script file will be imported
   * by Reality Hub's `index.html` via a `<script type="module">` tag. Relative paths in your scripts
   * will be proxied by Reality Hub.
   * @param {string} [params.webSocketURL="/core"] WebSocket URL to connect. Reality Hub's API Server 
   * is serving at `/core` by default. *(Default: /core)* 
   * @param {{ host: string, port: number }} params.hub Reality Hub connection parameters
   * @param {string} params.hub.host Reality Hub hostname or IP address
   * @param {string} params.hub.port Reality Hub port
   * @returns {Promise<BrokerClient, Error>} A BrokerClient instance.
   */
  static async initModule(params) {
    const { moduleName, serverURL, hub, webSocketURL = '/core' } = params;
    const hubClient = new BrokerClient({ moduleName, webSocketURL });

    hubClient.connect(hub);
    await hubClient.getConnectPromise();
    if (!serverURL) return hubClient;

    await hubClient.api.hub.core.registerProxyURL({ moduleName, serverURL });
    return hubClient;
  }
}
