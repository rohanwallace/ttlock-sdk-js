"use strict";

import { EventEmitter } from "events";
import NodeBle = require("node-ble");

import {
  DeviceInterface,
  ServiceInterface,
} from "../DeviceInterface";

import { BluezService } from "./BluezService";
import { createLogger } from "../../util/logger";

const log = createLogger("ttlock:scanner");

const DEFAULT_ATT_MTU = 23;
const CONNECT_TIMEOUT_MS = 15000;
const DISCONNECT_TIMEOUT_MS = 10000;

export class BluezDevice
  extends EventEmitter
  implements DeviceInterface
{
  id: string = "";
  uuid: string = "";
  name: string = "";
  address: string = "";
  addressType: string = "unknown";

  connectable: boolean = true;

  connecting: boolean = false;
  connected: boolean = false;

  rssi: number = 0;

  manufacturerData: Buffer = Buffer.from([]);

  services: Map<string, BluezService> = new Map();

  busy: boolean = false;

  private gattServer?: NodeBle.GattServer;

  private readonly device: NodeBle.Device;

  private readonly onConnectBound:
    (state: NodeBle.ConnectionState) => void;

  private readonly onDisconnectBound:
    (state: NodeBle.ConnectionState) => void;

  private constructor(device: NodeBle.Device) {
    super();

    this.device = device;

    this.onConnectBound =
      this.onBluezConnect.bind(this);

    this.onDisconnectBound =
      this.onBluezDisconnect.bind(this);

    this.device.on(
      "connect",
      this.onConnectBound,
    );

    this.device.on(
      "disconnect",
      this.onDisconnectBound,
    );
  }

  static async create(
    device: NodeBle.Device,
  ): Promise<BluezDevice> {
    const result = new BluezDevice(device);

    await result.refresh();

    return result;
  }

  static idFromAddress(address: string): string {
    return address
      .replace(/[:-]/g, "")
      .toLowerCase();
  }

  /*
   * node-ble does not expose the negotiated ATT MTU.
   *
   * Returning the Bluetooth default of 23 causes the existing SDK to retain
   * its known-safe 20-byte TTLock command chunks.
   */
  get mtu(): number {
    return DEFAULT_ATT_MTU;
  }

  async refresh(): Promise<void> {
    try {
      const address =
        await this.device.getAddress();

      this.address =
        address.replace(/-/g, ":").toUpperCase();

      this.id =
        BluezDevice.idFromAddress(this.address);

      this.uuid = this.id;

    } catch (error) {
      log.warn(
        "Unable to read BlueZ device address",
        error,
      );
    }

    try {
      this.name =
        (await this.device.getName()) || "";
    } catch {
      /*
       * Name is optional in BLE advertisements.
       */
    }

    try {
      this.addressType =
        (await this.device.getAddressType()) ||
        "unknown";
    } catch {
      this.addressType = "unknown";
    }

    try {
      /*
       * node-ble's declaration historically typed RSSI as a string even
       * though BlueZ returns a numeric property.
       */
      const rawRssi =
        await this.device.getRSSI();

      const numeric =
        Number(rawRssi as unknown);

      if (Number.isFinite(numeric)) {
        this.rssi = numeric;
      }
    } catch {
      /*
       * RSSI disappears from BlueZ when advertisements have gone stale.
       */
    }

    try {
      const raw =
        await this.device.getManufacturerData();

      this.manufacturerData =
        BluezDevice.buildManufacturerData(raw);

    } catch {
      this.manufacturerData =
        Buffer.from([]);
    }

    try {
      const rawConnected =
        await this.device.isConnected();

      const isConnected =
        rawConnected === (true as unknown) ||
        String(rawConnected).toLowerCase() === "true";

      if (isConnected) {
        this.markConnected();
      } else if (this.connected && !this.connecting) {
        this.markDisconnected();
      }

    } catch {
      /*
       * Do not alter our current state if BlueZ temporarily cannot answer.
       */
    }
  }

  /**
   * BlueZ represents ManufacturerData as:
   *
   *   uint16 manufacturerId -> byte array
   *
   * Noble represents the same advertisement as one raw byte buffer containing
   * the little-endian manufacturer identifier followed by its payload.
   *
   * TTLock's parser expects the Noble form, so recreate it here.
   */
  private static buildManufacturerData(
    raw: { [key: string]: any } | undefined,
  ): Buffer {
    if (!raw) {
      return Buffer.from([]);
    }

    let best: Buffer = Buffer.from([]);

    for (const [key, value] of Object.entries(raw)) {
      let payload: Buffer;

      if (Buffer.isBuffer(value)) {
        payload = value;

      } else if (value instanceof Uint8Array) {
        payload = Buffer.from(value);

      } else if (Array.isArray(value)) {
        payload = Buffer.from(value);

      } else if (
        value &&
        typeof value === "object" &&
        Array.isArray((value as any).value)
      ) {
        payload =
          Buffer.from((value as any).value);

      } else {
        continue;
      }

      const manufacturerId = Number(key);

      let candidate: Buffer;

      if (
        Number.isInteger(manufacturerId) &&
        manufacturerId >= 0 &&
        manufacturerId <= 0xffff
      ) {
        const prefix = Buffer.alloc(2);

        prefix.writeUInt16LE(
          manufacturerId,
          0,
        );

        candidate =
          Buffer.concat([prefix, payload]);

      } else {
        candidate = payload;
      }

      /*
       * Prefer an obvious TTLock V3 advertisement immediately.
       */
      if (
        candidate.length >= 15 &&
        candidate[0] === 0x05 &&
        candidate[1] === 0x03
      ) {
        return candidate;
      }

      /*
       * Otherwise retain the largest manufacturer record as a reasonable
       * fallback.
       */
      if (candidate.length > best.length) {
        best = candidate;
      }
    }

    return best;
  }

  checkBusy(): boolean {
    if (this.busy) {
      throw new Error(
        "BluezDevice is busy",
      );
    }

    this.busy = true;

    return true;
  }

  resetBusy(): boolean {
    this.busy = false;

    return this.busy;
  }

  async connect(
    timeout: number = CONNECT_TIMEOUT_MS / 1000,
  ): Promise<boolean> {
    console.log("==================================================");
    console.log(
      `[BLUEZ] connect() called for ${this.address}`,
    );
    console.log(`[BLUEZ] id=${this.id}`);
    console.log(
      `[BLUEZ] addressType=${this.addressType}`,
    );
    console.log(`[BLUEZ] RSSI=${this.rssi}`);
    console.log(
      `[BLUEZ] wrapper.connected=${this.connected}`,
    );
    console.log(
      `[BLUEZ] wrapper.connecting=${this.connecting}`,
    );

    if (
      !this.connectable ||
      this.connecting
    ) {
      console.error(
        `[BLUEZ] Refusing connection: ` +
        `connectable=${this.connectable}, ` +
        `connecting=${this.connecting}`,
      );

      console.log(
        "==================================================",
      );

      return false;
    }

    try {
      const rawConnected =
        await this.device.isConnected();

      const alreadyConnected =
        rawConnected === (true as unknown) ||
        String(rawConnected).toLowerCase() === "true";

      if (alreadyConnected) {
        console.log(
          "[BLUEZ] Device already connected",
        );

        this.markConnected();

        console.log(
          "==================================================",
        );

        return true;
      }
    } catch {
      /*
       * Proceed with Connect if querying the current state fails.
       */
    }

    this.connecting = true;

    const start = Date.now();

    try {
      console.log(
        `[BLUEZ] Calling org.bluez.Device1.Connect for ${this.address}`,
      );

      await this.withTimeout(
        this.device.connect(),
        timeout * 1000,
        `connect ${this.address}`,
      );

      /*
       * Device.Connect normally returns once BlueZ has established the link,
       * but verify the property instead of assuming success.
       */
      const rawConnected =
        await this.device.isConnected();

      const isConnected =
        rawConnected === (true as unknown) ||
        String(rawConnected).toLowerCase() === "true";

      console.log(
        `[BLUEZ] Connect returned after ${Date.now() - start} ms`,
      );

      console.log(
        `[BLUEZ] BlueZ Connected=${isConnected}`,
      );

      if (!isConnected) {
        this.connecting = false;

        console.error(
          `[BLUEZ] Connection FAILED for ${this.address}`,
        );

        console.log(
          "==================================================",
        );

        return false;
      }

      this.markConnected();

      console.log(
        `[BLUEZ] Connection SUCCESS for ${this.address}`,
      );

      console.log(
        `[BLUEZ] ATT MTU exposed to SDK=${this.mtu}`,
      );

      console.log(
        "==================================================",
      );

      return true;

    } catch (error) {
      this.connecting = false;

      console.error(
        `[BLUEZ] Connection failed for ${this.address}:`,
        error,
      );

      /*
       * A timed-out D-Bus Connect cannot be cancelled through node-ble.
       * Asking BlueZ to disconnect is the cleanest recovery available.
       */
      try {
        await this.device.disconnect();
      } catch {
        // Ignore cleanup failure.
      }

      this.markDisconnected();

      console.log(
        "==================================================",
      );

      return false;
    }
  }

  async disconnect(): Promise<boolean> {
    try {
      console.log(
        `[BLUEZ] Disconnecting ${this.address}`,
      );

      await this.withTimeout(
        this.device.disconnect(),
        DISCONNECT_TIMEOUT_MS,
        `disconnect ${this.address}`,
      );

      this.markDisconnected();

      this.gattServer = undefined;

      this.services.forEach(
        (service) => service.dispose(),
      );

      this.services = new Map();

      return true;

    } catch (error) {
      console.error(
        `[BLUEZ] Disconnect failed for ${this.address}:`,
        error,
      );

      return false;
    }
  }

  async discoverServices():
    Promise<Map<string, ServiceInterface>> {
    try {
      this.checkBusy();

      if (!this.connected) {
        throw new Error(
          "BluezDevice not connected",
        );
      }

      console.log(
        `[BLUEZ] Discovering GATT services on ${this.address}`,
      );

      /*
       * device.gatt() waits for BlueZ ServicesResolved and initialises the
       * server tree.
       */
      this.gattServer =
        await this.device.gatt();

      const serviceUuids =
        await this.gattServer.services();

      console.log(
        `[BLUEZ] Found ${serviceUuids.length} GATT services`,
      );

      this.services = new Map();

      for (const uuid of serviceUuids) {
        try {
          const service =
            await this.gattServer.getPrimaryService(uuid);

          const wrapped =
            new BluezService(
              this,
              service,
              uuid,
            );

          this.services.set(
            wrapped.getUUID(),
            wrapped,
          );

          console.log(
            `[BLUEZ] Service ${uuid} -> ${wrapped.getUUID()}`,
          );

        } catch (error) {
          console.warn(
            `[BLUEZ] Unable to wrap service ${uuid}:`,
            error,
          );
        }
      }

      return this.services;

    } catch (error) {
      console.error(
        "[BLUEZ] Service discovery failed:",
        error,
      );

      return new Map();

    } finally {
      this.resetBusy();
    }
  }

  async discoverAll():
    Promise<Map<string, ServiceInterface>> {
    const services =
      await this.discoverServices();

    for (const [, service] of services) {
      if (!this.connected) {
        break;
      }

      await service.discoverCharacteristics();
    }

    return services;
  }

  async readCharacteristics():
    Promise<boolean> {
    try {
      if (!this.connected) {
        throw new Error(
          "BluezDevice not connected",
        );
      }

      if (this.services.size === 0) {
        await this.discoverServices();
      }

      for (const [, service] of this.services) {
        if (!this.connected) {
          break;
        }

        await service.readCharacteristics();
      }

      return true;

    } catch (error) {
      console.error(
        "[BLUEZ] Unable to read characteristics:",
        error,
      );

      return false;
    }
  }

  private markConnected(): void {
    const changed = !this.connected;

    this.connected = true;
    this.connecting = false;

    if (changed) {
      this.emit("connected");
    }
  }

  private markDisconnected(): void {
    const changed =
      this.connected || this.connecting;

    this.connected = false;
    this.connecting = false;

    this.resetBusy();

    if (changed) {
      this.emit("disconnected");
    }
  }

  private onBluezConnect(
    state: NodeBle.ConnectionState,
  ): void {
    console.log(
      `[BLUEZ EVENT] ${this.address} connected=${state.connected}`,
    );

    if (state.connected) {
      this.markConnected();
    }
  }

  private onBluezDisconnect(
    state: NodeBle.ConnectionState,
  ): void {
    console.warn(
      `[BLUEZ EVENT] ${this.address} connected=${state.connected}`,
    );

    this.gattServer = undefined;

    this.services.forEach(
      (service) => service.dispose(),
    );

    this.services = new Map();

    this.markDisconnected();
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    label: string,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;

    try {
      return await Promise.race([
        promise,

        new Promise<T>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new Error(
                `BlueZ timeout (${label}) after ${timeoutMs} ms`,
              ),
            );
          }, timeoutMs);
        }),
      ]);

    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  toJSON(
    asObject: boolean = false,
  ): string | Object {
    const json = {
      id: this.id,
      uuid: this.uuid,
      name: this.name,
      address: this.address,
      addressType: this.addressType,
      connectable: this.connectable,
      connected: this.connected,
      rssi: this.rssi,
      mtu: this.mtu,
      manufacturerData:
        this.manufacturerData.toString("hex"),
    };

    return asObject
      ? json
      : JSON.stringify(json);
  }

  toString(): string {
    return `${this.name || "BLE device"} [${this.address}]`;
  }
}