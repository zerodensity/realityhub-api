import { EventEmitter } from 'events';

export class BrokerError extends Error {}

export class RawRequest {
  setCallback(callback: Function): void;
  setAncillaryData(ancillaryData: any): void;
  getAncillaryData(): any;
  call(...args: any[]): any;
}

export interface Logger {
  log(...args: any[]): void;
  info(...args: any[]): void;
  warn(...args: any[]): void;
  error(...args: any[]): void;
  debug(...args: any[]): void;
  trace(...args: any[]): void;
}

export interface BrokerBaseParams {
  moduleName?: string;
  maxPacketSize?: number;
  logger?: Logger;
}

export class BrokerBase extends EventEmitter {
  constructor(params: BrokerBaseParams);
  moduleName: string;
  maxPacketSize: number;
  logger: Logger;
  apiHandlers: Map<string, any>;
  events: Map<string, any>;
  api: {
    [vendor: string]: {
      [module: string]: {
        emit(eventName: string, ...args: any[]): void;
        on(eventName: string, handler: Function): void;
        off(eventName: string, handler: Function): void;
        once(eventName: string, handler: Function): void;
      } & {
        [method: string]: <T = any>(...args: any[]) => Promise<T>;
      };
    };
  };

  getMethodProxy(vendorName: string, moduleName: string, options?: any): any;
  initProxy(): void;
  sendResponse(socket: any, message: any, success: boolean, data?: any[], relayedMessage?: boolean): Promise<any>;
  registerAPIHandler(messageType: string, messageHandler: Function): boolean;
  subscribeToAPIEvent(
    eventName: string,
    eventHandler: Function,
    options?: { sendMessage?: boolean; once?: boolean }
  ): Promise<any>;
  unsubscribeFromAPIEvent(eventName: string, eventHandler?: Function, sendMessage?: boolean): Promise<any>;
  sendMessage(message: any, socket: any, relayedMessage?: boolean): Promise<any>;
  ping(targetModuleName: string): Promise<any>;
  emitMessage(args: any[], vendorName: string, moduleName: string, options?: any): void;
  destroy(): void | Promise<void>;
}

export interface BrokerClientParams extends BrokerBaseParams {
  webSocketURL?: string;
  isDuplicate?: boolean;
  parent?: BrokerClient;
  ssl?: boolean;
}

export interface ConnectOptions {
  host: string;
  port: number;
}

export interface InitModuleParams {
  clientModuleName?: string;
  menuTitle?: string;
  moduleName: string;
  serverURL?: string;
  webSocketURL?: string;
  hub: ConnectOptions;
}

export class BrokerClient extends BrokerBase {
  constructor(params?: BrokerClientParams);
  webSocketURL: string;
  connected: boolean;
  isDuplicate: boolean;
  parent: BrokerClient;
  ssl: boolean;
  socket: any;

  getConnectPromise(): Promise<void>;
  forceReconnect(): void;
  connect(options: ConnectOptions): void;
  duplicate(params: { moduleName: string }): BrokerClient;
  isConnected(): boolean;
  ping(): Promise<any>;
  getSocket(): any;
  handleMessage(rawMessage: string): Promise<void>;
  sendMessage(message: any): Promise<any>;
  addSocketListeners(): void;
  removeSocketListeners(): void;
  resubscribeModuleEvents(): void;
  onOpen(): Promise<void>;
  onError(err: any): void;
  onClose(e: any): void;
  registerHandlersToRemote(targetModuleName: string): Promise<any>;
  deregisterHandlersFromRemotes(): Promise<any>;
  unsubscribeFromAllEvents(): Promise<any>;
  destroy(): Promise<void>;
  registerAPIHandlers(handlers: { [key: string]: Function }, context?: any, remote?: string): Promise<any>;

  static initModule(params: InitModuleParams): Promise<BrokerClient>;
}
