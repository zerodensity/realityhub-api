# Javascript Client for RealityHub API

A helper module to connect third-party modules to RealityHub.

##  Support Requests

This repository is for distribution only. For support please visit: [Zero Density Support](https://docs.zerodensity.io/reality/reality-hub-developers-guide/reality-hub-open-source-sdk).

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
    port: 80,
  },
}).then((brokerClient) => {
  // brokerClient is connected to RealityHub and ready to use
});
```

### Listing Reality 5 (API v1.2+) engines

```js
brokerClient.api.hub.reality5_1_2_world.listEngines()
  .then((engines) => {
    console.log(engines);

    /**
     * [
     *    {
     *      ip: '172.16.1.181',
     *      port: 50052,
     *      id: 79,
     *      name: 'ZDHQ-HUB-AMPERE',
     *      ready: true,
     *      status: 'connected',
     *      fps: '', // If there is no UE5 node, FPS will be an empty string
     *      engineType: 'RE5_1_2'
     *    }
     *  ]
     */
  })
  .catch((ex) => console.trace(ex));
```

### Listing the nodes running on an Reality 5 engine (API v1.2+)

```js
brokerClient.api.hub.reality5_1_2_world.getNodes(79 /* id of the engine */)
  .then((nodes) => {
    console.log(nodes);

    /**
       * {
       *    ...
       *    // The keys are the NodePath
       *    Cyclorama: {
       *       ...
       *       Functions: {
       *        // The keys are the FunctionPath
       *        'Cyclorama/AddProjection': {...},
       *        'Cyclorama/ClearProjection': {...},
       *       }
       *       ...
       *    }
       *    ...
       * }
       */

      // NOTE: For backward compatiblity, the NodePath and FunctionPath omit the leading '/'.
  })
  .catch((ex) => console.trace(ex));
```

### Calling a Node's Function

You can use `callNodeFunction(params[, engineIds])` to call a node function. `engineIds` is an array
of engine IDs. If `engineIds` is not supplied then the function will be called on all the engines.

```js
/**
 * Cyclorama's Add Projection function is called
 * @param {object} params
 * @param {string} params.NodePath
 * @param {string} params.PropertyPath
 * @param {number} [engineIds] - optional, default is all engines
 */ 
brokerClient.api.hub.reality5_1_2_world.callNodeFunction({
  NodePath: '/Cyclorama',
  FunctionPath: '/Cyclorama/AddProjection',
}, [/* engine id = */ 79]).catch((ex) => console.trace(ex));
```

### Setting a Node's Property Value

You can use `setNodeProperty(params[, engineIds])` to set a node's property value. `engineIds` is an
array of engine IDs. If `engineIds` not supplied then all of the engines will receive the set node
property command.

```js
/**
 * @param {object} params
 * @param {string} params.NodePath
 * @param {string} params.PropertyPath
 * @param {*} params.Value
 * @param {number} [engineIds] - (optional)
 */
brokerClient.api.hub.reality5_1_2_world.setNodeProperty({
  NodePath: '/Add_f32',
  PropertyPath: 'X',
  Value: 0.240,
}, [/* engine id = */ = 79]).catch((ex) => console.trace(ex));
```

### Interpolating a Node's Property Value

You can use `interpolate(params[, engineIds])` to interpolate a node's property value. `engineIds` is an array of engine IDs. If `engineIds` not supplied then all of the engines will receive the same interpolate command.

```js
brokerClient.api.hub.reality5_1_2_world.interpolate({
  NodePath: '/Add_f32',
  PropertyPath: 'X',
  StartValue: 5.0, // optional, default is the current value
  EndValue: 10.0,
  Duration: 2000, // in milliseconds, optional, default is 0
  Delay: 2000, // in milliseconds, optional, default is 0

  /** @type {'Jump' | 'Linear' | 'EaseIn' | 'EaseOut' | 'EaseInOut'} */
  InterpType: 'EaseIn', // optional, default is 'Jump'
}, [/* engine id = */ 79]).catch((ex) => console.trace(ex));
```

### Getting a Node's Property Value

You can use `getNodeProperty(params[, engineIds])` to get a node's property value. `engineIds` is an array of engine IDs. If `engineIds` not supplied then all of the engines will be queried. That is why this method returns an array of promises.

```js
brokerClient.api.hub.reality5_1_2_world.getNodeProperty(
  { NodePath: '/Add_f32', PropertyPath: 'X', }, 
  [/* engine id = */ 79]
)
.then((results) => {
  console.log(results[0].Value);
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
