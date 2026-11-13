import { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import { IntentOutcome, IntentRunner } from './intentRunner';
import { SubaruLinkPlatform } from './platform';
import { DiscoveredVehicle, formatLogError, sanitizeHapName } from './settings';

type LockIntent = 'lock' | 'unlock';
type EngineIntent = { kind: 'start'; preset: string } | { kind: 'stop' };

/** Momentary buttons flip back to Off after this delay. */
const MOMENTARY_RESET_MS = 1000;

/**
 * Queue priority per command (higher is sent first among waiting commands).
 * Remote start locks the car, so it must run before a queued unlock; otherwise
 * "start + unlock" would leave the car locked.
 */
const COMMAND_PRIORITY: Partial<Record<string, number>> = {
  remote_start: 10,
};

const DOOR_SENSOR_DEFS = [
  { key: 'front_left_door', label: 'Front Left Door' },
  { key: 'front_right_door', label: 'Front Right Door' },
  { key: 'rear_left_door', label: 'Rear Left Door' },
  { key: 'rear_right_door', label: 'Rear Right Door' },
  { key: 'boot', label: 'Trunk / Tailgate' },
  { key: 'hood', label: 'Engine Hood' },
] as const;

const WINDOW_SENSOR_LABELS: Record<string, string> = {
  front_left_window: 'Front Left Window',
  front_right_window: 'Front Right Window',
  rear_left_window: 'Rear Left Window',
  rear_right_window: 'Rear Right Window',
  sunroof: 'Sunroof',
};

/**
 * Represents a single Subaru vehicle in HomeKit with support for:
 * - Lock Doors / Unlock Doors buttons (`lock` / `unlock` with configurable door mode)
 * - Remote Start buttons, one per configured climate preset (`remote_start`)
 * - Stop Engine button (`remote_stop`)
 * - Optional Tailgate Unlock button (`unlock` with `TAILGATE_DOOR`)
 * - Optional Flash Lights Switch (`lights` / `lights_stop`)
 * - Optional Panic Horn Switch (`horn` / `horn_stop`)
 * - Optional Force Vehicle Wake & Poll button (`update` + `fetch`)
 * - Optional PHEV Charge Start button (`charge_start`)
 * - EV Battery Service (for Crosstrek PHEV / EV models)
 * - Door, Trunk, Hood & Power Window / Sunroof Contact Sensors
 * - Optional Exterior Temperature Sensor (if reported by vehicle/API in °C)
 *
 * Lock/unlock and engine start/stop are stateless momentary buttons: the plugin
 * does not track or display whether the car is locked or running (MySubaru's
 * cached status lags reality and showed "Locked" for unlocked cars). Pressing a
 * button fires the command in the background and the button flips back to Off.
 *
 * Every remote command is fire-and-forget: HomeKit `onSet` handlers return
 * immediately and the command runs in the background through an
 * {@link IntentRunner}, then the account-wide command queue. Repeated presses
 * while a command is in flight are dropped, so a slow MySubaru round trip can
 * never turn into duplicate commands.
 */
export class SubaruVehicleAccessory {
  private lockButton?: Service;
  private unlockButton?: Service;
  private stopEngineButton?: Service;
  private startButtons = new Map<string, Service>();
  private tailgateSwitch?: Service;
  private lightsSwitch?: Service;
  private hornSwitch?: Service;
  private locateSwitch?: Service;
  private evChargeSwitch?: Service;
  private evBatteryService?: Service;
  private tempSensorService?: Service;
  private contactSensors = new Map<string, Service>();

  // Command runners (in-flight tracking only; no vehicle lock/engine state is kept)
  private readonly lockRunner: IntentRunner<LockIntent>;
  private readonly engineRunner: IntentRunner<EngineIntent>;
  private readonly lightsRunner: IntentRunner<boolean>;
  private readonly hornRunner: IntentRunner<boolean>;
  private readonly tailgateRunner: IntentRunner<true>;
  private readonly evChargeRunner: IntentRunner<true>;
  private readonly wakeRunner: IntentRunner<true>;
  private lightsTimer?: NodeJS.Timeout;
  private lightsActive = false;
  private hornActive = false;
  private isRefreshing = false;
  private consecutiveRefreshFailures = 0;

  constructor(
    private readonly platform: SubaruLinkPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly vehicle: DiscoveredVehicle,
  ) {
    const { Service, Characteristic } = this.platform;

    const onCallbackError = (err: unknown) =>
      this.platform.log.error(`[${this.vehicle.name}] Internal state update failed: ${formatLogError(err)}`);

    this.lockRunner = new IntentRunner<LockIntent>({
      execute: (intent) =>
        intent === 'lock'
          ? this.sendSimpleCommand('lock')
          : this.sendSimpleCommand('unlock', { door: this.unlockMode() }),
      onSuccess: (intent) =>
        this.platform.log.info(
          intent === 'lock'
            ? `[${this.vehicle.name}] Vehicle locked.`
            : `[${this.vehicle.name}] Vehicle unlocked (${this.unlockMode()}).`,
        ),
      onFailure: (intent, err) =>
        this.platform.log.error(
          `[${this.vehicle.name}] ${intent === 'lock' ? 'Lock' : 'Unlock'} command failed: ${formatLogError(err)}`,
        ),
      onCallbackError,
    });
    this.engineRunner = new IntentRunner<EngineIntent>({
      execute: (intent) =>
        intent.kind === 'start'
          ? this.sendSimpleCommand('remote_start', { preset: intent.preset })
          : this.sendSimpleCommand('remote_stop'),
      onSuccess: (intent) =>
        this.platform.log.info(
          intent.kind === 'start'
            ? `[${this.vehicle.name}] Remote start (${intent.preset}) confirmed.`
            : `[${this.vehicle.name}] Engine stopped.`,
        ),
      onFailure: (intent, err) =>
        this.platform.log.error(
          `[${this.vehicle.name}] ${intent.kind === 'start' ? `Remote start (${intent.preset})` : 'Remote stop'} failed: ${formatLogError(err)}`,
        ),
      isSame: (a, b) =>
        a.kind === b.kind && (a.kind === 'stop' || a.preset === (b as { preset: string }).preset),
      onCallbackError,
    });
    this.lightsRunner = new IntentRunner<boolean>({
      execute: (on) => this.sendSimpleCommand(on ? 'lights' : 'lights_stop'),
      onSuccess: (on) => this.onLightsSucceeded(on),
      onFailure: (on, err) => {
        this.platform.log.error(
          `[${this.vehicle.name}] ${on ? 'lights' : 'lights_stop'} command failed: ${formatLogError(err)}`,
        );
        this.lightsSwitch?.updateCharacteristic(Characteristic.On, this.lightsDisplayState());
      },
      onCallbackError,
    });
    this.hornRunner = new IntentRunner<boolean>({
      execute: (on) => this.sendSimpleCommand(on ? 'horn' : 'horn_stop'),
      onSuccess: (on) => {
        this.hornActive = on;
        this.platform.log.info(`[${this.vehicle.name}] Horn ${on ? 'started' : 'stopped'}.`);
        this.hornSwitch?.updateCharacteristic(Characteristic.On, this.hornDisplayState());
      },
      onFailure: (on, err) => {
        this.platform.log.error(
          `[${this.vehicle.name}] ${on ? 'horn' : 'horn_stop'} command failed: ${formatLogError(err)}`,
        );
        this.hornSwitch?.updateCharacteristic(Characteristic.On, this.hornDisplayState());
      },
      onCallbackError,
    });
    this.tailgateRunner = new IntentRunner<true>({
      execute: () => this.sendSimpleCommand('unlock', { door: 'TAILGATE_DOOR' }),
      onSuccess: () => this.platform.log.info(`[${this.vehicle.name}] Tailgate unlocked.`),
      onFailure: (_i, err) =>
        this.platform.log.error(`[${this.vehicle.name}] Tailgate unlock failed: ${formatLogError(err)}`),
      onCallbackError,
    });
    this.evChargeRunner = new IntentRunner<true>({
      execute: () => this.sendSimpleCommand('charge_start'),
      onSuccess: () => this.platform.log.info(`[${this.vehicle.name}] EV charging started.`),
      onFailure: (_i, err) =>
        this.platform.log.error(`[${this.vehicle.name}] EV charge_start failed: ${formatLogError(err)}`),
      onCallbackError,
    });
    this.wakeRunner = new IntentRunner<true>({
      // Waking the car is a remote command too, so it waits its turn in the queue.
      // refreshTelemetry logs its own failures and never throws.
      execute: () =>
        this.platform.commandQueue.run(`[${this.vehicle.name}] vehicle wake/poll`, () =>
          this.refreshTelemetry({ wake: true, force: true }),
        ),
      onSuccess: () => undefined,
      onFailure: () => undefined,
      onCallbackError,
    });

    // 1. Accessory Information
    this.accessory
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Name, sanitizeHapName(this.vehicle.name, 'Subaru'))
      .setCharacteristic(Characteristic.Manufacturer, 'Subaru')
      .setCharacteristic(
        Characteristic.Model,
        `${this.vehicle.model_year} ${this.vehicle.model_name}`,
      )
      .setCharacteristic(Characteristic.SerialNumber, this.vehicle.vin)
      .setCharacteristic(Characteristic.FirmwareRevision, this.vehicle.api_gen);

    // 2. Lock / Unlock buttons (stateless). The old stateful LockMechanism is removed:
    //    MySubaru's cached lock status lags reality, so HomeKit showed wrong lock states.
    for (const svc of [...this.accessory.services]) {
      if (svc.UUID === Service.LockMechanism.UUID) {
        this.accessory.removeService(svc);
      }
    }
    if (this.vehicle.has_remote) {
      this.lockButton = this.getOrAddService(Service.Switch, `${this.vehicle.name} Lock Doors`, 'button-lock');
      this.lockButton
        .getCharacteristic(Characteristic.On)
        .onGet(() => false)
        .onSet((val) => this.pressButton(val, this.lockButton, 'lock', () => this.lockRunner.request('lock')));

      this.unlockButton = this.getOrAddService(
        Service.Switch,
        `${this.vehicle.name} Unlock Doors`,
        'button-unlock',
      );
      this.unlockButton
        .getCharacteristic(Characteristic.On)
        .onGet(() => false)
        .onSet((val) =>
          this.pressButton(val, this.unlockButton, 'unlock', () => this.lockRunner.request('unlock')),
        );
    } else {
      this.removeServiceIfPresent(Service.Switch, 'button-lock');
      this.removeServiceIfPresent(Service.Switch, 'button-unlock');
    }

    // 3. Remote Start buttons (one per climate preset) + Stop Engine button (if vehicle has RES or is EV)
    const activePresetSubtypes = new Set<string>();
    if (this.vehicle.has_res || this.vehicle.is_ev) {
      const defaultPreset = (this.platform.config.defaultPreset || 'Full Heat').trim() || 'Full Heat';
      const primaryName = sanitizeHapName(`${this.vehicle.name} Remote Start - ${defaultPreset}`);
      activePresetSubtypes.add('remote-start-primary');

      const primary = this.getOrAddService(Service.Switch, primaryName, 'remote-start-primary');
      primary
        .getCharacteristic(Characteristic.On)
        .onGet(() => false)
        .onSet((val) => this.pressStart(val, primary, defaultPreset));
      this.startButtons.set(defaultPreset, primary);

      this.stopEngineButton = this.getOrAddService(
        Service.Switch,
        `${this.vehicle.name} Stop Engine`,
        'button-remote-stop',
      );
      this.stopEngineButton
        .getCharacteristic(Characteristic.On)
        .onGet(() => false)
        .onSet((val) =>
          this.pressButton(val, this.stopEngineButton, 'remote stop', () =>
            this.engineRunner.request({ kind: 'stop' }),
          ),
        );

      // Additional Preset Switches
      const extraPresets = this.platform.config.additionalPresets || [];
      for (const preset of extraPresets) {
        const cleanPreset = preset.trim();
        if (!cleanPreset || cleanPreset.toLowerCase() === defaultPreset.toLowerCase()) {
          continue;
        }
        const slug = cleanPreset
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '');
        if (!slug || slug === 'primary') {
          continue;
        }
        const subType = `remote-start-${slug}`;
        if (activePresetSubtypes.has(subType)) {
          continue;
        }
        activePresetSubtypes.add(subType);

        const switchName = sanitizeHapName(`${this.vehicle.name} Start - ${cleanPreset}`);
        const svc = this.getOrAddService(Service.Switch, switchName, subType);
        svc
          .getCharacteristic(Characteristic.On)
          .onGet(() => false)
          .onSet((val) => this.pressStart(val, svc, cleanPreset));

        this.startButtons.set(cleanPreset, svc);
      }
    } else {
      this.removeServiceIfPresent(Service.Switch, 'button-remote-stop');
    }

    // Prune any stale cached remote-start switches no longer configured
    for (const svc of [...this.accessory.services]) {
      if (
        svc.UUID === Service.Switch.UUID &&
        svc.subtype?.startsWith('remote-start-') &&
        !activePresetSubtypes.has(svc.subtype)
      ) {
        this.accessory.removeService(svc);
      }
    }

    // 4. Optional Tailgate Unlock Momentary Switch
    if (this.vehicle.has_remote && this.platform.config.exposeTailgateUnlockSwitch) {
      const name = `${this.vehicle.name} Unlock Tailgate`;
      this.tailgateSwitch = this.getOrAddService(Service.Switch, name, 'unlock-tailgate');
      this.tailgateSwitch
        .getCharacteristic(Characteristic.On)
        .onGet(() => false)
        .onSet(this.handleTailgateUnlock.bind(this));
    } else {
      this.removeServiceIfPresent(Service.Switch, 'unlock-tailgate');
    }

    // 5. Optional Hazard Lights Switch
    if (this.vehicle.has_remote && (this.platform.config.exposeLightsSwitch ?? true)) {
      const name = `${this.vehicle.name} Flash Lights`;
      this.lightsSwitch = this.getOrAddService(Service.Switch, name, 'flash-lights');
      this.lightsSwitch
        .getCharacteristic(Characteristic.On)
        .onGet(() => this.lightsDisplayState())
        .onSet(this.handleLightsSet.bind(this));
    } else {
      this.removeServiceIfPresent(Service.Switch, 'flash-lights');
    }

    // 6. Optional Panic Horn Switch
    if (this.vehicle.has_remote && this.platform.config.exposeHornSwitch) {
      const name = `${this.vehicle.name} Horn`;
      this.hornSwitch = this.getOrAddService(Service.Switch, name, 'panic-horn');
      this.hornSwitch
        .getCharacteristic(Characteristic.On)
        .onGet(() => this.hornDisplayState())
        .onSet(this.handleHornSet.bind(this));
    } else {
      this.removeServiceIfPresent(Service.Switch, 'panic-horn');
    }

    // 7. Optional Force Wake / Poll Switch (`Controller.update`)
    if (this.vehicle.has_remote && (this.platform.config.exposeLocateSwitch ?? true)) {
      const name = `${this.vehicle.name} Refresh Vehicle Status`;
      this.locateSwitch = this.getOrAddService(Service.Switch, name, 'force-wake-poll');
      this.locateSwitch
        .getCharacteristic(Characteristic.On)
        .onGet(() => false)
        .onSet(this.handleForceWakePoll.bind(this));
    } else {
      this.removeServiceIfPresent(Service.Switch, 'force-wake-poll');
    }

    // 8. PHEV / EV Charge Start Switch & Battery Level Service
    if (this.vehicle.is_ev) {
      const chargeName = `${this.vehicle.name} EV Charge`;
      this.evChargeSwitch = this.getOrAddService(Service.Switch, chargeName, 'ev-charge-start');
      this.evChargeSwitch
        .getCharacteristic(Characteristic.On)
        .onGet(() => false)
        .onSet(this.handleEvChargeStart.bind(this));

      const batName = `${this.vehicle.name} EV Battery`;
      this.evBatteryService = this.getOrAddService(Service.Battery, batName, 'ev-battery');
    } else {
      this.removeServiceIfPresent(Service.Switch, 'ev-charge-start');
      this.removeServiceIfPresent(Service.Battery, 'ev-battery');
    }

    // 9. Door, Boot, Hood & Window Contact Sensors
    if (this.platform.config.exposeDoorWindowSensors ?? true) {
      for (const def of DOOR_SENSOR_DEFS) {
        const subType = `sensor-${def.key}`;
        const sensorName = `${this.vehicle.name} ${def.label}`;
        const svc = this.getOrAddService(Service.ContactSensor, sensorName, subType);
        this.contactSensors.set(def.key, svc);
      }
      // Restore any cached dynamic window/sunroof contact sensors
      for (const [winKey, label] of Object.entries(WINDOW_SENSOR_LABELS)) {
        const subType = `sensor-${winKey}`;
        const existingWin = this.accessory.getServiceById(Service.ContactSensor, subType);
        if (existingWin) {
          this.configureServiceName(existingWin, `${this.vehicle.name} ${label}`);
          this.contactSensors.set(winKey, existingWin);
        }
      }
    } else {
      for (const svc of [...this.accessory.services]) {
        if (svc.UUID === Service.ContactSensor.UUID && svc.subtype?.startsWith('sensor-')) {
          this.accessory.removeService(svc);
        }
      }
    }

    // Restore cached Exterior Temperature Sensor if present
    const existingTemp = this.accessory.getServiceById(Service.TemperatureSensor, 'ext-temp');
    if (existingTemp) {
      this.configureServiceName(existingTemp, `${this.vehicle.name} Exterior Temp`);
      this.tempSensorService = existingTemp;
    }
  }

  public dispose(): void {
    if (this.lightsTimer) {
      clearTimeout(this.lightsTimer);
      this.lightsTimer = undefined;
    }
  }

  private getOrAddService(serviceClass: any, displayName: string, subType: string): Service {
    const safeName = sanitizeHapName(displayName);
    const svc =
      this.accessory.getServiceById(serviceClass, subType) ||
      this.accessory.addService(serviceClass, safeName, subType);
    this.configureServiceName(svc, safeName);
    return svc;
  }

  private configureServiceName(service: Service, displayName: string): void {
    const { Characteristic } = this.platform;
    const safeName = sanitizeHapName(displayName);
    service.setCharacteristic(Characteristic.Name, safeName);
    if (!service.testCharacteristic(Characteristic.ConfiguredName)) {
      service.addOptionalCharacteristic(Characteristic.ConfiguredName);
    }
    service.setCharacteristic(Characteristic.ConfiguredName, safeName);
  }

  private removeServiceIfPresent(serviceType: any, subType: string): void {
    const existing = this.accessory.getServiceById(serviceType, subType);
    if (existing) {
      this.accessory.removeService(existing);
    }
  }

  /**
   * Sends the command through the account-wide queue (one MySubaru command at a
   * time, with a pause between them); throws if MySubaru did not confirm it.
   */
  private async sendSimpleCommand(
    command: Parameters<SubaruLinkPlatform['bridge']['executeCommand']>[1],
    args: Record<string, unknown> = {},
  ): Promise<void> {
    const label = `[${this.vehicle.name}] ${command}`;
    const ok = await this.platform.commandQueue.run(
      label,
      () => {
        this.platform.log.info(`[${this.vehicle.name}] Sending ${command} command...`);
        return this.platform.bridge.executeCommand(this.vehicle.vin, command, args);
      },
      { priority: COMMAND_PRIORITY[command] ?? 0 },
    );
    if (!ok) {
      throw new Error(`MySubaru did not confirm the ${command} command`);
    }
  }

  private logOutcome(outcome: IntentOutcome, label: string): void {
    if (outcome === 'duplicate') {
      this.platform.log.info(
        `[${this.vehicle.name}] Ignoring repeated ${label} request; one is already in progress.`,
      );
    } else if (outcome === 'queued') {
      this.platform.log.info(
        `[${this.vehicle.name}] ${label} queued; it will run when the current command finishes.`,
      );
    }
  }

  private unlockMode(): string {
    return this.platform.config.unlockMode || 'ALL_DOORS';
  }

  // ---- Momentary buttons ---------------------------------------------------

  /**
   * HomeKit write handler for a momentary button: on press, requests the command
   * (which runs in the background) and flips the button back to Off. Turning a
   * button Off does nothing. Never awaits MySubaru.
   */
  private pressButton(
    value: CharacteristicValue,
    service: Service | undefined,
    label: string,
    request: () => IntentOutcome,
  ): void {
    if (!value) {
      return;
    }
    this.logOutcome(request(), label);
    const t = setTimeout(() => {
      service?.updateCharacteristic(this.platform.Characteristic.On, false);
    }, MOMENTARY_RESET_MS);
    t.unref?.();
  }

  private pressStart(value: CharacteristicValue, service: Service, preset: string): void {
    this.pressButton(value, service, `remote start (${preset})`, () =>
      this.engineRunner.request({ kind: 'start', preset }),
    );
  }

  private handleTailgateUnlock(value: CharacteristicValue): void {
    this.pressButton(value, this.tailgateSwitch, 'tailgate unlock', () => this.tailgateRunner.request(true));
  }

  private handleForceWakePoll(value: CharacteristicValue): void {
    if (value) {
      this.platform.log.info(
        `[${this.vehicle.name}] Waking vehicle telematics module (Controller.update) to pull fresh sensor status...`,
      );
    }
    this.pressButton(value, this.locateSwitch, 'vehicle wake/poll', () => this.wakeRunner.request(true));
  }

  private handleEvChargeStart(value: CharacteristicValue): void {
    this.pressButton(value, this.evChargeSwitch, 'EV charge start', () => this.evChargeRunner.request(true));
  }

  // ---- Lights & horn -----------------------------------------------------

  private handleLightsSet(value: CharacteristicValue): void {
    const on = Boolean(value);
    this.logOutcome(this.lightsRunner.request(on), on ? 'flash lights' : 'stop lights');
  }

  private lightsDisplayState(): boolean {
    return this.lightsRunner.latest ?? this.lightsActive;
  }

  private onLightsSucceeded(on: boolean): void {
    this.lightsActive = on;
    if (this.lightsTimer) {
      clearTimeout(this.lightsTimer);
      this.lightsTimer = undefined;
    }
    if (on) {
      this.lightsTimer = setTimeout(() => {
        this.lightsActive = false;
        this.lightsSwitch?.updateCharacteristic(this.platform.Characteristic.On, this.lightsDisplayState());
      }, 15000);
      this.lightsTimer.unref?.();
    }
    this.platform.log.info(`[${this.vehicle.name}] Lights ${on ? 'flashing' : 'stopped'}.`);
    this.lightsSwitch?.updateCharacteristic(this.platform.Characteristic.On, this.lightsDisplayState());
  }

  private handleHornSet(value: CharacteristicValue): void {
    const on = Boolean(value);
    this.logOutcome(this.hornRunner.request(on), on ? 'horn' : 'stop horn');
  }

  private hornDisplayState(): boolean {
    return this.hornRunner.latest ?? this.hornActive;
  }

  public async refreshTelemetry(options: { wake?: boolean; force?: boolean } = {}): Promise<void> {
    if (
      !options.wake &&
      !options.force &&
      (this.platform.commandQueue.busy || this.platform.bridge.hasActiveCommand())
    ) {
      this.platform.log.debug(
        `[${this.vehicle.name}] Deferring background cache poll while a remote command is in flight.`,
      );
      return;
    }
    if (this.isRefreshing && !options.wake) {
      this.platform.log.debug(
        `[${this.vehicle.name}] Telemetry refresh already in progress; skipping duplicate poll.`,
      );
      return;
    }

    this.isRefreshing = true;
    try {
      const telemetry = await this.platform.bridge.getTelemetry(this.vehicle.vin, options);
      const { Characteristic, Service } = this.platform;

      // 1. Update Door, Boot & Hood Contact Sensors (ignore UNKNOWN / NOT_EQUIPPED)
      if (this.platform.config.exposeDoorWindowSensors ?? true) {
        for (const def of DOOR_SENSOR_DEFS) {
          const svc = this.contactSensors.get(def.key);
          const doorStatus = telemetry.doors?.[def.key]?.toUpperCase();
          if (!svc || !doorStatus) {
            continue;
          }
          if (doorStatus === 'OPEN') {
            svc.updateCharacteristic(
              Characteristic.ContactSensorState,
              Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
            );
          } else if (doorStatus === 'CLOSED' || doorStatus === 'CLOSE') {
            svc.updateCharacteristic(
              Characteristic.ContactSensorState,
              Characteristic.ContactSensorState.CONTACT_DETECTED,
            );
          }
        }

        // 2. Dynamically create/update Power Window & Sunroof Contact Sensors when reported
        for (const [winKey, label] of Object.entries(WINDOW_SENSOR_LABELS)) {
          const winStatus = telemetry.windows?.[winKey]?.toUpperCase();
          if (!winStatus) {
            continue;
          }
          let svc = this.contactSensors.get(winKey);
          if (!svc) {
            const subType = `sensor-${winKey}`;
            const sensorName = `${this.vehicle.name} ${label}`;
            svc = this.getOrAddService(Service.ContactSensor, sensorName, subType);
            this.contactSensors.set(winKey, svc);
          }
          const isClosed = winStatus === 'CLOSE' || winStatus === 'CLOSED';
          svc.updateCharacteristic(
            Characteristic.ContactSensorState,
            isClosed
              ? Characteristic.ContactSensorState.CONTACT_DETECTED
              : Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
          );
        }
      }

      // (Lock status is intentionally not shown: MySubaru's cached value lags reality.)

      // 3. Update Exterior Temperature Sensor if reported (strictly °C within HAP bounds [-270, 100])
      if (typeof telemetry.external_temp === 'number' && Number.isFinite(telemetry.external_temp)) {
        const clampedTempC = Math.max(-270, Math.min(100, telemetry.external_temp));
        if (!this.tempSensorService) {
          const tempName = `${this.vehicle.name} Exterior Temp`;
          this.tempSensorService = this.getOrAddService(
            Service.TemperatureSensor,
            tempName,
            'ext-temp',
          );
        }
        this.tempSensorService.updateCharacteristic(
          Characteristic.CurrentTemperature,
          clampedTempC,
        );
      }

      // 5. Update EV Battery Service if vehicle is EV/PHEV
      if (
        this.evBatteryService &&
        typeof telemetry.ev_charge_percent === 'number' &&
        Number.isFinite(telemetry.ev_charge_percent)
      ) {
        const level = Math.max(0, Math.min(100, Math.round(telemetry.ev_charge_percent)));
        this.evBatteryService.updateCharacteristic(Characteristic.BatteryLevel, level);
        this.evBatteryService.updateCharacteristic(
          Characteristic.StatusLowBattery,
          level < 20
            ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
            : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
        );
        const isCharging =
          String(telemetry.ev_charger_state || '').toUpperCase() === 'CHARGING';
        this.evBatteryService.updateCharacteristic(
          Characteristic.ChargingState,
          isCharging
            ? Characteristic.ChargingState.CHARGING
            : Characteristic.ChargingState.NOT_CHARGING,
        );
      }

      if (this.consecutiveRefreshFailures >= 3) {
        this.platform.log.info(
          `[${this.vehicle.name}] MySubaru telemetry connection recovered.`,
        );
      }
      this.consecutiveRefreshFailures = 0;

      this.platform.log.debug(
        `[${this.vehicle.name}] Telemetry refreshed (odometer=${telemetry.odometer ?? 'N/A'}, state=${telemetry.vehicle_state ?? 'N/A'})`,
      );
    } catch (err: any) {
      this.consecutiveRefreshFailures++;
      const conciseErr = formatLogError(err);
      if (options.wake || this.consecutiveRefreshFailures === 3) {
        this.platform.log.warn(
          `[${this.vehicle.name}] Could not refresh vehicle telemetry: ${conciseErr}`,
        );
      } else {
        this.platform.log.debug(
          `[${this.vehicle.name}] Transient telemetry refresh failure (${this.consecutiveRefreshFailures}): ${conciseErr}`,
        );
      }
    } finally {
      this.isRefreshing = false;
    }
  }
}
