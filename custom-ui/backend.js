// Copyright (c) 2026 Zero Density Inc.
// SPDX-License-Identifier: GPL-2.0-only
const { EventEmitter } = require('node:events');

/**
 * @typedef {Object} Snapshot
 * @property {Object|null} state Auxiliary field state, persisted with the item.
 * @property {*} value Controller/form output.
 *
 * @typedef {Object} DataSnapshot
 * @property {boolean} hasValue
 * @property {*} data
 * @property {string|null} [error]
 * @property {boolean} [stale]
 * @property {string} [status] `disabled` when the host intentionally stops source traffic.
 *
 * @typedef {Object} Subscription
 * @property {function(): void} stop
 *
 * @typedef {Object} Watch
 * @property {function(Object): void} setParameters Replace parameters and discard obsolete deliveries.
 * @property {function(): void} stop
 *
 * @typedef {Object} BackendAPI Injected into the partner's exported start(api).
 * @property {number} apiVersion
 * @property {Object} context
 * @property {function(string, Function): void} export Register a frontend-callable function.
 * @property {function(string, *=): void} emit Send a custom event to attached frontends.
 * @property {function(string, Function): Function} on Subscribe using legacy direct callback delivery.
 * @property {function(function(Snapshot): *): Function} onStateChange Await external state changes in the handler queue.
 * @property {function(): Snapshot} getState Read the latest committed snapshot.
 * @property {function(Object): Promise<Snapshot>} update Replace each supplied snapshot property.
 * @property {function(Object): Promise<Snapshot>} patch Shallow-merge state and optionally commit output atomically.
 * @property {function(*): Promise<Snapshot>} setValue
 * @property {function(Object|null): Promise<Snapshot>} setState
 * @property {function(Function): void} schedule Queue background work after the current handler/startup.
 * @property {Object} data Named query bindings configured on the field.
 * @property {boolean} data.enabled Whether bound query traffic is enabled for this field.
 * @property {function(string, Object=): Promise<DataSnapshot>} data.request
 * @property {function(string, Object, Function, Function=): Subscription} data.subscribe Legacy direct callbacks.
 * @property {function(string, Object, Function, Function=): Watch} data.watch Await callbacks in the handler queue.
 */

// Transport and worker ownership belong to Hub. The same runtime supports memory-backed tests.
/**
 * Create the API used by a Hub worker container or an isolated test harness.
 * @param {Object} configuration
 * @param {Snapshot} configuration.snapshot
 * @param {Object} [configuration.context]
 * @param {function(string, Object): Promise<*>} configuration.request Platform request transport.
 * @param {function(string, *): void} configuration.emit Platform event transport.
 */
function createBackendRuntime({ snapshot: initial, context = {}, request, emit }) {
  const methods = new Map();
  const events = new EventEmitter();
  const stateListeners = new Set();
  let snapshot = structuredClone(initial);
  let snapshotSequence = 0;
  let subscriptionSequence = 0;
  let tasks = Promise.resolve();
  let writes = Promise.resolve();

  function enqueue(operation) {
    const run = tasks.then(operation);
    tasks = run.catch(() => {});
    return run;
  }

  function report(error) {
    emit('backenderror', error.message || String(error));
  }

  function commit(makePatch) {
    const run = writes.then(async () => {
      const saved = await request('update', makePatch());
      if (saved.sequence >= snapshotSequence) {
        snapshot = saved.snapshot;
        snapshotSequence = saved.sequence;
      }
      return structuredClone(snapshot);
    });
    writes = run.catch(() => {});
    return run;
  }

  function subscribe(query, parameters, onData, onError = () => {}) {
    const id = String(++subscriptionSequence);
    const listener = ({ snapshot: data, error }) => {
      if (error) onError(new Error(error));
      else onData(data);
    };
    events.on(`data:${id}`, listener);
    request('data.subscribe', { id, query, parameters }).catch((error) => {
      if (events.listeners(`data:${id}`).includes(listener)) onError(error);
    });
    return {
      stop: () => {
        events.off(`data:${id}`, listener);
        request('data.unsubscribe', { id }).catch(() => {});
      },
    };
  }

  function watch(query, parameters, onData, onError = report) {
    let subscription;
    let generation = 0;
    let stopped = false;
    const deliver = (mine, handler, value) => {
      enqueue(() => {
        if (!stopped && generation === mine) return handler(value);
        return undefined;
      }).catch(report);
    };
    const setParameters = (next) => {
      if (stopped) return;
      const mine = ++generation;
      subscription?.stop();
      subscription = subscribe(
        query,
        next,
        (data) => deliver(mine, onData, data),
        (error) => deliver(mine, onError, error)
      );
    };
    setParameters(parameters);
    return {
      setParameters,
      stop: () => {
        if (stopped) return;
        stopped = true;
        generation += 1;
        subscription.stop();
      },
    };
  }

  /** @type {BackendAPI} */
  const api = {
    apiVersion: 1,
    context,
    export: (name, handler) => {
      if (typeof name !== 'string' || !name || typeof handler !== 'function' || name === 'getState') {
        throw new Error('Invalid backend function.');
      }
      methods.set(name, handler);
    },
    emit: (name, payload = null) => emit(name, payload),
    on: (name, handler) => {
      events.on(name, handler);
      return () => events.off(name, handler);
    },
    onStateChange: (handler) => {
      stateListeners.add(handler);
      return () => stateListeners.delete(handler);
    },
    getState: () => structuredClone(snapshot),
    update: (patch) => {
      const clean = structuredClone(patch);
      return commit(() => clean);
    },
    patch: (patch) => {
      const clean = structuredClone(patch);
      if (Object.hasOwn(clean, 'state') && (!clean.state || Array.isArray(clean.state) || typeof clean.state !== 'object')) {
        throw new Error('State patch must be an object. Use setState(null) to clear it.');
      }
      return commit(() => ({
        ...clean,
        ...(Object.hasOwn(clean, 'state') ? { state: { ...snapshot.state, ...clean.state } } : {}),
      }));
    },
    setValue: (value) => api.update({ value }),
    setState: (state) => api.update({ state }),
    // Background tasks run after the current handler/initialization; failures are reported.
    schedule: (operation) => {
      enqueue(operation).catch(report);
    },
    data: {
      enabled: context.dataSourceEnabled !== false,
      request: (query, parameters = {}) => request('data.request', { query, parameters }),
      subscribe,
      watch,
    },
  };

  return {
    api,
    initialize: (start) => enqueue(() => start(api)),
    call: (name, args = []) =>
      enqueue(async () => {
        if (name === 'getState') {
          await writes;
          return api.getState();
        }
        const handler = methods.get(name);
        if (!handler) throw new Error(`Unknown backend function: ${name}`);
        return handler(...args);
      }),
    sync: (next, sequence) =>
      enqueue(async () => {
        if (sequence <= snapshotSequence) return;
        snapshot = structuredClone(next);
        snapshotSequence = sequence;
        const changed = api.getState();
        events.emit('stateupdate', structuredClone(changed));
        for (const handler of stateListeners) {
          // eslint-disable-next-line no-await-in-loop -- State observers participate in the same serial queue.
          await handler(structuredClone(changed));
        }
      }),
    deliverData: (message) => events.emit(`data:${message.id}`, message),
  };
}

module.exports = { createBackendRuntime };
