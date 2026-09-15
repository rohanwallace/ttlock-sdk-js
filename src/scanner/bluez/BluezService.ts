"use strict";

import NodeBle = require("node-ble");

import {
  CharacteristicInterface,
  ServiceInterface,
} from "../DeviceInterface";

import { BluezDevice } from "./BluezDevice";
import { BluezCharacteristic } from "./BluezCharacteristic";

export class BluezService
  implements ServiceInterface
{
  uuid: string;

  name?: string;
  type?: string;

  includedServiceUuids: string[] = [];

  characteristics:
    Map<string, BluezCharacteristic> = new Map();

  private readonly device: BluezDevice;
  private readonly service: NodeBle.GattService;

  constructor(
    device: BluezDevice,
    service: NodeBle.GattService,
    uuid: string,
  ) {
    this.device = device;
    this.service = service;

    this.uuid = uuid.toLowerCase();

    /*
     * node-ble doesn't expose Noble's friendly GATT names/types.
     * They are optional in ServiceInterface.
     */
    this.name = undefined;
    this.type = undefined;
  }

  getUUID(): string {
    return BluezService.shortUuid(this.uuid);
  }

  async discoverCharacteristics():
    Promise<Map<string, CharacteristicInterface>> {
    try {
      this.device.checkBusy();

      if (!this.device.connected) {
        throw new Error(
          "BluezDevice is not connected",
        );
      }

      const uuids =
        await this.service.characteristics();

      console.log(
        `[BLUEZ] Service ${this.getUUID()} has ${uuids.length} characteristics`,
      );

      this.characteristics = new Map();

      for (const uuid of uuids) {
        try {
          const characteristic =
            await this.service.getCharacteristic(uuid);

          const wrapped =
            await BluezCharacteristic.create(
              this.device,
              characteristic,
              uuid,
            );

          this.characteristics.set(
            wrapped.getUUID(),
            wrapped,
          );

          console.log(
            `[BLUEZ] Characteristic ${uuid} -> ` +
            `${wrapped.getUUID()} properties=` +
            `${JSON.stringify(wrapped.properties)}`,
          );

        } catch (error) {
          console.warn(
            `[BLUEZ] Unable to initialise characteristic ${uuid}:`,
            error,
          );
        }
      }

      return this.characteristics;

    } catch (error) {
      console.error(
        `[BLUEZ] Characteristic discovery failed for ${this.getUUID()}:`,
        error,
      );

      return new Map();

    } finally {
      this.device.resetBusy();
    }
  }

  async readCharacteristics(
    uuids?: string[],
  ): Promise<Map<string, CharacteristicInterface>> {
    if (this.characteristics.size === 0) {
      await this.discoverCharacteristics();
    }

    const wanted =
      uuids !== undefined
        ? new Set(
            uuids.map(
              (uuid) =>
                BluezService.shortUuid(
                  uuid.toLowerCase(),
                ),
            ),
          )
        : undefined;

    for (
      const [uuid, characteristic]
      of this.characteristics
    ) {
      if (!this.device.connected) {
        break;
      }

      if (
        wanted !== undefined &&
        !wanted.has(uuid)
      ) {
        continue;
      }

      if (
        !characteristic.properties.includes(
          "read",
        )
      ) {
        continue;
      }

      try {
        await characteristic.read();

      } catch (error) {
        console.warn(
          `[BLUEZ] Read ${this.getUUID()}/${uuid} failed:`,
          error,
        );
      }
    }

    return this.characteristics;
  }

  dispose(): void {
    this.characteristics.forEach(
      (characteristic) =>
        characteristic.dispose(),
    );

    this.characteristics = new Map();
  }

  toJSON(
    asObject: boolean = false,
  ): string | Object {
    const characteristicData:
      Record<string, Object> = {};

    this.characteristics.forEach(
      (characteristic, uuid) => {
        characteristicData[uuid] =
          characteristic.toJSON(true) as Object;
      },
    );

    const json = {
      uuid: this.uuid,
      name: this.name,
      type: this.type,
      characteristics: characteristicData,
    };

    return asObject
      ? json
      : JSON.stringify(json);
  }

  toString(): string {
    return `[BlueZ Service ${this.uuid}]`;
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