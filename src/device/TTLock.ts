'use strict';

import { CommandEnvelope } from '../api/CommandEnvelope';
import { Fingerprint, ICCard, KeyboardPassCode, LogEntry, PassageModeData } from '../api/Commands';
import { CodeSecret } from '../api/Commands/InitPasswordsCommand';
import { AudioManage } from '../constant/AudioManage';
import { ConfigRemoteUnlock } from '../constant/ConfigRemoteUnlock';
import { FeatureValue } from '../constant/FeatureValue';
import { AccessoryType } from '../api/Commands/AccessoryBatteryCommand';
import { UnlockDirection } from '../api/Commands/UnlockDirectionCommand';
import { KeyboardPwdType } from '../constant/KeyboardPwdType';
import { LockType } from '../constant/Lock';
import { LockedStatus } from '../constant/LockedStatus';
import { LockSoundVolume } from '../constant/LockSoundVolume';
import { PassageModeOperate } from '../constant/PassageModeOperate';
import { TTLockData, TTLockPrivateData, TTLockPsPath } from '../store/TTLockData';
import { waitForEvent } from '../util/timingUtil';
import { createLogger } from '../util/logger';
import { TTBluetoothDevice } from './TTBluetoothDevice';
import { LockParamsChanged, NoMoreOperationDataError, PasscodeOperationError, TTLockApi } from './TTLockApi';

const log = createLogger('ttlock:api');

export interface TTLock {
  /** Event used by TTLockClient to update it's internal lock data */
  on(event: 'dataUpdated', listener: (lock: TTLock) => void): this;
  on(event: 'updated', listener: (lock: TTLock, paramsChanged: LockParamsChanged) => void): this;
  on(event: 'lockReset', listener: (address: string, id: string) => void): this;
  on(event: 'connected', listener: (lock: TTLock) => void): this;
  on(event: 'disconnected', listener: (lock: TTLock) => void): this;
  on(event: 'locked', listener: (lock: TTLock) => void): this;
  on(event: 'unlocked', listener: (lock: TTLock) => void): this;
  /** Emited when an IC Card is ready to be scanned */
  on(event: 'scanICStart', listener: (lock: TTLock) => void): this;
  /** Emited when a fingerprint is ready to be scanned */
  on(event: 'scanFRStart', listener: (lock: TTLock) => void): this;
  /** Emited after each fingerprint scan */
  on(event: 'scanFRProgress', listener: (lock: TTLock) => void): this;
  isInSettingMode(): boolean;
  isTouched(): boolean;
  getProtocolType(): number;
  getProtocolVersion(): number;
}

export class TTLock extends TTLockApi implements TTLock {
  /** Upper bound on the persisted set of known-absent operation-log sequences. */
  static readonly MAX_MISSING_SEQUENCES = 10000;

  private connected: boolean;
  private skipDataRead: boolean = false;
  private connecting: boolean = false;
  // Pending auto-lock timer armed after an unlock(). Tracked so it can be
  // cancelled on a manual lock/unlock or a disconnect, instead of firing a
  // stale 'locked' event (and stacking duplicates across rapid unlocks).
  private autoLockTimer?: ReturnType<typeof setTimeout>;

  // Detail of the most recent passcode-operation rejection by the firmware.
  // Reset at the start of each addPassCode/updatePassCode/deletePassCode/clearPassCodes/getPassCodes call.
  // Callers can read this after the method returns false/empty to know *why* the lock refused.
  public lastPasscodeError: PasscodeOperationError | null = null;

  constructor(device: TTBluetoothDevice, data?: TTLockData) {
    super(device, data);
    this.connected = false;

    this.device.on('connected', this.onConnected.bind(this));
    this.device.on('disconnected', this.onDisconnected.bind(this));
    this.device.on('updated', this.onTTDeviceUpdated.bind(this));
    this.device.on('dataReceived', this.onDataReceived.bind(this));
  }

  getAddress(): string {
    return this.device.address;
  }

  getName(): string {
    return this.device.name;
  }

  getManufacturer(): string {
    return this.device.manufacturer;
  }

  getModel(): string {
    return this.device.model;
  }

  getFirmware(): string {
    return this.device.firmware;
  }

  getBattery(): number {
    return this.batteryCapacity;
  }

  getRssi(): number {
    return this.rssi;
  }

  isInSettingMode(): boolean {
    return this.device.isSettingMode;
  }

  isTouched(): boolean {
    return this.device.isTouch;
  }

  getProtocolType(): number {
    return this.device.protocolType;
  }

  getProtocolVersion(): number {
    return this.device.protocolVersion;
  }

  /**
   * Returns the device info object populated during `initLock()`.
   * Contains `modelNum`, `hardwareRevision`, `firmwareRevision`, `factoryDate`, etc.
   * Returns `undefined` if the lock has not been initialised yet.
   */
  getLockSystemInfo(): import('./DeviceInfoType').DeviceInfoType | undefined {
    return this.deviceInfo;
  }

  /**
   * Returns the firmware revision string from device info (e.g. "2.1.16.705").
   * Requires the lock to have been initialised first.
   */
  getLockVersion(): string | undefined {
    return this.deviceInfo?.firmwareRevision;
  }

  /**
   * Returns the battery level (0-100) of a connected accessory (door sensor, remote control, etc.).
   * Requires FeatureValue.ACCESSORY_BATTERY in the lock feature list.
   */
  async getAccessoryBatteryLevel(type: AccessoryType): Promise<number> {
    if (!this.isConnected()) {
      throw new Error('Lock is not connected');
    }
    if (!this.initialized) {
      throw new Error('Lock is not initialized');
    }
    if (!this.featureList?.has(FeatureValue.ACCESSORY_BATTERY)) {
      throw new Error('Lock does not support accessory battery reading');
    }
    if (await this.macro_adminLogin()) {
      return this.getAccessoryBatteryCommand(type);
    }
    throw new Error('Admin login failed');
  }

  /**
   * Returns the current unlock direction setting.
   * Requires FeatureValue.UNLOCK_DIRECTION in the lock feature list.
   */
  async getUnlockDirection(): Promise<UnlockDirection> {
    if (!this.isConnected()) {
      throw new Error('Lock is not connected');
    }
    if (!this.initialized) {
      throw new Error('Lock is not initialized');
    }
    if (!this.featureList?.has(FeatureValue.UNLOCK_DIRECTION)) {
      throw new Error('Lock does not support unlock direction');
    }
    if (await this.macro_adminLogin()) {
      return this.unlockDirectionCommand();
    }
    throw new Error('Admin login failed');
  }

  /**
   * Sets the unlock direction (handle rotation side).
   * Requires FeatureValue.UNLOCK_DIRECTION in the lock feature list.
   */
  async setUnlockDirection(direction: UnlockDirection): Promise<boolean> {
    if (!this.isConnected()) {
      throw new Error('Lock is not connected');
    }
    if (!this.initialized) {
      throw new Error('Lock is not initialized');
    }
    if (!this.featureList?.has(FeatureValue.UNLOCK_DIRECTION)) {
      throw new Error('Lock does not support unlock direction');
    }
    if (await this.macro_adminLogin()) {
      await this.unlockDirectionCommand(direction);
      return true;
    }
    throw new Error('Admin login failed');
  }

