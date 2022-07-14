# Javascript Client for RealityHub API

A helper module to connect third-party modules to RealityHub.

## Installation

```bash
npm install @zerodensity/realityhub-api
```

## Using In a Browser

The client can be bundled for browsers with a bundling tool (e.g. rollup).

## Usage

### Connecting to Hub

```js
const { BrokerClient } = require('@zerodensity/realityhub-api');

BrokerClient.initModule({
  menuTitle: '<menu title>',
  clientModuleName: '<vendor name>.<your client module name>',
  moduleName: '<vendor name>.<your backend module name>',
  serverURL: '<your backend module>',
  hub: {
    host: '127.0.0.1',
    port: 3000,
  },
}).then((brokerClient) => {
  // brokerClient is connected to RealityHub and ready to use
});
```

### Listing the engines

```js
brokerClient.api.hub.reality_world.listEngines()
  .then((engines) => {
    console.log(engines);
  })
  .catch((ex) => console.trace(ex));
```

### Listing the nodes running on an engine

```js
brokerClient.api.hub.reality_world.getNodes(8 /* id of the engine */)
  .then((nodes) => {
    console.log(nodes);
  })
  .catch((ex) => console.trace(ex));
```

### Calling a Reality Node's Function

You can use `callNodeFunction(params[, engineIds])` to call a node function. `engineIds` is an array
of engine IDs. If `engineIds` is not supplied then the function will be called on all the engines.

```js
/**
 * @typedef FunctionProperty
 * @type {object}
 * @property {string} NodePath
 * @property {string} PropertyPath
 * @property {object} payload
 * @property {*} payload.value
 */

/**
 * Node_0's PLAY function is called
 * @param {object} params
 * @param {string} params.NodePath
 * @param {string} params.PropertyPath
 * @param {FunctionProperty[]} [params.functionProperties] - (optional)
 * @param {number} [engineIds] - (optional)
 */ 
brokerClient.api.hub.reality_world.callNodeFunction({
  NodePath: 'Mixer Default',
  PropertyPath: 'Default//DoTransition/0',
  functionProperties: [
    {
      NodePath: 'Mixer Default',
      PropertyPath: 'Default/DoTransition/Duration/0',
      payload: {
        value: 8,
      },
    },
  ],
}).catch((ex) => console.trace(ex));
```

### Setting a Reality Node's Property Value

You can use `setNodeProperty(params[, engineIds])` to set a node's property value. `engineIds` is an
array of engine IDs. If `engineIds` not supplied then all of the engines will receive the set node
property command.

```js
/**
 * @param {object} params
 * @param {string} params.NodePath
 * @param {string} params.PropertyPath
 * @param {*} params.Value
 * @param {number} [params.Delay=0] - (optional) Delay in seconds
 * @param {number} [params.Duration=0] - (optional) Duration in seconds
 * @param {Jump|Linear|EaseIn|EaseOut|EaseInOut} [params.InterpType=Jump] - (optional)
 * @param {number} [engineIds] - (optional)
 */
brokerClient.api.hub.reality_world.setNodeProperty({
  NodePath: 'Mixer Default',
  PropertyPath: 'Overlay Options//OverlayOpacity/0',
  Value: 0.240,
  InterpType: 'EaseOut',
  Duration: 1,
}).catch((ex) => console.trace(ex));
```

### Subscribing to Property Change Event

```js
// nodepropertyupdate event has a special sytax. You have to supply an engine id and the node's path in order to
// subscribe to its property change events. The engine id, event name and node path are delitimed by 2 colons.

brokerClient.api.hub.reality_world.listEngines()
  .then((engines) => engines[0].id)
  .then((engineId) => {
    brokerClient.api.hub.reality_world.on(`nodepropertyupdate::${engineId}::Mixer_0`, (eventData) => {
      if (eventData.property.PropertyPath !== 'Overlay Options//OverlayOpacity/0') return;

      console.log('New value of overlay opacity is', eventData.property.Value);
    });
  })
  .catch((ex) => console.trace(ex));
```

### Registering Your Own Methods to RealityHub

```js
// server.js

// This will simply return the sum of 2 numbers.
function addNumbers(number1, number2) {
  return number1 + number2;
}

// This will return a promise that will resolve after 1 second.
function multiplyNumbers(number1, number2) {
  return new Promise((resolve) => {
    setTimeout(() => {
      const result = number1 * number2;
      resolve(result);
    }, 1000);
  });
}

// This function will resolve after `taskDuration` seconds.
function longTask(taskDuration) {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(`Long Task has finished after ${taskDuration} seconds.`);
    }, taskDuration * 1000);
  });
}

// Let's register these as our API methods
brokerClient.api.exampleCompany.exampleModule.registerAPIHandlers({
  addNumbers,  
  multiplyNumbers,
  performSlowTask: longTask,
}).catch((ex) => console.trace(ex));
```

```js
// client.js
brokerClient.api.exampleCompany.exampleModule.addNumbers(3, 5)
  .then((result) => {
    console.log('The result of addNumbers() is', result);
  });

brokerClient.api.exampleCompany.exampleModule.performAsyncMultiplication(3, 5)
  .then((result) => {
    console.log('The result of performAsyncMultiplication() is', result);
  });

// Default timeout for API requests is 2 seconds. We need to specify a longer timeout for our slow async task.
const timeout = 10 * 1000; // 10 seconds
brokerClient.api.exampleCompany.exampleModule.callTimeout(timeout)
  .slowAsyncTask(5)
  .then((result) => console.log('Slow async task returned:', result));
```

### Emitting Events

```js
// server.js

// Emit a random number every second
setInterval(() => {
  // A random number between 0 and 1000.
  const randomNumber = Math.round(Math.random() * 1000);
  brokerClient.api.exampleCompany.exampleModule.emit('randomnumber', randomNumber);  
}, 1000);
```

```js
// client.js

brokerClient.api.exampleCompany.exampleModule.on('randomnumber', (randomNumber) => {
  console.log('Received a random number from the server', randomNumber);
});  
```

### Questions and Feedback

We have a growing community. You can join to [RealityHub User Group on Facebook](https://www.facebook.com/groups/realityengine).

You are welcome to open an issue if you have found a bug or have a feature request.
