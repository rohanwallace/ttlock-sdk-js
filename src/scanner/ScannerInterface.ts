'use strict';

import { EventEmitter } from 'node:events';
import { DeviceInterface } from './DeviceInterface';

export type ScannerType = 'noble' | 'noble-websocket' | 'bluez';

export type ScannerOptions = {
  websocketHost?: string;
  websocketPort?: number;
  websocketAesKey?: string;
  websocketUsername?: string;
  websocketPassword?: string;
  /*
   * Optional BlueZ adapter name, e.g. hci0.
   * Omit to use BlueZ's default adapter.
   */
  bluezAdapter?: string;
};

export type ScannerStateType = 'unknown' | 'starting' | 'scanning' | 'stopping' | 'stopped';

export interface ScannerInterface extends EventEmitter {
  scannerState: ScannerStateType;
  startScan(passive: boolean): Promise<boolean>;
  stopScan(): Promise<boolean>;
  getState(): ScannerStateType;
  destroy(): void;
  on(event: 'ready', listener: () => void): this;
  on(event: 'discover', listener: (device: DeviceInterface) => void): this;
  on(event: 'scanStart', listener: () => void): this;
  on(event: 'scanStop', listener: () => void): this;
}
