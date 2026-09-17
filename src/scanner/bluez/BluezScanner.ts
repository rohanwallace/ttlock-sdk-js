"use strict";

import { EventEmitter } from "node:events";
import NodeBle = require("node-ble");
import dbus = require("dbus-next");

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
  private readonly discoveryBus: any;
  private bluezAdapterInterface?: any;
  private resolvedAdapterName?: string;
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
     * Separate D-Bus connection used specifically for our discovery
     * session. BlueZ tracks discovery ownership per D-Bus client.
     */
    this.discoveryBus = dbus.systemBus(); 

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
      }

      let adapterName = this.adapterName;

      if (!adapterName) {
        const adapters = await this.bluetooth.adapters();

        if (adapters.length === 0) {
          throw new Error("No BlueZ Bluetooth adapters available", );
        }

        adapterName = adapters[0];
      }

      this.resolvedAdapterName = adapterName;

      this.adapter = await this.bluetooth.getAdapter(adapterName);

      /*
       * Get org.bluez.Adapter1 directly.
       *
       * We deliberately don't use node-ble's startDiscovery() because it
       * refuses to acquire a discovery session whenever the adapter-global
       * Discovering property is already true.
       */
      const proxy = await this.discoveryBus.getProxyObject("org.bluez", `/org/bluez/${adapterName}`, );

      this.bluezAdapterInterface = proxy.getInterface("org.bluez.Adapter1");

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

  if (
    !this.adapter ||
    !this.bluezAdapterInterface
  ) {
    console.error(
      "[BLUEZ] Cannot start scan: adapter not ready",
    );

    return false;
  }

  this.scannerState = "starting";

  try {
    /*
     * If we don't already own a discovery session, acquire one.
     *
     * Once acquired, we deliberately keep it for the lifetime of the
     * scanner. BlueZ needs current advertising reports when initiating
     * LE connections.
     */
    if (!this.ownsDiscovery) {
      const discoveringBefore =
        await this.adapter.isDiscovering();

      console.log(
        `[BLUEZ] Starting our discovery session ` +
        `(requested passive=${passive})`,
      );

      console.log(
        `[BLUEZ] Adapter Discovering before our session=` +
        `${discoveringBefore}`,
      );

      await this.bluezAdapterInterface
        .SetDiscoveryFilter({
          Transport:
            new dbus.Variant("s", "le"),

          DuplicateData:
            new dbus.Variant("b", true),
        });

      await this.bluezAdapterInterface
        .StartDiscovery();

      this.ownsDiscovery = true;

      const discoveringAfter =
        await this.adapter.isDiscovering();

      console.log(
        "[BLUEZ] Our discovery session started",
      );

      console.log(
        `[BLUEZ] Adapter Discovering after our session=` +
        `${discoveringAfter}`,
      );

    } else {
      /*
       * stopScan() only pauses our polling. The underlying BlueZ LE
       * discovery session remains active.
       */
      console.log(
        "[BLUEZ] Resuming scan polling; " +
        "our LE discovery session is already active",
      );
    }

    this.scannerState = "scanning";

    this.startPolling();

    this.emit("scanStart");

    void this.pollDevices();

    return true;

  } catch (error) {
    console.error(
      "[BLUEZ] Unable to start/resume scan:",
      error,
    );

    this.scannerState = "stopped";

    return false;
  }
}

async stopScan(): Promise<boolean> {
  if (this.scannerState !== "scanning") {
    return false;
  }

  /*
   * IMPORTANT:
   *
   * For BlueZ, "stop scan" means stop feeding discovery results into
   * the TTLock application.
   *
   * It does NOT mean StopDiscovery().
   *
   * BlueZ requires current LE advertising reports when establishing a
   * connection. Releasing our discovery session immediately before
   * Device1.Connect can cause:
   *
   *     le-connection-abort-by-local
   *
   * Therefore we retain our BlueZ LE discovery session until destroy().
   */
  this.scannerState = "stopping";

  this.stopPolling();

  this.scannerState = "stopped";

  this.emit("scanStop");

  console.log(
    "[BLUEZ] Scan polling paused; " +
    "keeping our LE discovery session active",
  );

  try {
    if (this.adapter) {
      const discovering =
        await this.adapter.isDiscovering();

      console.log(
        `[BLUEZ] Adapter-global Discovering=${discovering}`,
      );
    }
  } catch {
    // Diagnostic only.
  }

  return true;
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
            device = await BluezDevice.create(this.adapter, nodeDevice, );

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
    this.ownsDiscovery = false;
    this.scannerState = "stopped";

    this.devices.clear();
    this.removeAllListeners();

    try {
      this.destroyBluetooth();
    } catch (error) {
      console.warn(
        "[BLUEZ] Error destroying node-ble session:",
        error,
      );
    }

    try {
      if (
        this.discoveryBus &&
        typeof this.discoveryBus.disconnect === "function"
      ) {
        this.discoveryBus.disconnect();
      }
    } catch (error) {
      console.warn(
        "[BLUEZ] Error closing discovery D-Bus session:",
        error,
      );
    }
  };

  if (
    this.ownsDiscovery &&
    this.bluezAdapterInterface
  ) {
    console.log(
      "[BLUEZ] Releasing our LE discovery session during destroy",
    );

    void this.bluezAdapterInterface
      .StopDiscovery()
      .catch((error: unknown) => {
        console.warn(
          "[BLUEZ] Error releasing discovery session:",
          error,
        );
      })
      .finally(finish);

  } else {
    finish();
  }
}

}