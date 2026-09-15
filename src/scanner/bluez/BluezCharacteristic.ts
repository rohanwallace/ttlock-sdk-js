"use strict";

import { EventEmitter } from "events";
import NodeBle = require("node-ble");

import {
  CharacteristicInterface,
  DescriptorInterface,
} from "../DeviceInterface";

import { BluezDevice } from "./BluezDevice";

export class BluezCharacteristic
  extends EventEmitter
  implements CharacteristicInterface
{
  uuid: string;

  name?: string;
  type?: string;

  properties: string[] = [];

  isReading: boolean = false;

  lastValue?: Buffer;

  /*
   * node-ble currently has no public descriptor API.
   *
   * TTLock's current active path does not require descriptor access; its old
   * explicit CCCD code is commented out and notifications are enabled directly
   * on characteristic fff4.
   */
  descriptors:
    Map<string, DescriptorInterface> = new Map();

  private readonly device: BluezDevice;

  private readonly characteristic:
    NodeBle.GattCharacteristic;

  private subscribed: boolean = false;

  private readonly onValueChangedBound:
    (data: Buffer) => void;

  private constructor(
    device: BluezDevice,
    characteristic: NodeBle.GattCharacteristic,
    uuid: string,
  ) {
    super();

    this.device = device;
    this.characteristic = characteristic;
    this.uuid = uuid.toLowerCase();

    this.onValueChangedBound =
      this.onValueChanged.bind(this);
  }

  static async create(
    device: BluezDevice,
    characteristic: NodeBle.GattCharacteristic,
    suppliedUuid?: string,
  ): Promise<BluezCharacteristic> {
    const uuid =
      suppliedUuid ??
      await characteristic.getUUID();

    const result =
      new BluezCharacteristic(
        device,
        characteristic,
        uuid,
      );

    const flags =
      await characteristic.getFlags();

    result.properties =
      BluezCharacteristic.normaliseFlags(
        flags,
      );

    return result;
  }

  getUUID(): string {
    return BluezCharacteristic.shortUuid(
      this.uuid,
    );
  }

  async discoverDescriptors():
    Promise<Map<string, DescriptorInterface>> {
    /*
     * node-ble does not expose GATT descriptors through its public API.
     * Returning an empty map is sufficient for the current TTLock path.
     */
    this.descriptors = new Map();

    return this.descriptors;
  }

  async read():
    Promise<Buffer | undefined> {
    if (
      !this.properties.includes("read")
    ) {
      return undefined;
    }

    this.device.checkBusy();

    if (!this.device.connected) {
      this.device.resetBusy();

      throw new Error(
        "BluezDevice is not connected",
      );
    }

    this.isReading = true;

    try {
      const value =
        await this.characteristic.readValue();

      this.lastValue =
        Buffer.from(value);

      return this.lastValue;

    } catch (error) {
      console.error(
        `[BLUEZ] Read failed for characteristic ${this.getUUID()}:`,
        error,
      );

      return undefined;

    } finally {
      this.isReading = false;
      this.device.resetBusy();
    }
  }

  async write(
    data: Buffer,
    withoutResponse: boolean,
  ): Promise<boolean> {
    const canWrite =
      this.properties.includes("write");

    const canWriteWithoutResponse =
      this.properties.includes(
        "writeWithoutResponse",
      );

    if (
      !canWrite &&
      !canWriteWithoutResponse
    ) {
      console.error(
        `[BLUEZ] Characteristic ${this.getUUID()} is not writable`,
      );

      return false;
    }

    this.device.checkBusy();

    if (!this.device.connected) {
      this.device.resetBusy();

      return false;
    }

    try {
      if (
        withoutResponse &&
        canWriteWithoutResponse
      ) {
        await this.characteristic
          .writeValueWithoutResponse(data);

      } else if (canWrite) {
        await this.characteristic
          .writeValueWithResponse(data);

      } else {
        /*
         * The characteristic only supports command/write-without-response.
         */
        await this.characteristic
          .writeValueWithoutResponse(data);
      }

      return true;

    } catch (error) {
      console.error(
        `[BLUEZ] Write failed for characteristic ${this.getUUID()}:`,
        error,
      );

      return false;

    } finally {
      this.device.resetBusy();
    }
  }

  async subscribe(): Promise<void> {
    if (this.subscribed) {
      return;
    }

    if (
      !this.properties.includes("notify") &&
      !this.properties.includes("indicate")
    ) {
      throw new Error(
        `Characteristic ${this.getUUID()} does not support notifications`,
      );
    }

    console.log(
      `[BLUEZ] Subscribing to ${this.getUUID()}`,
    );

    /*
     * Install the event listener before StartNotify so we cannot miss an
     * immediate notification.
     */
    this.characteristic.on(
      "valuechanged",
      this.onValueChangedBound,
    );

    try {
      await this.characteristic
        .startNotifications();

      this.subscribed = true;

      console.log(
        `[BLUEZ] Subscribed to ${this.getUUID()}`,
      );

    } catch (error) {
      this.characteristic.removeListener(
        "valuechanged",
        this.onValueChangedBound,
      );

      throw error;
    }
  }

  dispose(): void {
    this.characteristic.removeListener(
      "valuechanged",
      this.onValueChangedBound,
    );

    if (this.subscribed) {
      /*
       * DeviceInterface disposal is synchronous, so notification shutdown must
       * be fire-and-forget.
       */
      void this.characteristic
        .stopNotifications()
        .catch(() => {
          // Device may already have disconnected.
        });

      this.subscribed = false;
    }

    this.descriptors = new Map();

    this.removeAllListeners();
  }

  private onValueChanged(
    data: Buffer,
  ): void {
    this.lastValue =
      Buffer.from(data);

    console.log(
      `[BLUEZ RX] ${this.getUUID()}: ${this.lastValue.toString("hex")}`,
    );

    this.emit(
      "dataRead",
      this.lastValue,
    );
  }

  toJSON(
    asObject: boolean = false,
  ): string | Object {
    const json = {
      uuid: this.uuid,
      name: this.name,
      type: this.type,
      properties: this.properties,
      value:
        this.lastValue?.toString("hex"),
      descriptors: {},
    };

    return asObject
      ? json
      : JSON.stringify(json);
  }

  toString(): string {
    return `[BlueZ Characteristic ${this.uuid}]`;
  }

  /**
   * BlueZ names the property "write-without-response".
   * Noble calls the same capability "writeWithoutResponse".
   *
   * Translate it here so all existing TTLock code can remain unchanged.
   */
  private static normaliseFlags(
    flags: string[],
  ): string[] {
    return flags.map((flag) => {
      switch (flag) {
        case "write-without-response":
          return "writeWithoutResponse";

        case "authenticated-signed-writes":
          return "authenticatedSignedWrites";

        default:
          return flag;
      }
    });
  }

  private static shortUuid(
    uuid: string,
  ): string {
    const lower =
      uuid.toLowerCase();

    const match =
      /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/.exec(
        lower,
      );

    if (match) {
      return match[1];
    }

    return lower;
  }
}