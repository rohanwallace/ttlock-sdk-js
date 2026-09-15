"use strict";

import { EventEmitter } from "node:events";
import NodeBle = require("node-ble");

import {
  ScannerInterface,
  ScannerStateType,
} from "../ScannerInterface";

import { BluezDevice } from "./BluezDevice";
import { createLogger } from "../../util/logger";
import { DeviceInterface } from "../DeviceInterface";

const log = createLogger("ttlock:scanner");

const DEVICE_POLL_INTERVAL_MS = 500;

export class BluezScanner
  extends EventEmitter
  implements ScannerInterface
{
  uuids: string[];

  scannerState: ScannerStateType = "unknown";

  on(event: "ready", listener: () => void): this;
  on(event: "discover", listener: (device: DeviceInterface) => void, ): this;
  on(event: "scanStart", listener: () => void, ): this;
  on(event: "scanStop", listener: () => void, ): this;
  on(event: string | symbol, listener: (...args: any[]) => void, ): this { return super.on(event, listener); }

  private readonly bluetooth: NodeBle.Bluetooth;
  private readonly destroyBluetooth: () => void;

  private adapter?: NodeBle.Adapter;

  private readonly devices: Map<string, BluezDevice> = new Map();

  private pollTimer?: NodeJS.Timeout;
  private polling: boolean = false;
  private destroyed: boolean = false;

  /*
   * True only when THIS scanner actually called StartDiscovery.
   *
   * BlueZ can already be discovering because another D-Bus client requested it.
   * In that situation we can use the existing discovery session, but must not
   * stop somebody else's session when stopScan() is called.
   */
  private ownsDiscovery: boolean = false;

  private readonly adapterName?: string;

  constructor(
    uuids: string[] = [],
    adapterName?: string,
  ) {
    super();

    this.uuids = uuids;
    this.adapterName = adapterName;

    const session = NodeBle.createBluetooth();

    this.bluetooth = session.bluetooth;
    this.destroyBluetooth = session.destroy;

    /*
     * Constructors cannot be async. Initialise in the background and emit
     * "ready" once the BlueZ adapter is available.
     */
    void this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      console.log("[BLUEZ] Initialising BlueZ scanner");

      if (this.adapterName) {
        console.log(
          `[BLUEZ] Using configured adapter ${this.adapterName}`,
        );

        this.adapter =
          await this.bluetooth.getAdapter(this.adapterName);
      } else {
        this.adapter =
          await this.bluetooth.defaultAdapter();
      }

      const address = await this.adapter.getAddress();
      const name = await this.adapter.getName();
      const powered = await this.adapter.isPowered();

      console.log(
        `[BLUEZ] Adapter ready: ${name} ${address}`,
      );

      console.log(
        `[BLUEZ] Adapter powered=${powered}`,
      );

      if (!powered) {
        console.error(
          "[BLUEZ] Bluetooth adapter is not powered",
        );

        this.scannerState = "stopped";
        return;
      }

      this.scannerState = "stopped";

      /*
       * BluetoothLeService attaches the ready listener immediately after
       * constructing us. initialize() has awaited D-Bus calls, so the listener
       * will already be present by this point.
       */
      this.emit("ready");

    } catch (error) {
      console.error(
        "[BLUEZ] Failed to initialise Bluetooth adapter:",
        error,
      );

      this.scannerState = "stopped";
    }
  }

  getState(): ScannerStateType {
    return this.scannerState;
  }

  async startScan(
    passive: boolean = false,
  ): Promise<boolean> {
    if (
      this.scannerState !== "unknown" &&
      this.scannerState !== "stopped"
    ) {
      return false;
    }

    if (!this.adapter) {
      console.error(
        "[BLUEZ] Cannot start scan: adapter not ready",
      );

      return false;
    }

    this.scannerState = "starting";

    try {
      /*
       * node-ble/BlueZ doesn't expose Noble's active/passive distinction.
       * BlueZ owns the actual LE discovery procedure.
       */
      console.log(
        `[BLUEZ] Starting scan (requested passive=${passive})`,
      );

      const alreadyDiscovering =
        await this.adapter.isDiscovering();

      if (!alreadyDiscovering) {
        await this.adapter.startDiscovery();

        this.ownsDiscovery = true;

        console.log(
          "[BLUEZ] Started BlueZ discovery session",
        );
      } else {
        /*
         * Another D-Bus client already has discovery active.
         * Use it without claiming ownership.
         */
        this.ownsDiscovery = false;

        console.log(
          "[BLUEZ] BlueZ discovery already active; reusing it",
        );
      }

      this.scannerState = "scanning";

      this.startPolling();

      this.emit("scanStart");

      /*
       * Don't wait 500 ms for the first pass.
       */
      void this.pollDevices();

      return true;

    } catch (error) {
      console.error(
        "[BLUEZ] Unable to start discovery:",
        error,
      );

      this.scannerState = "stopped";
      this.ownsDiscovery = false;

      return false;
    }
  }

  async stopScan(): Promise<boolean> {
    if (this.scannerState !== "scanning") {
      return false;
    }

    this.scannerState = "stopping";

    this.stopPolling();

    try {
      if (this.adapter && this.ownsDiscovery) {
        const discovering =
          await this.adapter.isDiscovering();

        if (discovering) {
          console.log(
            "[BLUEZ] Stopping BlueZ discovery",
          );

          await this.adapter.stopDiscovery();
        }
      }

      this.ownsDiscovery = false;
      this.scannerState = "stopped";

      this.emit("scanStop");

      console.log("[BLUEZ] Scan stopped");

      return true;

    } catch (error) {
      /*
       * BlueZ may already have stopped discovery because of an adapter or
       * controller state change. Treat our scanner as stopped either way.
       */
      console.warn(
        "[BLUEZ] Error while stopping discovery:",
        error,
      );

      this.ownsDiscovery = false;
      this.scannerState = "stopped";

      this.emit("scanStop");

      return true;
    }
  }

  private startPolling(): void {
    this.stopPolling();

    this.pollTimer = setInterval(() => {
      void this.pollDevices();
    }, DEVICE_POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private async pollDevices(): Promise<void> {
    if (
      this.polling ||
      this.destroyed ||
      this.scannerState !== "scanning" ||
      !this.adapter
    ) {
      return;
    }

    this.polling = true;

    try {
      const addresses =
        await this.adapter.devices();

      for (const address of addresses) {
        if (
          this.destroyed ||
          this.scannerState !== "scanning"
        ) {
          break;
        }

        try {
          const nodeDevice =
            await this.adapter.getDevice(address);

          const id = BluezDevice.idFromAddress(address);

          let device = this.devices.get(id);

          if (!device) {
            device =
              await BluezDevice.create(nodeDevice);

            this.devices.set(id, device);
          } else {
            await device.refresh();
          }

          if (this.checkDeviceAdvertisement(device)) {
            this.emit("discover", device);
          }

        } catch (error) {
          /*
           * BlueZ's object list may contain cached devices which disappear
           * while we're enumerating it. One failed device should not abort the
           * whole scan.
           */
          log.warn(
            "Unable to inspect BlueZ device",
            address,
            error,
          );
        }
      }

    } catch (error) {
      console.error(
        "[BLUEZ] Device polling failed:",
        error,
      );

    } finally {
      this.polling = false;
    }
  }

  private checkDeviceAdvertisement(
    device: BluezDevice,
  ): boolean {
    /*
     * If no filter was requested, behave like Noble and expose everything.
     */
    if (!this.uuids || this.uuids.length === 0) {
      return true;
    }

    /*
     * node-ble does not expose the advertised UUID array through its public
     * Device API.
     *
     * The SDK currently targets TTLock V3, whose manufacturer payload begins
     * 05 03. This also prevents us from feeding every unrelated BlueZ device
     * into TTBluetoothDevice.parseManufacturerData().
     *
     * BluezDevice reconstructs BlueZ ManufacturerData into Noble-compatible
     * form before we get here.
     */
    const data = device.manufacturerData;

    if (data.length < 15) {
      return false;
    }

    return (
      data[0] === 0x05 &&
      data[1] === 0x03
    );
  }

  destroy(): void {
    this.destroyed = true;

    this.stopPolling();

    const finish = () => {
      try {
        this.destroyBluetooth();
      } catch (error) {
        console.warn(
          "[BLUEZ] Error destroying D-Bus session:",
          error,
        );
      }
    };

    if (
      this.adapter &&
      this.ownsDiscovery
    ) {
      void this.adapter
        .isDiscovering()
        .then(async (discovering) => {
          if (discovering) {
            await this.adapter?.stopDiscovery();
          }
        })
        .catch((error) => {
          console.warn(
            "[BLUEZ] Error stopping discovery during destroy:",
            error,
          );
        })
        .finally(finish);
    } else {
      finish();
    }

    this.ownsDiscovery = false;
    this.scannerState = "stopped";

    this.devices.clear();
    this.removeAllListeners();
  }
}