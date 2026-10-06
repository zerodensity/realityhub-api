// Copyright (c) 2026 Zero Density Inc.
// SPDX-License-Identifier: GPL-2.0-only
const clients = new WeakMap();
const copy = (value) => JSON.parse(JSON.stringify(value));

/**
 * @typedef {Object} ClientView
 * @property {Object|null} state Latest authoritative field state.
 * @property {*} value Latest controller/form output.
 * @property {boolean} readOnly
 * @property {Object} context
 * @property {boolean} backend
 * @property {boolean} paused
 * @property {'connecting'|'connected'|'disconnected'|'closed'|'error'} connection
 * @property {string|null} error
 *
 * @typedef {Object} Client
 * @property {number} apiVersion
 * @property {function(function(ClientView): void): Function} subscribe Replay the current view and observe changes.
 * @property {function(): Promise<ClientView>} ready Wait for host initialization and backend readiness.
 * @property {function(): Promise<{state: Object|null, value: *}>} getState Read on demand without replacing newer observed state.
 * @property {function(string, ...*): Promise<*>} call Invoke a named backend function.
 * @property {function(string, Function): Function} on Observe a custom backend event.
 * @property {function(*): Promise<boolean>} setValue Update frontend-only output.
 * @property {function(Object|null): Promise<Object|null>} setState Update frontend-only state.
 * @property {Object} data Frontend query request/subscribe operations through the host.
 * @property {function(string, Object=): Promise<import('./backend').DataSnapshot>} data.request
 * @property {function(string, Object, Function, Function=): import('./backend').Subscription} data.subscribe
 * @property {function(): void} destroy Release this client's resources; Hub retains worker ownership.
 */

/**
 * Join the iframe's existing Hub connection. Requests default to a 15-second deadline.
 * @param {Object} [options]
 * @param {Window} [options.window] The iframe window; injectable for tests.
 * @param {number} [options.timeoutMs=15000]
 * @returns {Client}
 */