  async connect(skipDataRead: boolean = false, timeout: number = 15): Promise<boolean> {
    if (this.connecting) {
      log('Connect already in progress');
      return false;
    }
    if (this.connected) {
      return true;
    }
    this.connecting = true;
    this.skipDataRead = skipDataRead;
    // try/finally so a throw from device.connect() (or the wait loop) still
    // clears `connecting`; otherwise it stays true and every later connect()
    // is permanently rejected by the guard above.
    try {
      // Settled before device.connect() resolves: onConnected() runs on the
      // device's 'connected' event and is not awaited by it, so the outcome can
      // land while we are still setting up the wait.
      const completed = waitForEvent(this, ['connected', 'disconnected'], timeout * 1000);
      const connected = await this.device.connect();
      if (connected) {
        log('Lock waiting for connection to be completed');
        // Resolves the moment onConnected finishes (or the lock drops), instead
        // of on the next tick of a 100 ms poll.
        await completed.promise;
      } else {
        log('Lock connect failed');
        completed.cancel();
      }
    } finally {
      this.skipDataRead = false;
      this.connecting = false;
    }
    // it is possible that even tho device initially connected, reading initial data will disconnect
    return this.connected;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async disconnect(): Promise<void> {
    await this.device.disconnect();
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  isPaired(): boolean {
    const privateData = this.privateData;
    if (privateData.aesKey && privateData.admin && privateData.admin.adminPs && privateData.admin.unlockKey) {
      return true;
    } else {
      return false;
    }
  }

  hasLockSound(): boolean {
    if (this.featureList !== undefined && this.featureList.has(FeatureValue.AUDIO_MANAGEMENT)) {
      return true;
    }
    return false;
  }

  hasPassCode(): boolean {
    if (this.featureList !== undefined && this.featureList.has(FeatureValue.PASSCODE)) {
      return true;
    }
    return false;
  }

  hasICCard(): boolean {
    if (this.featureList !== undefined && this.featureList.has(FeatureValue.IC)) {
      return true;
    }
    return false;
  }

  hasFingerprint(): boolean {
    if (this.featureList !== undefined && this.featureList.has(FeatureValue.FINGER_PRINT)) {
      return true;
    }
    return false;
  }

  hasAutolock(): boolean {
    if (this.featureList !== undefined && this.featureList.has(FeatureValue.AUTO_LOCK)) {
      return true;
    }
    return false;
  }

  hasNewEvents(): boolean {
    return this.newEvents;
  }

  /**
   * Initialize and pair with a new lock
   */
  async initLock(): Promise<boolean> {
    if (!this.isConnected()) {
      throw new Error('Lock is not connected');
    }

    if (this.initialized) {
      throw new Error('Lock is not in pairing mode');
    }

    // TODO: also check if lock is already inited (has AES key)

    try {
      // Init
      log('========= init');
      await this.initCommand();
      log('========= init');

      // Get AES key
      log('========= AES key');
      const aesKey = await this.getAESKeyCommand();
      log('========= AES key:', aesKey.toString('hex'));

      // Add admin
      log('========= admin');
      const admin = await this.addAdminCommand(aesKey);
      log('========= admin:', admin);

      // Calibrate time
      // this seems to fail on some locks
      // see https://github.com/kind3r/hass-addons/issues/11
      try {
        log('========= time');
        await this.calibrateTimeCommand(aesKey);
        log('========= time');
      } catch (error) {
        log.error('calibrateTimeCommand failed:', error);
      }

      // Search device features
      log('========= feature list');
      const featureList = await this.searchDeviceFeatureCommand(aesKey);
      log('========= feature list', featureList);

      let switchState: any,
        lockSound: AudioManage.TURN_ON | AudioManage.TURN_OFF | undefined,
        displayPasscode: 0 | 1 | undefined,
        autoLockTime: number | undefined,
        lightingTime: number | undefined,
        adminPasscode: string | undefined,
        pwdInfo: CodeSecret[] | undefined,
        remoteUnlock: ConfigRemoteUnlock.OP_OPEN | ConfigRemoteUnlock.OP_CLOSE | undefined;

      if (featureList.has(FeatureValue.AUDIO_MANAGEMENT)) {
        log('========= lockSound');
        try {
          lockSound = await this.audioManageCommand(undefined, aesKey);
        } catch (error) {
          log.error('audioManageCommand failed:', error);
        }
        log('========= lockSound:', lockSound);
      }
      if (featureList.has(FeatureValue.PASSWORD_DISPLAY_OR_HIDE)) {
        log('========= displayPasscode');
        displayPasscode = await this.screenPasscodeManageCommand(undefined, aesKey);
        log('========= displayPasscode:', displayPasscode);
      }
      if (featureList.has(FeatureValue.AUTO_LOCK)) {
        log('========= autoLockTime');
        autoLockTime = await this.searchAutoLockTimeCommand(undefined, aesKey);
        log('========= autoLockTime:', autoLockTime);
      }
      if (featureList.has(FeatureValue.GET_ADMIN_CODE)) {
        // Command.COMM_GET_ADMIN_CODE
        log('========= getAdminCode');
        adminPasscode = await this.getAdminCodeCommand(aesKey);
        log('========= getAdminCode', adminPasscode);
        if (adminPasscode == '') {
          log('========= set adminPasscode');
          adminPasscode = await this.setAdminKeyboardPwdCommand(undefined, aesKey);
          log('========= set adminPasscode:', adminPasscode);
        }
      } else if (this.device.lockType == LockType.LOCK_TYPE_V3_CAR) {
        // Command.COMM_GET_ALARM_ERRCORD_OR_OPERATION_FINISHED
      } else if (this.device.lockType == LockType.LOCK_TYPE_V3) {
        log('========= set adminPasscode:');
        adminPasscode = await this.setAdminKeyboardPwdCommand(undefined, aesKey);
        log('========= set adminPasscode:', adminPasscode);
      }

      if (featureList.has(FeatureValue.CONFIG_GATEWAY_UNLOCK)) {
        log('========= remoteUnlock');
        remoteUnlock = await this.controlRemoteUnlockCommand(undefined, aesKey);
        log('========= remoteUnlock:', remoteUnlock);
      }

      log('========= finished');
      await this.operateFinishedCommand(aesKey);
      log('========= finished');

      // save all the data we gathered during init sequence
      if (aesKey) this.privateData.aesKey = Buffer.from(aesKey);
      if (admin) this.privateData.admin = admin;
      if (featureList) this.featureList = featureList;
      if (switchState) this.switchState = switchState;
      if (lockSound) this.lockSound = lockSound;
      if (displayPasscode) this.displayPasscode = displayPasscode;
      if (autoLockTime) this.autoLockTime = autoLockTime;
      if (lightingTime) this.lightingTime = lightingTime;
      if (adminPasscode) this.privateData.adminPasscode = adminPasscode;
      if (pwdInfo) this.privateData.pwdInfo = pwdInfo;
      if (remoteUnlock) this.remoteUnlock = remoteUnlock;
      this.lockedStatus = LockedStatus.LOCKED; // always locked by default

      // read device information
      log('========= device info');
      try {
        this.deviceInfo = await this.macro_readAllDeviceInfo(aesKey);
      } catch (error) {
        log.error('macro_readAllDeviceInfo failed:', error);
      }
      log('========= device info:', this.deviceInfo);
    } catch (error) {
      log.error('Error while initialising lock', error);
      return false;
    }

    // TODO: we should now refresh the device's data (disconnect and reconnect maybe ?)
    this.initialized = true;
    this.emit('dataUpdated', this);
    return true;
  }

  /**
   * Obtains a valid psFromLock for a lock/unlock operation.
   * First tries the "user" path (checkUserTime). If the lock rejects it
   * (no registered user, room-lock type lock, etc.), automatically falls
   * back to the "admin" path (checkAdmin only — the challenge is then
   * consumed directly by unlockCommand/lockCommand via setSum).
   */
  /**
   * Obtain a psFromLock for unlockCommand/lockCommand.
   *
   * A lock answers exactly one of the two challenge commands, so the other one
   * always fails — a wasted BLE round-trip (plus its CRC retries) before every
   * single lock()/unlock(). Which one works is a property of the lock, not of
   * the moment, so the winner is remembered and persisted, and tried first from
   * then on. The other one stays as a fallback: a lock that is re-paired, or
   * whose admin credentials change, flips back on its own.
   */
  private async getPsFromLock(): Promise<number> {
    const preferred: TTLockPsPath = this.psPath ?? 'user';
    const fallback: TTLockPsPath = preferred == 'user' ? 'admin' : 'user';

    try {
      const ps = await this.challengeForPs(preferred);
      this.setPsPath(preferred);
      return ps;
    } catch (error) {
      log(`========= ${preferred} challenge failed, falling back to ${fallback} path:`, error);
      const ps = await this.challengeForPs(fallback);
      this.setPsPath(fallback);
      return ps;
    }
  }

  /** Runs one challenge command, throwing if it does not yield a usable psFromLock. */
  private async challengeForPs(path: TTLockPsPath): Promise<number> {
    if (path == 'user') {
      log('========= check user time');
      const ps = await this.checkUserTime();
      log('========= check user time OK', ps);
      if (ps <= 0) {
        throw new Error(`Invalid psFromLock from checkUserTime: ${ps}`);
      }
      return ps;
    }
    // Admin path: checkAdmin only — the psFromLock is then passed to
    // unlockCommand/lockCommand which sends setSum(ps, unlockKey).
    // Do NOT call checkRandom here: it would consume the challenge and the
    // next unlock command would be rejected by the lock.
    log('========= check admin (admin path)');
    const ps = await this.checkAdminCommand();
    log('========= check admin OK:', ps);
    if (ps <= 0) {
      throw new Error(`Invalid psFromLock from checkAdmin: ${ps}`);
    }
    return ps;
  }

  /** Remembers the working challenge path, persisting it when it changes. */
  private setPsPath(path: TTLockPsPath): void {
    if (this.psPath != path) {
      this.psPath = path;
      this.emit('dataUpdated', this);
    }
  }

  /**
   * Lock the lock
   */
  async lock(): Promise<boolean> {
    if (!this.isConnected()) {
      throw new Error('Lock is not connected');
    }

    if (!this.initialized) {
      throw new Error('Lock is in pairing mode');
    }

    try {
      const psFromLock = await this.getPsFromLock();
      log('========= lock');
      const lockData = await this.lockCommand(psFromLock);
      log('========= lock', lockData);
      // A manual lock supersedes any pending auto-lock timer.
      if (this.autoLockTimer) {
        clearTimeout(this.autoLockTimer);
        this.autoLockTimer = undefined;
      }
      this.lockedStatus = LockedStatus.LOCKED;
      this.emit('locked', this);
    } catch (error) {
      log.error('Error locking the lock', error);
      return false;
    }

    return true;
  }

  /**
   * Unlock the lock
   */
  async unlock(): Promise<boolean> {
    if (!this.isConnected()) {
      throw new Error('Lock is not connected');
    }

    if (!this.initialized) {
      throw new Error('Lock is in pairing mode');
    }

    try {
      const psFromLock = await this.getPsFromLock();
      log('========= unlock');
      const unlockData = await this.unlockCommand(psFromLock);
      log('========= unlock', unlockData);
      this.lockedStatus = LockedStatus.UNLOCKED;
      this.emit('unlocked', this);
      // if autolock is on, then emit locked event after the timeout has passed
      if (this.autoLockTimer) {
        clearTimeout(this.autoLockTimer);
        this.autoLockTimer = undefined;
      }
      if (this.autoLockTime > 0) {
        this.autoLockTimer = setTimeout(() => {
          this.autoLockTimer = undefined;
          this.lockedStatus = LockedStatus.LOCKED;
          this.emit('locked', this);
        }, this.autoLockTime * 1000);
      }
    } catch (error) {
      log.error('Error unlocking the lock', error);
      return false;
    }

    return true;
  }

  /**
   * Get the status of the lock (locked or unlocked)
   */
  async getLockStatus(noCache: boolean = false): Promise<LockedStatus> {
    if (!this.initialized) {
      throw new Error('Lock is in pairing mode');
    }

    const oldStatus = this.lockedStatus;

    if (noCache || this.lockedStatus == LockedStatus.UNKNOWN || this.statusUnverified) {
      if (!this.isConnected()) {
        throw new Error('Lock is not connected');
      }

      try {
        log('========= check lock status');
        this.lockedStatus = await this.searchBycicleStatusCommand();
        this.statusUnverified = false;
        log('========= check lock status', this.lockedStatus);
      } catch (error) {
        log.error('Error getting lock status', error);
      }
    }

    if (oldStatus != this.lockedStatus) {
      if (this.lockedStatus == LockedStatus.LOCKED) {
        this.emit('locked', this);
      } else {
        this.emit('unlocked', this);
      }
    }

    return this.lockedStatus;
  }

  async getAutolockTime(noCache: boolean = false): Promise<number> {
    if (!this.initialized) {
      throw new Error('Lock is in pairing mode');
    }

    const oldAutoLockTime = this.autoLockTime;

    if (noCache || this.autoLockTime == -1) {
      if (this.featureList !== undefined) {
        if (this.featureList.has(FeatureValue.AUTO_LOCK)) {
          if (!this.isConnected()) {
            throw new Error('Lock is not connected');
          }

          try {
            if (await this.macro_adminLogin()) {
              log('========= autoLockTime');
              this.autoLockTime = await this.searchAutoLockTimeCommand();
              log('========= autoLockTime:', this.autoLockTime);
            }
          } catch (error) {
            log.error('getAutolockTime:', error);
          }
        }
      }
    }

    if (oldAutoLockTime != this.autoLockTime) {
      this.emit('dataUpdated', this);
    }

    return this.autoLockTime;
  }

  /**
   * Synchronizes the lock's clock with the current system time.
   * Equivalent to setLockTime() in the official TTLock SDK.
   */
  async setLockTime(): Promise<boolean> {
    if (!this.isConnected()) {
      throw new Error('Lock is not connected');
    }
    if (!this.initialized) {
      throw new Error('Lock is in pairing mode');
    }
    try {
      await this.calibrateTimeCommand();
      return true;
    } catch (error) {
      log.error('setLockTime:', error);
      return false;
    }
  }

  /**
   * Reads the lock's current time.
   * Equivalent to getLockTime() in the official TTLock SDK.
   * @returns Date — the lock's internal time
   */
  async getLockTime(): Promise<Date> {
    if (!this.isConnected()) {
      throw new Error('Lock is not connected');
    }
    if (!this.initialized) {
      throw new Error('Lock is in pairing mode');
    }
    return this.getLockTimeCommand();
  }

  async setAutoLockTime(autoLockTime: number): Promise<boolean> {
    if (!this.isConnected()) {
      throw new Error('Lock is not connected');
    }

    if (!this.initialized) {
      throw new Error('Lock is in pairing mode');
    }

    if (this.autoLockTime != autoLockTime) {
      if (this.featureList !== undefined) {
        if (this.featureList.has(FeatureValue.AUTO_LOCK)) {
          try {
            if (await this.macro_adminLogin()) {
              log('========= autoLockTime');
              await this.searchAutoLockTimeCommand(autoLockTime);
              log('========= autoLockTime set:', autoLockTime);
              this.autoLockTime = autoLockTime;
              this.emit('dataUpdated', this);
              return true;
            }
          } catch (error) {
            log.error('setAutoLockTime:', error);
          }
        }
      }
    }

    return false;
  }

  async getLockSound(noCache: boolean = false): Promise<AudioManage> {
    if (!this.initialized) {
      throw new Error('Lock is in pairing mode');
    }

    const oldSound = this.lockSound;

    if (noCache || this.lockSound == AudioManage.UNKNOWN) {
      if (this.featureList !== undefined && this.featureList.has(FeatureValue.AUDIO_MANAGEMENT)) {
        if (!this.isConnected()) {
          throw new Error('Lock is not connected');
        }

        try {
          log('========= lockSound');
          this.lockSound = await this.audioManageCommand();
          log('========= lockSound:', this.lockSound);
        } catch (error) {
          log.error('Error getting lock sound status', error);
        }
      }
    }

    if (oldSound != this.lockSound) {
      this.emit('dataUpdated', this);
    }

    return this.lockSound;
  }

  /**
   * Set the lock buzzer volume.
   *
   * **Breaking change in 0.4.0**: parameter type changed from `AudioManage` to `LockSoundVolume`.
   * Pass a boolean will throw a TypeError at runtime with a migration hint.
   *
   * @param lockSound - Target volume level (`LockSoundVolume.OFF`, `ON`, or `HIGH`).
   *   `HIGH` is mapped to ON on locks that only support on/off.
   */
  async setLockSound(lockSound: LockSoundVolume): Promise<boolean> {
    if (typeof (lockSound as unknown) === 'boolean') {
      throw new TypeError('setLockSound() no longer accepts a boolean. ' + 'Use LockSoundVolume.OFF or LockSoundVolume.ON instead.');
    }
    if (!this.isConnected()) {
      throw new Error('Lock is not connected');
    }

    if (!this.initialized) {
      throw new Error('Lock is in pairing mode');
    }

    // Map LockSoundVolume to AudioManage (protocol only distinguishes 0 vs 1)
    const audioValue: AudioManage.TURN_ON | AudioManage.TURN_OFF = lockSound === LockSoundVolume.OFF ? AudioManage.TURN_OFF : AudioManage.TURN_ON;

    if (this.lockSound !== audioValue) {
      if (this.featureList !== undefined && this.featureList.has(FeatureValue.AUDIO_MANAGEMENT)) {
        try {
          if (await this.macro_adminLogin()) {
            log('========= lockSound');
            this.lockSound = await this.audioManageCommand(audioValue);
            log('========= lockSound:', this.lockSound);
            this.emit('dataUpdated', this);
            return true;
          }
        } catch (error) {
          log.error('setLockSound:', error);
        }
      }
    }

    return false;
  }

  async resetLock(): Promise<boolean> {
    if (!this.isConnected()) {
      throw new Error('Lock is not connected');
    }

    if (!this.initialized) {
      throw new Error('Lock is in pairing mode');
    }

    try {
      if (await this.macro_adminLogin()) {
        log('========= reset');
        await this.resetLockCommand();
        log('========= reset');
      } else {
        return false;
      }
    } catch (error) {
      log.error('Error while reseting the lock', error);
      return false;
    }

    // The firmware restarts its record counter from zero after a reset, so the sequences
    // recorded as permanently absent no longer describe anything real.
    this.missingSequences.clear();

    await this.disconnect();
    this.emit('lockReset', this.device.address, this.device.id);
    return true;
  }

  /**
   * Re-synchronizes the physical keypad admin passcode of the lock with a
   * value known to the SDK. Does not affect the BLE pairing nor `lockData.json`.
   *
   * Useful when the keypad admin has been changed via the lock (events
   * recordType 92/93) and the firmware blocks certain BLE operations
   * (typically adding user passcodes → 0x14).
   *
   * @param passcode 4-9 digits. If omitted, a random 7-digit code is generated.
   * @returns The keypad admin passcode actually set, or false on failure.
   */
  async syncAdminKeyboardPasscode(passcode?: string): Promise<string | false> {
    if (!this.isConnected()) {
      throw new Error('Lock is not connected');
    }

    if (!this.initialized) {
      throw new Error('Lock is in pairing mode');
    }

    try {
      if (await this.macro_adminLogin()) {
        log('========= sync admin keyboard passcode');
        const result = await this.setAdminKeyboardPwdCommand(passcode);
        log('========= sync admin keyboard passcode', result);
        return result;
      } else {
        return false;
      }
    } catch (error) {
      log.error('Error while syncing admin keyboard passcode', error);
      return false;
    }
  }

  /**
   * Programs an "erase passcode": a 4-9 digit code that, typed on the physical keypad,
   * triggers a factory reset of the lock. Useful as a last resort when the keypad module is
   * locked by the firmware (code 0x14) and the classic admin-write commands are
   * rejected — this command uses COMM_SET_DELETE_PWD (0x44), a separate channel.
   *
   * @param erasePasscode 4-9 digits
   * @returns The passcode that was set, or false on failure.
   */
  async setErasePasscode(erasePasscode: string): Promise<string | false> {
    if (!this.isConnected()) {
      throw new Error('Lock is not connected');
    }

    if (!this.initialized) {
      throw new Error('Lock is in pairing mode');
    }

    if (!/^\d{4,9}$/.test(erasePasscode)) {
      throw new Error('erasePasscode must be 4 to 9 digits');
    }

    try {
      if (await this.macro_adminLogin()) {
        log('========= set erase passcode');
        const result = await this.setEraseKeyboardPwdCommand(erasePasscode);
        log('========= set erase passcode', result);
        return result;
      } else {
        return false;
      }
    } catch (error) {
      log.error('Error while setting erase passcode', error);
      return false;
    }
  }

  async getPassageMode(): Promise<PassageModeData[]> {
    if (!this.isConnected()) {
      throw new Error('Lock is not connected');
    }

    if (!this.initialized) {
      throw new Error('Lock is in pairing mode');
    }

    let data: PassageModeData[] = [];

    try {
      if (await this.macro_adminLogin()) {
        let sequence = 0;
        do {
          log('========= get passage mode');
          const response = await this.getPassageModeCommand(sequence);
          log('========= get passage mode', response);
          sequence = response.sequence;
          response.data.forEach((passageData) => {
            data.push(passageData);
          });
        } while (sequence != -1);
      }
    } catch (error) {
      log.error('Error while getting passage mode', error);
    }

    return data;
  }

  async setPassageMode(data: PassageModeData): Promise<boolean> {
    if (!this.isConnected()) {
      throw new Error('Lock is not connected');
    }

    if (!this.initialized) {
      throw new Error('Lock is in pairing mode');
    }

    try {
      if (await this.macro_adminLogin()) {
        log('========= set passage mode');
        await this.setPassageModeCommand(data);
        log('========= set passage mode');
      } else {
        return false;
      }
    } catch (error) {
      log.error('Error while getting passage mode', error);
      return false;
    }

    return true;
  }

  async deletePassageMode(data: PassageModeData): Promise<boolean> {
    if (!this.isConnected()) {
      throw new Error('Lock is not connected');
    }

    if (!this.initialized) {
      throw new Error('Lock is in pairing mode');
    }

    try {
      if (await this.macro_adminLogin()) {
        log('========= delete passage mode');
        await this.setPassageModeCommand(data, PassageModeOperate.DELETE);
        log('========= delete passage mode');
      } else {
        return false;
      }
    } catch (error) {
      log.error('Error while deleting passage mode', error);
      return false;
    }

    return true;
  }

  async clearPassageMode(): Promise<boolean> {
    if (!this.isConnected()) {
      throw new Error('Lock is not connected');
    }

    if (!this.initialized) {
      throw new Error('Lock is in pairing mode');
    }

    try {
      if (await this.macro_adminLogin()) {
        log('========= clear passage mode');
        await this.clearPassageModeCommand();
        log('========= clear passage mode');
      } else {
        return false;
      }
    } catch (error) {
      log.error('Error while deleting passage mode', error);
      return false;
    }

    return true;
  }

  /**
   * Add a new passcode to unlock
   * @param type PassCode type: 1 - permanent, 2 - one time, 3 - limited time
   * @param passCode 4-9 digits code
   * @param startDate Valid from YYYYMMDDHHmm
   * @param endDate Valid to YYYYMMDDHHmm
   */
  async addPassCode(type: KeyboardPwdType, passCode: string, startDate?: string, endDate?: string): Promise<boolean> {
    if (!this.initialized) {
      throw new Error('Lock is in pairing mode');
    }

    if (!this.hasPassCode()) {
      log.warn('Lock does not report PassCode support, trying anyway');
    }

    if (!this.isConnected()) {
      throw new Error('Lock is not connected');
    }

    this.lastPasscodeError = null;
    try {
      if (await this.macro_adminLogin()) {
        log('========= add passCode');
        const result = await this.createCustomPasscodeCommand(type, passCode, startDate, endDate);
        log('========= add passCode', result);
        return result;
      } else {
        return false;
      }
    } catch (error) {
      if (error instanceof PasscodeOperationError) {
        this.lastPasscodeError = error;
      }
      log.error('Error while adding passcode', error);
      return false;
    }
  }

  /**
   * Recover a passcode that was previously known to the lock (uses PwdOperateType.RECOVERY=6).
   * Useful when the firmware passcode index is corrupted but the lock still has the slot reserved —
   * recover may succeed where add returns 0x14 (keyboard module lockdown).
   *
   * @param type PassCode type: 1 - permanent, 2 - one time, 3 - limited time
   * @param passCode 4-9 digits code
   * @param startDate Valid from YYYYMMDDHHmm
   * @param endDate Valid to YYYYMMDDHHmm
   */
  async recoverPassCode(type: KeyboardPwdType, passCode: string, startDate?: string, endDate?: string): Promise<boolean> {
    if (!this.initialized) {
      throw new Error('Lock is in pairing mode');
    }

    if (!this.isConnected()) {
      throw new Error('Lock is not connected');
    }

    this.lastPasscodeError = null;
    try {
      if (await this.macro_adminLogin()) {
        log('========= recover passCode');
        const result = await this.recoverCustomPasscodeCommand(type, passCode, startDate, endDate);
        log('========= recover passCode', result);
        return result;
      } else {
        return false;
      }
    } catch (error) {
      if (error instanceof PasscodeOperationError) {
        this.lastPasscodeError = error;
      }
      log.error('Error while recovering passcode', error);
      return false;
    }
  }

  /**
   * Update a passcode to unlock
   * @param type PassCode type: 1 - permanent, 2 - one time, 3 - limited time
   * @param oldPassCode 4-9 digits code - old code
   * @param newPassCode 4-9 digits code - new code
   * @param startDate Valid from YYYYMMDDHHmm
   * @param endDate Valid to YYYYMMDDHHmm
   */
  async updatePassCode(type: KeyboardPwdType, oldPassCode: string, newPassCode: string, startDate?: string, endDate?: string): Promise<boolean> {
    if (!this.initialized) {
      throw new Error('Lock is in pairing mode');
    }

    if (!this.hasPassCode()) {
      log.warn('Lock does not report PassCode support, trying anyway');
    }

    if (!this.isConnected()) {
      throw new Error('Lock is not connected');
    }

    this.lastPasscodeError = null;
    try {
      if (await this.macro_adminLogin()) {
        log('========= update passCode');
        const result = await this.updateCustomPasscodeCommand(type, oldPassCode, newPassCode, startDate, endDate);
        log('========= update passCode', result);
        return result;
      } else {
        return false;
      }
    } catch (error) {
      if (error instanceof PasscodeOperationError) {
        this.lastPasscodeError = error;
      }
      log.error('Error while updating passcode', error);
      return false;
    }
  }

  /**
   * Delete a set passcode
   * @param type PassCode type: 1 - permanent, 2 - one time, 3 - limited time
   * @param passCode 4-9 digits code
   */
  async deletePassCode(type: KeyboardPwdType, passCode: string): Promise<boolean> {
    if (!this.initialized) {
      throw new Error('Lock is in pairing mode');
    }

    if (!this.hasPassCode()) {
      log.warn('Lock does not report PassCode support, trying anyway');
    }

    if (!this.isConnected()) {
      throw new Error('Lock is not connected');
    }

    this.lastPasscodeError = null;
    try {
      if (await this.macro_adminLogin()) {
        log('========= delete passCode');
        const result = await this.deleteCustomPasscodeCommand(type, passCode);
        log('========= delete passCode', result);
        return result;
      } else {
        return false;
      }
    } catch (error) {
      if (error instanceof PasscodeOperationError) {
        this.lastPasscodeError = error;
      }
      log.error('Error while deleting passcode', error);
      return false;
    }
  }

  /**
   * Remove all stored passcodes
   */
  async clearPassCodes(): Promise<boolean> {
    if (!this.initialized) {
      throw new Error('Lock is in pairing mode');
    }

    if (!this.hasPassCode()) {
      log.warn('Lock does not report PassCode support, trying anyway');
    }

    if (!this.isConnected()) {
      throw new Error('Lock is not connected');
    }

    this.lastPasscodeError = null;
    try {
      if (await this.macro_adminLogin()) {
        log('========= clear passCodes');
        const result = await this.clearCustomPasscodesCommand();
        log('========= clear passCodes', result);
        return result;
      } else {
        return false;
      }
    } catch (error) {
      if (error instanceof PasscodeOperationError) {
        this.lastPasscodeError = error;
      }
      log.error('Error while clearing passcodes', error);
      return false;
    }
  }

  /**
   * Get all valid passcodes
   */
  async getPassCodes(): Promise<KeyboardPassCode[]> {
    if (!this.initialized) {
      throw new Error('Lock is in pairing mode');
    }

    if (!this.hasPassCode()) {
      log.warn('Lock does not report PassCode support, trying anyway');
    }

    if (!this.isConnected()) {
      throw new Error('Lock is not connected');
    }

    let data: KeyboardPassCode[] = [];

    this.lastPasscodeError = null;
    try {
      if (await this.macro_adminLogin()) {
        let sequence = 0;
        do {
          log('========= get passCodes', sequence);
          const response = await this.getCustomPasscodesCommand(sequence);
          log('========= get passCodes', response);
          sequence = response.sequence;
          response.data.forEach((passageData) => {
            data.push(passageData);
          });
        } while (sequence != -1);
      }
    } catch (error) {
      if (error instanceof PasscodeOperationError) {
        this.lastPasscodeError = error;
      }
      log.error('Error while getting passCodes', error);
    }

    return data;
  }

  /**
   * Add an IC Card
   * @param startDate Valid from YYYYMMDDHHmm
   * @param endDate Valid to YYYYMMDDHHmm
   * @param cardNumber serial number of an already known card
   * @returns serial number of the card that was added
   */
  async addICCard(startDate: string, endDate: string, cardNumber?: string): Promise<string> {
    if (!this.initialized) {
      throw new Error('Lock is in pairing mode');
    }

    if (!this.hasICCard()) {
      throw new Error('No IC Card support');
    }

    if (!this.isConnected()) {
      throw new Error('Lock is not connected');
    }

    let data: string = '';

    try {
      if (await this.macro_adminLogin()) {
        log('========= add IC Card');
        if (cardNumber !== undefined) {
          const addedCardNumber = await this.addICCommand(cardNumber, startDate, endDate);
          log('========= add IC Card', addedCardNumber);
        } else {
          const addedCardNumber = await this.addICCommand();
          log('========= updating IC Card', addedCardNumber);
          const response = await this.updateICCommand(addedCardNumber, startDate, endDate);
          log('========= updating IC Card', response);
          data = addedCardNumber;
        }
      }
    } catch (error) {
      log.error('Error while adding IC Card', error);
    }

    return data;
  }

  /**
   * Update an IC Card
   * @param cardNumber Serial number of the card
   * @param startDate Valid from YYYYMMDDHHmm
   * @param endDate Valid to YYYYMMDDHHmm
   */
  async updateICCard(cardNumber: string, startDate: string, endDate: string): Promise<boolean> {
    if (!this.initialized) {
      throw new Error('Lock is in pairing mode');
    }

    if (!this.hasICCard()) {
      throw new Error('No IC Card support');
    }

    if (!this.isConnected()) {
      throw new Error('Lock is not connected');
    }

    let data = false;

    try {
      if (await this.macro_adminLogin()) {
        log('========= updating IC Card', cardNumber);
        const response = await this.updateICCommand(cardNumber, startDate, endDate);
        log('========= updating IC Card', response);
        data = response;
      }
    } catch (error) {
      log.error('Error while updating IC Card', error);
    }

    return data;
  }

  /**
   * Delete an IC Card
   * @param cardNumber Serial number of the card
   */
  async deleteICCard(cardNumber: string): Promise<boolean> {
    if (!this.initialized) {
      throw new Error('Lock is in pairing mode');
    }

    if (!this.hasICCard()) {
      throw new Error('No IC Card support');
    }

    if (!this.isConnected()) {
      throw new Error('Lock is not connected');
    }

    let data = false;

    try {
      if (await this.macro_adminLogin()) {
        log('========= updating IC Card', cardNumber);
        const response = await this.deleteICCommand(cardNumber);
        log('========= updating IC Card', response);
        data = response;
      }
    } catch (error) {
      log.error('Error while adding IC Card', error);
    }

    return data;
  }

  /**
   * Clear all IC Card data
   */
  async clearICCards(): Promise<boolean> {
    if (!this.initialized) {
      throw new Error('Lock is in pairing mode');
    }

    if (!this.hasICCard()) {
      throw new Error('No IC Card support');
    }

    if (!this.isConnected()) {
      throw new Error('Lock is not connected');
    }

    let data = false;

    try {
      if (await this.macro_adminLogin()) {
        log('========= clearing IC Cards');
        const response = await this.clearICCommand();
        log('========= clearing IC Cards', response);
        data = response;
      }
    } catch (error) {
      log.error('Error while clearing IC Cards', error);
    }

    return data;
  }

  /**
   * Get all valid IC cards and their validity interval
   */
  async getICCards(): Promise<ICCard[]> {
    if (!this.initialized) {
      throw new Error('Lock is in pairing mode');
    }

    if (!this.hasICCard()) {
      throw new Error('No IC Card support');
    }

    if (!this.isConnected()) {
      throw new Error('Lock is not connected');
    }

    let data: ICCard[] = [];

    try {
      if (await this.macro_adminLogin()) {
        let sequence = 0;
        do {
          log('========= get IC Cards', sequence);
          const response = await this.getICCommand(sequence);
          log('========= get IC Cards', response);
          sequence = response.sequence;
          response.data.forEach((card) => {
            data.push(card);
          });
        } while (sequence != -1);
      } else {
        log.error('getICCards: admin login failed, cannot retrieve IC cards');
      }
    } catch (error) {
      log.error('Error while getting IC Cards', error);
    }

    return data;
  }

  /**
   * Add a Fingerprint
   * @param startDate Valid from YYYYMMDDHHmm
   * @param endDate Valid to YYYYMMDDHHmm
   * @returns serial number of the firngerprint that was added
   */
  async addFingerprint(startDate: string, endDate: string): Promise<string> {
    if (!this.initialized) {
      throw new Error('Lock is in pairing mode');
    }

    if (!this.hasFingerprint()) {
      throw new Error('No fingerprint support');
    }

    if (!this.isConnected()) {
      throw new Error('Lock is not connected');
    }

    let data = '';

    try {
      if (await this.macro_adminLogin()) {
        log('========= add Fingerprint');
        const fpNumber = await this.addFRCommand();
        log('========= updating Fingerprint', fpNumber);
        const response = await this.updateFRCommand(fpNumber, startDate, endDate);
        log('========= updating Fingerprint', response);
        data = fpNumber;
      }
    } catch (error) {
      log.error('Error while adding Fingerprint', error);
    }

    return data;
  }

  /**
   * Update a fingerprint
   * @param fpNumber Serial number of the fingerprint
   * @param startDate Valid from YYYYMMDDHHmm
   * @param endDate Valid to YYYYMMDDHHmm
   */
  async updateFingerprint(fpNumber: string, startDate: string, endDate: string): Promise<boolean> {
    if (!this.initialized) {
      throw new Error('Lock is in pairing mode');
    }

    if (!this.hasFingerprint()) {
      throw new Error('No fingerprint support');
    }

    if (!this.isConnected()) {
      throw new Error('Lock is not connected');
    }

    let data = false;

    try {
      if (await this.macro_adminLogin()) {
        log('========= updating Fingerprint', fpNumber);
        const response = await this.updateFRCommand(fpNumber, startDate, endDate);
        log('========= updating Fingerprint', response);
        data = response;
      }
    } catch (error) {
      log.error('Error while updating Fingerprint', error);
    }

    return data;
  }

  /**
   * Delete a fingerprint
   * @param fpNumber Serial number of the fingerprint
   */
  async deleteFingerprint(fpNumber: string): Promise<boolean> {
    if (!this.initialized) {
      throw new Error('Lock is in pairing mode');
    }

    if (!this.hasFingerprint()) {
      throw new Error('No fingerprint support');
    }

    if (!this.isConnected()) {
      throw new Error('Lock is not connected');
    }

    let data = false;

    try {
      if (await this.macro_adminLogin()) {
        log('========= updating Fingerprint', fpNumber);
        const response = await this.deleteFRCommand(fpNumber);
        log('========= updating Fingerprint', response);
        data = response;
      }
    } catch (error) {
      log.error('Error while adding Fingerprint', error);
    }

    return data;
  }

  /**
   * Clear all fingerprint data
   */
  async clearFingerprints(): Promise<boolean> {
    if (!this.initialized) {
      throw new Error('Lock is in pairing mode');
    }

    if (!this.hasFingerprint()) {
      throw new Error('No fingerprint support');
    }

    if (!this.isConnected()) {
      throw new Error('Lock is not connected');
    }

    let data = false;

    try {
      if (await this.macro_adminLogin()) {
        log('========= clearing Fingerprints');
        const response = await this.clearFRCommand();
        log('========= clearing Fingerprints', response);
        data = response;
      }
    } catch (error) {
      log.error('Error while clearing Fingerprints', error);
    }

    return data;
  }

  /**
   * Get all valid IC cards and their validity interval
   */
  async getFingerprints(): Promise<Fingerprint[]> {
    if (!this.initialized) {
      throw new Error('Lock is in pairing mode');
    }

    if (!this.hasFingerprint()) {
      throw new Error('No fingerprint support');
    }

    if (!this.isConnected()) {
      throw new Error('Lock is not connected');
    }

    let data: Fingerprint[] = [];

    try {
      if (await this.macro_adminLogin()) {
        let sequence = 0;
        do {
          log('========= get Fingerprints', sequence);
          const response = await this.getFRCommand(sequence);
          log('========= get Fingerprints', response);
          sequence = response.sequence;
          response.data.forEach((fingerprint) => {
            data.push(fingerprint);
          });
        } while (sequence != -1);
      } else {
        log.error('getFingerprints: admin login failed, cannot retrieve fingerprints');
      }
    } catch (error) {
      log.error('Error while getting Fingerprints', error);
    }

    return data;
  }

  /**
   * No ideea what this does ...
   * @param type
   */
  async setRemoteUnlock(type?: ConfigRemoteUnlock.OP_CLOSE | ConfigRemoteUnlock.OP_OPEN): Promise<ConfigRemoteUnlock.OP_CLOSE | ConfigRemoteUnlock.OP_OPEN | undefined> {
    if (!this.initialized) {
      throw new Error('Lock is in pairing mode');
    }

    if (this.featureList === undefined) {
      throw new Error('Lock features missing');
    }

    if (!this.featureList.has(FeatureValue.CONFIG_GATEWAY_UNLOCK)) {
      throw new Error('Lock does not support remote unlock');
    }

    if (!this.isConnected()) {
      throw new Error('Lock is not connected');
    }

    try {
      if (await this.macro_adminLogin()) {
        log('========= remoteUnlock');
        if (type !== undefined) {
          this.remoteUnlock = await this.controlRemoteUnlockCommand(type);
        } else {
          this.remoteUnlock = await this.controlRemoteUnlockCommand();
        }
        log('========= remoteUnlock:', this.remoteUnlock);
      }
    } catch (error) {
      log.error('Error on remote unlock', error);
    }

    return this.remoteUnlock;
  }

  /**
   * Read the operation log.
   *
   * @param all      also reconcile the full journal (probe for appended records, then
   *                 backfill missing sequences) instead of returning only what the
   *                 firmware's 0xffff stream produced.
   * @param noCache  start from the freshly-read records instead of the cached journal.
   * @param options  bounds for the `all` mode. The backfill is by far the expensive
   *                 phase: on a lock whose cached journal is capped (callers routinely
   *                 persist only the most recent entries) the missing-sequence list can
   *                 hold thousands of records the firmware no longer has — the journal
   *                 is circular, so those gaps never close and every call re-walks them.
   *                 Left unbounded it outlives the BLE session and keeps issuing
   *                 commands after the caller gave up, colliding with the next session
   *                 ("Command already in progress"). Callers on a hot path should pass
   *                 `skipBackfill: true`.
   */
  async getOperationLog(
    all: boolean = false,
    noCache: boolean = false,
    options: {
      /** Skip the missing-gap backfill entirely (probe for appended records only). */
      skipBackfill?: boolean;
      /** Consecutive empty probes before the appended-record sweep stops. Default 20. */
      maxProbeEmpty?: number;
      /** Wall-clock budget for the probe + backfill phases. Default 5 min. */
      maxDurationMs?: number;
    } = {}
  ): Promise<LogEntry[]> {
    if (!this.initialized) {
      return [];
    }

    if (!this.isConnected()) {
      return [];
    }

    // Admin authentication is required for all BLE log commands
    const adminOk = await this.macro_adminLogin();
    if (!adminOk) {
      return this.operationLog.filter(Boolean) as LogEntry[];
    }

    let newOperations: LogEntry[] = [];

    // in all mode do the following
    // - get new operations
    // - sort operation log by recordNumber
    // - create list of missing/invalid recordNumber
    // - fetch those records

    const maxRetry = 3;

    // first, always get new operations (force with sequence=0xffff even if hasNewEvents is false)
    {
      let sequence = 0xffff;
      let retry = 0;
      // Cache-aware early exit: the 0xffff path streams the full history
      // newest→oldest. Without this guard the loop re-walked every record on
      // every call (~12 min for 3788 records) and the warm cache restored from
      // lockData.json was wasted because it is only consulted AFTER this loop.
      // Once a full page contains only records already cached, every older
      // record is cached too → stop. Require 2 consecutive fully-known pages
      // for robustness against any firmware reordering. On a cold cache no page
      // is ever fully known, so the full sweep still runs (unavoidable once).
      let knownPages = 0;
      do {
        log('========= get OperationLog', sequence);
        try {
          if (!this.isConnected()) {
            break;
          }
          const response = await this.getOperationLogCommand(sequence);
          sequence = response.sequence;
          let pageHadNew = false;
          for (let entry of response.data) {
            if (entry) {
              const cached = this.operationLog[entry.recordNumber];
              if (cached === undefined || cached == null) {
                pageHadNew = true;
              }
              newOperations.push(entry);
              this.operationLog[entry.recordNumber] = entry;
            }
          }
          retry = 0;
          if (!pageHadNew && response.data.length > 0) {
            if (++knownPages >= 2) {
              break;
            }
          } else {
            knownPages = 0;
          }
        } catch (error: any) {
          // Firmware sentinel "no more data" — exit the loop without burning retries
          if (error instanceof NoMoreOperationDataError) {
            break;
          }
          retry++;
        }
      } while (sequence > 0 && retry < maxRetry);
    }

    // if all operations were requested
    if (all) {
      // Budget for the probe + backfill phases below. Default generous (the manual
      // "reload everything" path legitimately takes minutes); hot paths pass their own.
      const deadline = Date.now() + (options.maxDurationMs ?? 5 * 60 * 1000);
      let operations = [];
      let maxRecordNumber = 0;
      if (noCache) {
        // if cache will not be used start with only the new operations
        for (let log of newOperations) {
          if (log) {
            operations[log.recordNumber] = log;
            if (log.recordNumber > maxRecordNumber) {
              maxRecordNumber = log.recordNumber;
            }
          }
        }
      } else {
        // otherwise copy current operation log
        for (let log of this.operationLog) {
          if (log) {
            operations[log.recordNumber] = log;
            if (log.recordNumber > maxRecordNumber) {
              maxRecordNumber = log.recordNumber;
            }
          }
        }
      }
      if (operations.length == 0) {
        // if no operations, start with 0 and keep going
        let sequence = 0;
        let failedSequences = 0;
        let retry = 0;
        let keepGoing = true;
        do {
          log('========= get OperationLog', sequence);
          try {
            const response = await this.getOperationLogCommand(sequence);
            const nextSeq = response.sequence;
            log('========= get OperationLog next seq', nextSeq);
            for (let entry of response.data) {
              operations[entry.recordNumber] = entry;
            }
            retry = 0;
            failedSequences = 0; // reset on success
            if (nextSeq <= 0) {
              keepGoing = false;
            } else {
              sequence = nextSeq;
            }
          } catch (error) {
            // Sentinel: skip this sequence immediately without retrying
            if (error instanceof NoMoreOperationDataError) {
              log('========= get OperationLog skip seq (sentinel)', sequence);
              sequence++;
              failedSequences++;
              retry = 0;
              // Stop after too many consecutive missing sequences
              if (failedSequences > 10) {
                keepGoing = false;
              }
              continue;
            }
            retry++;
            // some operations just can't be read
            if (retry >= maxRetry) {
              log('========= get OperationLog skip seq', sequence);
              sequence++;
              failedSequences++;
              retry = 0;
              if (failedSequences > 10) {
                keepGoing = false;
              }
            }
          }
        } while (keepGoing && retry < maxRetry);
      } else {
        // if we have operations, compute missing record numbers (cheap, no BLE).
        // Sequences already known to be absent from the firmware are skipped: they were
        // answered with the "no record" sentinel on an earlier call and the journal is
        // circular, so they will never come back.
        let missing = [];
        for (let i = 0; i < maxRecordNumber; i++) {
          if (this.missingSequences.has(i)) continue;
          if (operations[i] === undefined || operations[i] == null) {
            missing.push(i);
          }
        }

        // Probe beyond maxRecordNumber FIRST — before the potentially long
        // missing-gap backfill. New (appended) records are ONLY surfaced here:
        // the 0xffff Phase 1 does not return them (firmware behaviour). The
        // lock self-disconnects, and this loop is gated by this.isConnected(),
        // so it must run while the BLE link is freshest — otherwise the guard
        // skips it and every operation newer than the cached snapshot is
        // silently and permanently lost.
        //
        // Wrap-around: past the journal end, the firmware echoes an old
        // record (recordNumber <= maxRecordNumber, typically the init record
        // at recordNumber=1 with nextSeq=2). Treat those as "empty" so the
        // sweep can terminate.
        const probeMaxConsecutiveEmpty = options.maxProbeEmpty ?? 20;
        let probeSeq = maxRecordNumber + 1;
        let consecutiveEmpty = 0;
        while (consecutiveEmpty < probeMaxConsecutiveEmpty && this.isConnected() && Date.now() < deadline) {
          log('========= get OperationLog probe', probeSeq);
          let producedNewRecord = false;
          try {
            const response = await this.getOperationLogCommand(probeSeq);
            if (response.data && response.data.length > 0) {
              for (let entry of response.data) {
                if (entry && entry.recordNumber > maxRecordNumber) {
                  operations[entry.recordNumber] = entry;
                  producedNewRecord = true;
                }
              }
            }
          } catch (error) {
            // NoMoreOperationDataError or transient BLE error: treated as empty.
            if (!(error instanceof NoMoreOperationDataError)) {
              log('========= get OperationLog probe error', probeSeq, error);
            }
          }
          if (producedNewRecord) {
            consecutiveEmpty = 0;
          } else {
            consecutiveEmpty++;
          }
          probeSeq++;
        }

        // Backfill old gaps last (best-effort). Bounded three ways, because this loop
        // used to be the single most expensive thing the SDK could do: it walked every
        // missing sequence on every call, kept running after the lock had dropped the
        // link, and re-tried sequences the firmware had already declared non-existent.
        //  - skipBackfill: callers on a hot path opt out entirely;
        //  - isConnected(): a dead link ends the sweep instead of burning it out;
        //  - deadline: a live but slow link can't monopolise the session either.
        // Sequences the firmware answers with its "no record" sentinel are remembered in
        // missingSequences and never requested again — the journal is circular, so those
        // gaps are permanent.
        if (!options.skipBackfill) {
          for (let sequence of missing) {
            if (!this.isConnected() || Date.now() >= deadline) {
              log('========= get OperationLog backfill stopped', sequence);
              break;
            }
            let retry = 0;
            let success = false;
            do {
              log('========= get OperationLog', sequence);
              try {
                const response = await this.getOperationLogCommand(sequence);
                for (let log of response.data) {
                  operations[log.recordNumber] = log;
                }
                retry = 0;
                success = true;
              } catch (error) {
                // Sentinel: this record genuinely doesn't exist on the lock — give up on
                // it, now and for every future call. Capped so the persisted set stays
                // bounded on locks with a very long history; past the cap the backfill
                // simply degrades to its previous re-probing behaviour.
                if (error instanceof NoMoreOperationDataError) {
                  if (this.missingSequences.size < TTLock.MAX_MISSING_SEQUENCES) {
                    this.missingSequences.add(sequence);
                  }
                  break;
                }
                retry++;
              }
            } while (!success && retry < maxRetry);
          }
        }
      }

      // Only update the cached log if we actually got data — never overwrite with empty
      if (operations.length > 0) {
        this.operationLog = operations;
        this.emit('dataUpdated', this);
      } else {
        log.warn('getOperationLog: BLE fetch returned no records, keeping existing cache');
      }
      return this.operationLog.filter(Boolean) as LogEntry[];
    } else {
      if (newOperations.length > 0) {
        this.emit('dataUpdated', this);
      }
      return newOperations;
    }
  }

  /**
   * Probe a single operation log sequence directly, bypassing all cache logic.
   * Intended for debugging firmware behavior at specific sequence numbers.
   * Returns null if the lock is not connected or admin auth fails.
   * Returns { sequence, data } on success (data may be an empty array if the
   * firmware has no record at this sequence).
   */
  async probeOperationLog(sequence: number): Promise<{ sequence: number; data: LogEntry[] } | null> {
    if (!this.initialized || !this.isConnected()) {
      return null;
    }
    const adminOk = await this.macro_adminLogin();
    if (!adminOk) {
      return null;
    }
    try {
      const response = await this.getOperationLogCommand(sequence);
      return { sequence: response.sequence, data: response.data };
    } catch (error) {
      if (error instanceof NoMoreOperationDataError) {
        return { sequence: 0, data: [] };
      }
      throw error;
    }
  }

  private onDataReceived(command: CommandEnvelope) {
    // is this just a notification (like the lock was locked/unlocked etc.)
    if (this.privateData.aesKey) {
      command.setAesKey(this.privateData.aesKey);
      const data = command.getCommand().getRawData();
      log('Received:', command);
      if (data) {
        log('Data', data.toString('hex'));
      }
    } else {
      log.error('Unable to decrypt notification, no AES key');
    }
  }

  private async onConnected(): Promise<void> {
    // Values discovered below are cached in lockData so later connections can
    // skip the BLE round-trips entirely. Without this signal they would be
    // re-queried after every restart, since nothing else emits 'dataUpdated'
    // on this path.
    // Only consume the flag once there is somewhere to persist it: getLockData()
    // returns nothing for an unpaired lock, so consuming it there would drop the
    // cache for a lock paired later in this same session.
    let dataChanged = this.isPaired() ? this.device.consumeFreshBasicInfo() : false;
    if (this.isPaired() && !this.skipDataRead) {
      // read general data
      log('Connected to known lock, reading general data');
      try {
        if (this.featureList === undefined) {
          // Search device features
          log('========= feature list');
          this.featureList = await this.searchDeviceFeatureCommand();
          log('========= feature list', this.featureList);
          dataChanged = true;
        }

        // Auto lock time
        if (this.featureList.has(FeatureValue.AUTO_LOCK) && this.autoLockTime == -1 && (await this.macro_adminLogin())) {
          log('========= autoLockTime');
          this.autoLockTime = await this.searchAutoLockTimeCommand();
          log('========= autoLockTime:', this.autoLockTime);
          dataChanged = true;
        }

        if (this.lockedStatus == LockedStatus.UNKNOWN || this.statusUnverified) {
          // Locked/unlocked status
          log('========= check lock status');
          const oldStatus = this.lockedStatus;
          this.lockedStatus = await this.searchBycicleStatusCommand();
          this.statusUnverified = false;
          log('========= check lock status', this.lockedStatus);
          // Propagate a corrected status to event-based consumers: the advertising
          // path no longer asserts LOCKED, so a genuine re-lock is only discovered
          // by this active query and would otherwise never be signalled.
          if (oldStatus != this.lockedStatus) {
            this.emit(this.lockedStatus == LockedStatus.LOCKED ? 'locked' : 'unlocked', this);
          }
        }

        if (this.featureList.has(FeatureValue.AUDIO_MANAGEMENT) && this.lockSound == AudioManage.UNKNOWN) {
          log('========= lockSound');
          this.lockSound = await this.audioManageCommand();
          log('========= lockSound:', this.lockSound);
          dataChanged = true;
        }
      } catch (error) {
        log.error('Failed reading all general data from lock', error);
        // TODO: judge the error and fail connect
      }
    } else {
      if (this.device.isUnlock) {
        this.lockedStatus = LockedStatus.UNLOCKED;
      } else {
        this.lockedStatus = LockedStatus.LOCKED;
      }
    }

    // Emit before 'connected' so a consumer that persists on 'dataUpdated' has
    // the cache written by the time it starts issuing commands.
    if (dataChanged) {
      this.emit('dataUpdated', this);
    }

    // are we still connected ? It is possible the lock will disconnect while reading general data
    if (this.device.connected) {
      this.connected = true;
      this.emit('connected', this);
    }
  }

  private async onDisconnected(): Promise<void> {
    this.connected = false;
    this.adminAuth = false;
    this.connecting = false;
    if (this.autoLockTimer) {
      clearTimeout(this.autoLockTimer);
      this.autoLockTimer = undefined;
    }
    this.emit('disconnected', this);
  }

  private async onTTDeviceUpdated(): Promise<void> {
    this.updateFromTTDevice();
  }

  getLockData(): TTLockData | void {
    if (this.isPaired()) {
      const privateData: TTLockPrivateData = {
        aesKey: this.privateData.aesKey?.toString('hex'),
        admin: this.privateData.admin,
        adminPasscode: this.privateData.adminPasscode,
        pwdInfo: this.privateData.pwdInfo
      };
      const data: TTLockData = {
        address: this.device.address,
        battery: this.batteryCapacity,
        rssi: this.rssi,
        autoLockTime: this.autoLockTime ? this.autoLockTime : -1,
        lockedStatus: this.lockedStatus,
        privateData: privateData,
        operationLog: this.operationLog,
        missingSequences: Array.from(this.missingSequences),
        featureList: this.featureList ? Array.from(this.featureList) : undefined,
        lockSound: this.lockSound,
        deviceCache: this.device.getBasicInfoCache(),
        psPath: this.psPath
      };
      return data;
    }
  }

  /** Just for debugging */
  toJSON(asObject: boolean = false): string | Object {
    let json: Object = this.device.toJSON(true);

    if (this.featureList) Reflect.set(json, 'featureList', this.featureList);
    if (this.switchState) Reflect.set(json, 'switchState', this.switchState);
    if (this.lockSound) Reflect.set(json, 'lockSound', this.lockSound);
    if (this.displayPasscode) Reflect.set(json, 'displayPasscode', this.displayPasscode);
    if (this.autoLockTime) Reflect.set(json, 'autoLockTime', this.autoLockTime);
    if (this.lightingTime) Reflect.set(json, 'lightingTime', this.lightingTime);
    if (this.remoteUnlock) Reflect.set(json, 'remoteUnlock', this.remoteUnlock);
    if (this.deviceInfo) Reflect.set(json, 'deviceInfo', this.deviceInfo);
    const privateData: Object = {};
    if (this.privateData.aesKey) Reflect.set(privateData, 'aesKey', this.privateData.aesKey.toString('hex'));
    if (this.privateData.admin) Reflect.set(privateData, 'admin', this.privateData.admin);
    if (this.privateData.adminPasscode) Reflect.set(privateData, 'adminPasscode', this.privateData.adminPasscode);
    if (this.privateData.pwdInfo) Reflect.set(privateData, 'pwdInfo', this.privateData.pwdInfo);
    Reflect.set(json, 'privateData', privateData);
    if (this.operationLog) Reflect.set(json, 'operationLog', this.operationLog);

    if (asObject) {
      return json;
    } else {
      return JSON.stringify(json);
    }
  }
}
