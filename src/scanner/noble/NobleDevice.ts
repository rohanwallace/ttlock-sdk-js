"use strict";

import { DeviceInterface, ServiceInterface } from "../DeviceInterface";
import { Peripheral, Service } from "@abandonware/noble";
import { EventEmitter } from "events";
import { NobleService } from "./NobleService";
import { createLogger } from "../../util/logger";

const log = createLogger("ttlock:scanner");

/** Matches the 10 s ceiling the previous 10 ms-poll loop enforced. */
const DISCOVER_SERVICES_TIMEOUT_MS = 10000;

/** The ATT MTU every BLE link starts at, before any exchange. */
const DEFAULT_ATT_MTU = 23;

export class NobleDevice extends EventEmitter implements DeviceInterface {
  id: string;
  uuid: string;
  name: string;
  address: string;
  addressType: string;
  connectable: boolean;
  connecting: boolean = false;
  connected: boolean = false;
  rssi: number;
  manufacturerData: Buffer;
  services: Map<string, NobleService>;
  busy: boolean = false;
  private peripheral: Peripheral;

  constructor(peripheral: Peripheral) {
    super();
    this.peripheral = peripheral;
    this.id = peripheral.id;
    this.uuid = peripheral.uuid;
    this.name = peripheral.advertisement.localName;
    this.address = peripheral.address.replace(/\-/g, ":").toUpperCase();
    this.addressType = peripheral.addressType;
    this.connectable = peripheral.connectable;
    this.rssi = peripheral.rssi;

    if (peripheral.advertisement.manufacturerData) {
      this.manufacturerData = peripheral.advertisement.manufacturerData;
    } else {
      this.manufacturerData = Buffer.from([]);
    }
    this.peripheral.on("connect", this.onConnect.bind(this));
    this.peripheral.on("disconnect", this.onDisconnect.bind(this));
    this.services = new Map();
  }

  /**
   * The ATT MTU actually negotiated for this link, or the 23-byte BLE default
   * when none was. Read live rather than cached at connect time: noble's MTU
   * exchange can complete after the connect callback has already fired, and
   * transports that never negotiate (the websocket binding) leave it null
   * forever.
   */
  get mtu(): number {
    const negotiated = this.peripheral.mtu;
    return typeof negotiated == "number" && negotiated > 0 ? negotiated : DEFAULT_ATT_MTU;
  }

  updateFromPeripheral() {
    this.name = this.peripheral.advertisement.localName;
    this.address = this.peripheral.address.replace(/\-/g, ":").toUpperCase();
    this.addressType = this.peripheral.addressType;
    this.connectable = this.peripheral.connectable;
    this.rssi = this.peripheral.rssi;

    if (this.peripheral.advertisement.manufacturerData) {
      this.manufacturerData = this.peripheral.advertisement.manufacturerData;
    } else {
      this.manufacturerData = Buffer.from([]);
    }
  }

  checkBusy(): boolean {
    if (this.busy) {
      throw new Error("NobleDevice is busy");
    } else {
      this.busy = true;
      return true;
    }
  }

  resetBusy(): boolean {
    if (this.busy) {
      this.busy = false;
    }
    return this.busy;
  }

async connect(timeout: number = 10): Promise<boolean> {
  console.log("==================================================");
  console.log(`[NOBLE] connect() called for ${this.address}`);
  console.log(`[NOBLE] id=${this.id}`);
  console.log(`[NOBLE] address=${this.address}`);
  console.log(`[NOBLE] addressType=${this.addressType}`);
  console.log(`[NOBLE] RSSI=${this.rssi}`);
  console.log(`[NOBLE] connectable=${this.connectable}`);
  console.log(`[NOBLE] wrapper.connected=${this.connected}`);
  console.log(`[NOBLE] wrapper.connecting=${this.connecting}`);
  console.log(`[NOBLE] peripheral.state=${this.peripheral.state}`);
  console.log(`[NOBLE] timeout=${timeout}s`);

  if (!this.connectable || this.connected || this.connecting) {
    console.error(
      `[NOBLE] Refusing connection: ` +
      `connectable=${this.connectable}, ` +
      `connected=${this.connected}, ` +
      `connecting=${this.connecting}, ` +
      `peripheral.state=${this.peripheral.state}`
    );

    console.log("==================================================");
    return false;
  }

  if (this.peripheral.state === "connected") {
    console.log(
      "[NOBLE] Peripheral already reports connected; synchronising wrapper state"
    );

    this.connected = true;

    console.log("==================================================");
    return true;
  }

  this.connecting = true;

  console.log(`[NOBLE] Starting peripheral.connect() for ${this.address}`);

  const startTime = Date.now();

  const connected = await new Promise<boolean>((resolve) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;

      console.error(
        `[NOBLE] Connect TIMEOUT after ${Date.now() - startTime} ms`
      );

      console.error(
        `[NOBLE] Peripheral state at timeout: ${this.peripheral.state}`
      );

      try {
        console.log("[NOBLE] Calling peripheral.cancelConnect()");
        this.peripheral.cancelConnect();
      } catch (error) {
        console.error("[NOBLE] cancelConnect() threw:", error);
      }

      resolve(false);

    }, timeout * 1000);