function createClient({ window: target = window, timeoutMs = 15000 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Request timeout must be positive.');
  if (clients.has(target)) return clients.get(target);
  const backend = target.hubBackend;
  const observers = new Set();
  const subscriptions = new Map();
  const operations = new Set();
  const pending = new Map();
  const cleanup = new Set();
  let port;
  let initialized = false;
  let destroyed = false;
  let fatalError;
  let sequence = 0;
  let backendConnection = 'connecting';
  let view = {
    state: null,
    value: null,
    readOnly: true,
    context: {},
    backend: Boolean(backend),
    paused: false,
    connection: 'connecting',
    error: null,
  };

  function update(changes) {
    view = { ...view, ...changes };
    for (const observer of observers) {
      try {
        observer(copy(view));
      } catch (error) {
        console.error(error);
      }
    }
    for (const operation of [...operations]) operation.begin();
  }

  function perform(start, requireConnected = false, trackCancellation = null) {
    return new Promise((resolve, reject) => {
      let started = false;
      let finished = false;
      let cancel = () => {};
      let requestId;
      let timer;
      let operation;
      const deadlineAt = Date.now() + timeoutMs;
      const finish = (error, result) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        operations.delete(operation);
        if (trackCancellation) trackCancellation(null);
        if (requestId) pending.delete(requestId);
        if (error) {
          cancel();
          if (!destroyed) update({ error: error.message });
          reject(error);
        } else resolve(result);
      };
      operation = {
        finish,
        begin: () => {
          if (finished || started) return;
          if (destroyed || fatalError) {
            finish(fatalError || new Error('Custom UI client closed.'));
            return;
          }
          if (view.connection === 'closed') {
            finish(new Error('Backend closed.'));
            return;
          }
          if (!initialized || (requireConnected && view.connection !== 'connected')) return;
          started = true;
          try {
            start({
              finish,
              remaining: Math.max(1, deadlineAt - Date.now()),
              setCancel: (handler) => {
                cancel = handler;
              },
              hostRequest: (type, payload = {}) => {
                requestId = String(++sequence);
                pending.set(requestId, finish);
                port.postMessage({ protocol: 1, id: requestId, type, ...payload });
              },
            });
          } catch (error) {
            finish(error);
          }
        },
      };
      timer = setTimeout(() => finish(new Error('Custom UI request timed out.')), timeoutMs);
      if (trackCancellation) trackCancellation(() => finish(null, true));
      operations.add(operation);
      operation.begin();
    });
  }

  function hostRequest(type, payload) {
    return perform((operation) => operation.hostRequest(type, payload));
  }

  function backendRequest(name, args) {
    return perform((operation) => {
      if (!backend) throw new Error('This custom UI has no backend.');
      if (view.readOnly && name !== 'getState') throw new Error('This field is read-only.');
      const request = backend.request(name, args, operation.remaining);
      operation.setCancel(request.cancel);
      request.promise.then(
        (result) => operation.finish(null, result),
        (error) => operation.finish(error)
      );
    });
  }

  function unsubscribe(id) {
    const subscription = subscriptions.get(id);
    if (!subscription) return;
    subscriptions.delete(id);
    if (subscription.cancelRequest) subscription.cancelRequest();
    if (port) port.postMessage({ protocol: 1, id: String(++sequence), type: 'unsubscribe', subscription: id });
  }

  function receive({ data: message }) {
    if (destroyed || message.protocol !== 1) return;
    if (message.type === 'result') {
      const finish = pending.get(message.id);
      if (finish) finish(message.error ? new Error(message.error) : null, message.result);
    } else if (message.type === 'init') {
      if (message.apiVersion !== 1 || (message.backend && !backend)) {
        fatalError = new Error('This SDK requires Reality Hub custom UI API version 1.');
        update({ connection: 'error', error: fatalError.message });
        return;
      }
      initialized = true;
      update({
        readOnly: Boolean(message.readOnly),
        context: message.context || {},
        paused: Boolean(message.paused),
        connection: backend ? backendConnection : 'connected',
        ...(!backend ? { state: message.state || null, value: message.value === undefined ? null : message.value } : {}),
      });
    } else if (message.type === 'value') {
      update({ readOnly: Boolean(message.readOnly), ...(!backend ? { value: message.value } : {}) });
    } else if (message.type === 'paused') {
      update({ paused: Boolean(message.paused) });
    } else if (message.type === 'data' || message.type === 'queryError') {
      const handle = subscriptions.get(message.subscription);
      if (handle) {
        try {
          if (message.type === 'data') handle.onData(message.snapshot);
          else handle.onError(new Error(message.error));
        } catch (error) {
          update({ error: error.message });
        }
      }
    }
  }

  function connect(event) {
    if (event.source !== target.parent || !event.data || event.data.type !== 'hub.xui.connect') return;
    if (event.data.protocol !== 1 || !event.ports[0] || port || destroyed) return;
    [port] = event.ports;
    target.removeEventListener('message', connect);
    port.onmessage = receive;
    port.start();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    target.removeEventListener('message', connect);
    target.removeEventListener('pagehide', destroy);
    for (const id of [...subscriptions.keys()]) unsubscribe(id);
    for (const operation of [...operations]) operation.finish(new Error('Custom UI client closed.'));
    for (const off of cleanup) off();
    cleanup.clear();
    if (port) port.close();
    update({ connection: 'closed' });
    observers.clear();
    clients.delete(target);
  }

  const client = {
    apiVersion: 1,
    subscribe: (observer) => {
      if (destroyed) throw new Error('Custom UI client closed.');
      observers.add(observer);
      observer(copy(view));
      return () => observers.delete(observer);
    },
    ready: () => perform((operation) => operation.finish(null, copy(view)), true),
    getState: () =>
      backend ? backendRequest('getState', []) : hostRequest('loadState').then((state) => ({ state, value: view.value })),
    call: (name, ...args) => backendRequest(name, args),
    on: (name, handler) => {
      if (destroyed) throw new Error('Custom UI client closed.');
      if (!backend) throw new Error('This custom UI has no backend.');
      const off = backend.on(name, handler);
      const stop = () => {
        off();
        cleanup.delete(stop);
      };
      cleanup.add(stop);
      return stop;
    },
    setValue: (value) =>
      hostRequest('setValue', { value }).then((result) => {
        if (!destroyed) update({ value });
        return result;
      }),
    setState: (state) =>
      hostRequest('saveState', { state }).then((saved) => {
        if (!destroyed) update({ state: saved });
        return saved;
      }),
    data: {
      request: (query, parameters = {}) => hostRequest('request', { query, parameters }),
      subscribe: (query, parameters, onData, onError = (error) => update({ error: error.message })) => {
        if (destroyed) throw new Error('Custom UI client closed.');
        const id = `query_${++sequence}`;
        const handle = { onData, onError };
        subscriptions.set(id, handle);
        perform(
          (operation) => operation.hostRequest('subscribe', { query, parameters, subscription: id }),
          false,
          (cancel) => {
            handle.cancelRequest = cancel;
          }
        ).catch((error) => {
          if (subscriptions.has(id)) {
            unsubscribe(id);
            onError(error);
          }
        });
        return { stop: () => unsubscribe(id) };
      },
    },
    destroy,
  };
  clients.set(target, client);
  if (backend) {
    if (backend.apiVersion !== 1 || typeof backend.subscribe !== 'function' || typeof backend.request !== 'function') {
      fatalError = new Error('This SDK requires Reality Hub custom UI API version 1.');
      update({ connection: 'error', error: fatalError.message });
    } else {
      cleanup.add(
        backend.subscribe(({ snapshot, connection, error }) => {
          backendConnection = connection;
          update({
            connection: initialized ? connection : 'connecting',
            error,
            ...(snapshot ? { state: snapshot.state, value: snapshot.value } : {}),
          });
        })
      );
    }
  }
  target.addEventListener('message', connect);
  target.addEventListener('pagehide', destroy);
  return client;
}

exports.createClient = createClient;