    this.peripheral.connect((error) => {
      const elapsed = Date.now() - startTime;

      console.log(
        `[NOBLE] peripheral.connect() callback after ${elapsed} ms`
      );

      console.log(
        `[NOBLE] peripheral.state in callback=${this.peripheral.state}`
      );

      if (settled) {
        console.warn(
          "[NOBLE] Connect callback arrived AFTER promise was already settled"
        );

        if (error !== undefined && error !== null) {
          console.warn(
            `[NOBLE] Late callback error: ${error}`
          );
        }

        return;
      }

      settled = true;
      clearTimeout(timer);

      if (error !== undefined && error !== null) {
        /*
         * @abandonware/noble types the callback error as a string,
         * rather than an Error object.
         */
        console.error(
          `[NOBLE] Peripheral connect error: ${error}`
        );

        resolve(false);
      } else {
        console.log(
          "[NOBLE] Connect callback contained no error"
        );

        const stateConnected =
          this.peripheral.state === "connected";

        console.log(
          `[NOBLE] stateConnected=${stateConnected}`
        );

        resolve(stateConnected);
      }
    });
  });

  console.log(
    `[NOBLE] Connection promise resolved: ${connected}`
  );

  console.log(
    `[NOBLE] peripheral.state after promise=${this.peripheral.state}`
  );

  if (!connected) {
    console.error(
      `[NOBLE] Connection FAILED for ${this.address}`
    );

    this.connecting = false;

    console.log("==================================================");

    return false;
  }

  this.connected = true;
  this.connecting = false;

  console.log(
    `[NOBLE] Connection SUCCESS for ${this.address}`
  );

  console.log(
    `[NOBLE] negotiated/current MTU=${this.mtu}`
  );

  console.log("[NOBLE] Emitting connected event");

  this.emit("connected");

  console.log("==================================================");

  return true;
}

  async connect_OLD(timeout: number = 10): Promise<boolean> {
    if (!this.connectable || this.connected || this.connecting) {
      log("Peripheral state:", this.peripheral.state);
      return false;
    }
    if (this.peripheral.state == "connected") {
      this.connected = true;
      return true;
    }
    this.connecting = true;
    log("Peripheral connect start");

    // Settle on the native connect callback (success or error) rather than
    // polling: this resolves as soon as the outcome is known, and clearing the
    // timeout guarantees a connection that completes in time is never torn down
    // by cancelConnect. A late success after the timeout has fired is ignored
    // (already cancelled); onDisconnect then cleans up the flags.
    const connected = await new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        log("Peripheral connect timeout");
        try {
          this.peripheral.cancelConnect();
        } catch (error) { /* swallow */ }
        resolve(false);
      }, timeout * 1000);

      this.peripheral.connect((error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (error !== undefined && error != null) {
          log("Peripheral connect error:", error);
          resolve(false);
        } else {
          log("Peripheral state:", this.peripheral.state);
          resolve(this.peripheral.state == "connected");
        }
      });
    });

    if (!connected) {
      this.connecting = false;
      return false;
    }
    this.connected = true;
    this.connecting = false;
    log("Device emiting connected");
    this.emit("connected");
    return true;
  }

  async disconnect(): Promise<boolean> {
    if (this.connectable && this.connected) {
      try {
        await this.peripheral.disconnectAsync();
        return true;
      } catch (error) {
        log.error(error);
        return false;
      }
    }
    return false;
  }

  /**
   * Discover all services, characteristics and descriptors
   */
  async discoverAll(): Promise<Map<string, ServiceInterface>> {
    try {
      this.checkBusy();
      if (!this.connected) {
        this.resetBusy();
        throw new Error("NobleDevice not connected");
      }
      const snc =
        await this.peripheral.discoverAllServicesAndCharacteristicsAsync();
      this.resetBusy();
      this.services = new Map();
      snc.services.forEach((service) => {
        const s = new NobleService(this, service);
        this.services.set(s.getUUID(), s);
      });
      return this.services;
    } catch (error) {
      log.error(error);
      this.resetBusy();
      return new Map();
    }
  }

  /**
   * Discover services only
   */
  async discoverServices(): Promise<Map<string, ServiceInterface>> {
    try {
      this.checkBusy();
      if (!this.connected) {
        this.resetBusy();
        throw new Error("NobleDevice not connected");
      }
      this.services = new Map();
      // Settle on the discovery callback rather than polling every 10 ms. The
      // old loop also swallowed the error argument entirely and simply waited
      // out its 10 s budget on a failed discovery.
      const services = await new Promise<Service[]>((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          log("Peripheral discoverServices timeout");
          resolve([]);
        }, DISCOVER_SERVICES_TIMEOUT_MS);

        this.peripheral.discoverServices([], (error, discoveredServices) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error !== undefined && error != null) {
            log.error("Peripheral discoverServices error:", error);
            resolve([]);
          } else {
            resolve(discoveredServices ?? []);
          }
        });
      });

      this.resetBusy();
      if (!this.connected) {
        return this.services;
      }
      if (services.length > 0) {
        for (let service of services) {
          const s = new NobleService(this, service);
          this.services.set(s.getUUID(), s);
        }
      }
      return this.services;
    } catch (error) {
      log.error(error);
      this.resetBusy();
      return new Map();
    }
  }

  /**
   * Read all available characteristics
   */
  async readCharacteristics(): Promise<boolean> {
    try {
      if (!this.connected) {
        throw new Error("NobleDevice not connected");
      }
      if (this.services.size == 0) {
        await this.discoverServices();
      }
      for (let [uuid, service] of this.services) {
        for (let [uuid, characteristic] of service.characteristics) {
          if (characteristic.properties.includes("read")) {
            log("Reading", uuid);
            const data = await characteristic.read();
            if (data !== undefined) {
              log("Data", data.toString("ascii"));
            }
          }
        }
      }
      return true;
    } catch (error) {
      log.error(error);
      return false;
    }
  }

  onConnect_OLD(error: string) {
    log("Peripheral connect triggered");
  }

  onDisconnect_OLD(error: string) {
    this.connected = false;
    this.connecting = false;
    this.resetBusy();
    this.services.forEach((service) => service.dispose());
    this.services = new Map();
    this.emit("disconnected");
  }

  toString(): string {
    let text = "";
    this.services.forEach((service) => {
      text += service.toString() + "\n";
    });
    return text;
  }

  onConnect(error: string) {
  console.log(
    `[NOBLE EVENT] peripheral emitted CONNECT for ${this.address}`
  );

  console.log(
    `[NOBLE EVENT] state=${this.peripheral.state}, ` +
    `wrapper.connected=${this.connected}, ` +
    `wrapper.connecting=${this.connecting}`
  );

  if (error) {
    console.warn(`[NOBLE EVENT] connect event error=${error}`);
  }
}

onDisconnect(error: string) {
  console.warn(
    `[NOBLE EVENT] peripheral emitted DISCONNECT for ${this.address}`
  );

  console.warn(
    `[NOBLE EVENT] state=${this.peripheral.state}, ` +
    `wrapper.connected=${this.connected}, ` +
    `wrapper.connecting=${this.connecting}`
  );

  if (error) {
    console.warn(`[NOBLE EVENT] disconnect error=${error}`);
  }

  this.connected = false;
  this.connecting = false;

  this.resetBusy();

  this.services.forEach((service) => service.dispose());
  this.services = new Map();

  console.log("[NOBLE EVENT] Emitting SDK disconnected event");

  this.emit("disconnected");
}

  toJSON(asObject: boolean = false): string | Object {
    let json: Record<string, any> = {
      id: this.id,
      uuid: this.uuid,
      name: this.name,
      address: this.address,
      addressType: this.addressType,
      connectable: this.connectable,
      rssi: this.rssi,
      mtu: this.mtu,
      services: {},
    };
    let services: Record<string, any> = {};
    this.services.forEach((service) => {
      json.services[service.uuid] = service.toJSON(true);
    });

    if (asObject) {
      return json;
    } else {
      return JSON.stringify(json);
    }
  }
}
