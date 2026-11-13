#!/usr/bin/env node
/**
 * Comprehensive End-to-End Local & Mocked Verification Suite for homebridge-subarulink.
 *
 * Tests:
 * 1. Real `.runtime/venv/bin/python` + `subarulink>=0.7.21` API signature & constant audit.
 * 2. Real `python/subaru_bridge.py` JSON-RPC framing, malformed payload handling, error reporting, and shutdown.
 * 3. Full `SubaruPythonBridge` <-> `subaru_bridge.py` integration using a realistic MockController:
 *    - CLI-compatible `subarulink.cfg` generation (`0600`, `default_vin`, `save_creds`, `remote_start_preset`)
 *    - 2FA workflows (`2fa_required`, case-insensitive `2fa_code_sent`, `two_factor_code` auto-submit)
 *    - `VehicleInfo["vehicle_status"]` extraction (doors, windows, locks, 0-value edge cases, °F -> °C fallback)
 *    - Remote commands (`lock`, `unlock` door modes, case-insensitive `remote_start` preset, `remote_stop`)
 *    - Concurrent non-blocking RPC execution (urgent `lock` finishes while slow `get_telemetry` is running)
 *    - Automatic daemon SIGKILL crash recovery (respawn + automatic re-`init` before next command)
 * 4. Homebridge v2.4.0 API registration & cached `PlatformAccessory` restart resilience
 *    (verifies zero duplicate UUID/subtype errors and stale service pruning).
 * 5. Stateless lock / unlock / start / stop buttons: presses return immediately, repeated presses
 *    while a command is in flight send nothing extra, queued opposite requests run in order,
 *    buttons never report a state and flip back to Off on their own.
 * 6. Account-wide command queue: simultaneous commands (e.g. start + unlock from one automation)
 *    reach MySubaru one at a time with `commandGapSeconds` between them; failures do not block.
 * 7. Remote start priority: fired together with an unlock (in either order), remote start is sent
 *    first because it locks the car.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const VENV_PYTHON = path.join(PLUGIN_ROOT, '.runtime', 'venv', 'bin', 'python');
const BRIDGE_SCRIPT = path.join(PLUGIN_ROOT, 'python', 'subaru_bridge.py');

const require = createRequire(import.meta.url);
const { SubaruPythonBridge } = require(path.join(PLUGIN_ROOT, 'dist', 'pythonBridge.js'));
const { SubaruLinkPlatform } = require(path.join(PLUGIN_ROOT, 'dist', 'platform.js'));
const { SubaruVehicleAccessory } = require(path.join(PLUGIN_ROOT, 'dist', 'platformAccessory.js'));
const { formatLogError } = require(path.join(PLUGIN_ROOT, 'dist', 'settings.js'));
const pluginEntry = require(path.join(PLUGIN_ROOT, 'dist', 'index.js'));
const hbDistDir = path.dirname(require.resolve('homebridge'));
const { HomebridgeAPI } = require(path.join(hbDistDir, 'api.js'));

function createSilentLogger() {
  const logs = [];
  const push = (level) => (...args) => {
    logs.push({ level, msg: args.map(String).join(' ') });
  };
  const logger = Object.assign(push('info'), {
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    debug: push('debug'),
    success: push('info'),
    log: push('info'),
    logs,
  });
  return logger;
}

async function testUpstreamPackageSignatures() {
  console.log('1. Verifying isolated Python (>=3.14) & subarulink (>=0.7.21) upstream signatures...');
  assert.ok(fs.existsSync(VENV_PYTHON), `Missing venv python at ${VENV_PYTHON}`);

  const auditJson = execFileSync(
    VENV_PYTHON,
    [
      '-c',
      `
import inspect, json, sys, subarulink, subarulink.const as sc
from subarulink import Controller, controller

info = {
    "python_version": list(sys.version_info[:3]),
    "subarulink_version": subarulink.__version__,
    "init_params": list(inspect.signature(Controller.__init__).parameters.keys()),
    "unlock_params": list(inspect.signature(Controller.unlock).parameters.keys()),
    "remote_start_params": list(inspect.signature(Controller.remote_start).parameters.keys()),
    "vehicle_info_keys": list(controller.VehicleInfo.__annotations__.keys()),
    "vehicle_status_const": sc.VEHICLE_STATUS,
    "doors": {
        "fl": sc.DOOR_FRONT_LEFT_POSITION,
        "fr": sc.DOOR_FRONT_RIGHT_POSITION,
        "rl": sc.DOOR_REAR_LEFT_POSITION,
        "rr": sc.DOOR_REAR_RIGHT_POSITION,
        "boot": sc.DOOR_BOOT_POSITION,
        "hood": sc.DOOR_ENGINE_HOOD_POSITION,
    },
    "unlock_consts": {
        "all": sc.ALL_DOORS,
        "drivers": sc.DRIVERS_DOOR,
        "tailgate": sc.TAILGATE_DOOR,
    },
}
print(json.dumps(info))
`,
    ],
    { encoding: 'utf8' },
  ).trim();

  const audit = JSON.parse(auditJson);
  assert.ok(
    audit.python_version[0] > 3 || (audit.python_version[0] === 3 && audit.python_version[1] >= 14),
    `Expected Python >= 3.14, got ${audit.python_version.join('.')}`,
  );
  assert.deepEqual(audit.init_params, [
    'self',
    'websession',
    'username',
    'password',
    'device_id',
    'pin',
    'device_name',
    'country',
    'update_interval',
    'fetch_interval',
  ]);
  assert.deepEqual(audit.unlock_params, ['self', 'vin', 'door']);
  assert.deepEqual(audit.remote_start_params, ['self', 'vin', 'preset_name']);
  assert.equal(audit.vehicle_status_const, 'vehicle_status');
  assert.ok(audit.vehicle_info_keys.includes('vehicle_status'));
  // The Python daemon's error sanitizer must redact VINs before anything reaches stderr/Homebridge logs.
  const redactionJson = execFileSync(
    VENV_PYTHON,
    [
      '-c',
      `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(PLUGIN_ROOT, 'python'))})
import subaru_bridge as b
print(json.dumps({
    "vin": b._sanitize_error_message("Invalid VIN: JF2BTANC0R0000001 RequestInfo(url=URL('https://x/g2v33/selectVehicle.json?vin=jf2btanc0r0000001'))"),
    "plain": b._sanitize_error_message("took 12345678901234567 ms"),
}))
`,
    ],
    { encoding: 'utf8' },
  ).trim();
  const redaction = JSON.parse(redactionJson);
  assert.ok(!/JF2BTANC0R0000001/i.test(redaction.vin), `VIN leaked from Python sanitizer: ${redaction.vin}`);
  assert.ok(redaction.vin.includes('[VIN]'), 'Python sanitizer should replace VINs with [VIN]');
  assert.equal(redaction.plain, 'took 12345678901234567 ms', 'All-digit numbers are not mistaken for VINs');

  console.log(
    `   ✓ Verified Python ${audit.python_version.join('.')} + subarulink v${audit.subarulink_version} API signatures & constants`,
  );
}

async function testRawJsonRpcFramingAndErrors() {
  console.log('2. Testing raw JSON-RPC framing, error handling, and clean shutdown...');
  const proc = spawn(VENV_PYTHON, ['-u', BRIDGE_SCRIPT], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const responses = [];
  let buf = '';
  let waiter = null;

  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) {
        responses.push(JSON.parse(line));
        if (waiter) waiter();
      }
    }
  });

  const waitForCount = (n) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`Timed out waiting for ${n} responses`)), 5000);
      const check = () => {
        if (responses.length >= n) {
          clearTimeout(t);
          waiter = null;
          resolve();
        }
      };
      waiter = check;
      check();
    });

  // Malformed JSON, unknown method, uninitialized controller, then shutdown
  proc.stdin.write('not-valid-json\n');
  proc.stdin.write(JSON.stringify({ id: 10, method: 'non_existent_method', params: {} }) + '\n');
  proc.stdin.write(JSON.stringify({ id: 11, method: 'discover_vehicles', params: {} }) + '\n');
  await waitForCount(3);

  const errParse = responses.find((r) => r.id === null);
  assert.ok(errParse?.error?.includes('JSONDecodeError'), 'Expected JSONDecodeError on invalid JSON');

  const errUnknown = responses.find((r) => r.id === 10);
  assert.ok(errUnknown?.error?.includes('Unknown RPC method'));

  const errUninit = responses.find((r) => r.id === 11);
  assert.ok(errUninit?.error?.includes('Controller not initialized'));

  proc.stdin.write(JSON.stringify({ id: 12, method: 'shutdown', params: {} }) + '\n');
  await waitForCount(4);
  const resShutdown = responses.find((r) => r.id === 12);
  assert.deepEqual(resShutdown.result, { shutdown: true });

  const exitCode = await new Promise((resolve) => proc.on('exit', (code) => resolve(code)));
  assert.equal(exitCode, 0, 'Expected clean exit code 0 after shutdown RPC');
  console.log('   ✓ Raw JSON-RPC framing, error responses, and clean shutdown passed');
}

function writeMockSitecustomize(dirPath, stateLogPath) {
  const code = `
import asyncio
import datetime
import json
import os
import subarulink
import subarulink.const as sc

LOG_FILE = ${JSON.stringify(stateLogPath)}

def _record(event):
    items = []
    if os.path.exists(LOG_FILE):
        with open(LOG_FILE, "r", encoding="utf-8") as f:
            items = json.load(f)
    items.append(event)
    with open(LOG_FILE, "w", encoding="utf-8") as f:
        json.dump(items, f)

class MockController:
    def __init__(self, websession, username, password, device_id, pin, device_name, country="USA", update_interval=7200, fetch_interval=300):
        self._pin = pin
        self._pin_invalid = False
        self._expired_simulated = False
        self.device_registered = (username != "needs2fa@example.com")
        self.contact_methods = {"userName": "u***@example.com", "phone": "***-***-1234"}
        _record({"type": "init", "username": username, "device_id": device_id, "pid": os.getpid()})

    async def connect(self):
        _record({"type": "connect"})
        return True

    async def request_auth_code(self, method):
        _record({"type": "request_2fa", "method": method})
        return method in self.contact_methods

    async def submit_auth_code(self, code):
        _record({"type": "submit_2fa", "code": code})
        if code == "654321":
            self.device_registered = True
            return True
        return False

    def get_vehicles(self):
        return ["JF2BTANC0R0000001", "JF2GTAPC0P0000002"]

    def vin_to_name(self, vin):
        return "Outback XT" if vin.endswith("1") else "Crosstrek PHEV"

    def get_model_year(self, vin):
        return "2025" if vin.endswith("1") else "2024"

    def get_model_name(self, vin):
        return "Outback" if vin.endswith("1") else "Crosstrek Hybrid"

    def get_api_gen(self, vin):
        return "g3" if vin.endswith("1") else "g2"

    def get_ev_status(self, vin):
        return vin.endswith("2")

    def get_remote_status(self, vin):
        return True

    def get_res_status(self, vin):
        return True

    def get_safety_status(self, vin):
        return True

    def get_subscription_status(self, vin):
        return True

    def has_tpms(self, vin):
        return True

    def has_sunroof(self, vin):
        return True

    async def list_climate_preset_names(self, vin):
        return ["Full Heat", "Full Cool", "Auto", "Winter Defrost"]

    async def fetch(self, vin, force=False):
        if vin == "JF2EXPIRED0000003" and not self._expired_simulated:
            self._expired_simulated = True
            raise subarulink.SubaruException(
                "HTTP 401: <!DOCTYPE html><html><body><h1>Oops!</h1></body></html> "
                "RequestInfo(url=URL('https://mobileapi.prod.subarucs.com/g2v33/validateSession.json'), headers={'Cookie': 'JSESSIONID=SECRET'})"
            )
        if vin == "JF2PERM4010000004":
            raise subarulink.SubaruException(
                "HTTP 401: <!DOCTYPE html><html><body><h1>Oops! We can't seem to find the page you're looking for.</h1></body></html> "
                "RequestInfo(url=URL('https://mobileapi.prod.subarucs.com/g2v33/validateSession.json'), headers={'Cookie': 'JSESSIONID=SECRET'})"
            )
        if os.environ.get("MOCK_SLOW_FETCH") == "1" and not force:
            await asyncio.sleep(0.35)
        return True

    async def update(self, vin, force=False):
        return True

    async def get_data(self, vin):
        return {
            "model_year": self.get_model_year(vin),
            "model_name": self.get_model_name(vin),
            "vehicle_name": self.vin_to_name(vin),
            "vehicle_status": {
                sc.ODOMETER: 0 if vin.endswith("2") else 12450,
                sc.DIST_TO_EMPTY: 0 if vin.endswith("2") else 310,
                sc.AVG_FUEL_CONSUMPTION: "16383" if vin.endswith("2") else 27.4,
                sc.VEHICLE_STATE: sc.IGNITION_OFF,
                sc.DOOR_FRONT_LEFT_POSITION: sc.DOOR_OPEN,
                sc.DOOR_FRONT_RIGHT_POSITION: sc.DOOR_CLOSED,
                sc.DOOR_REAR_LEFT_POSITION: sc.DOOR_CLOSED,
                sc.DOOR_REAR_RIGHT_POSITION: sc.DOOR_CLOSED,
                sc.DOOR_BOOT_POSITION: sc.DOOR_CLOSED,
                sc.DOOR_ENGINE_HOOD_POSITION: sc.NOT_EQUIPPED,
                sc.WINDOW_FRONT_LEFT_STATUS: sc.WINDOW_CLOSED,
                sc.WINDOW_SUNROOF_STATUS: sc.SUNROOF_TILT,
                sc.WINDOW_REAR_LEFT_STATUS: sc.WINDOW_UNKNOWN,
                sc.LOCK_FRONT_LEFT_STATUS: sc.LOCK_UNLOCKED if vin.endswith("1") else sc.LOCK_LOCKED,
                sc.LOCK_FRONT_RIGHT_STATUS: sc.LOCK_LOCKED,
                sc.EV_STATE_OF_CHARGE_PERCENT: 0.0 if vin.endswith("2") else None,
                sc.EV_CHARGER_STATE_TYPE: sc.CHARGING if vin.endswith("2") else None,
                sc.TIMESTAMP: datetime.datetime(2026, 10, 29, 12, 0, tzinfo=datetime.UTC),
            },
        }

    def get_raw_data(self, vin):
        return {
            "condition": {
                "data": {
                    "result": {
                        "externalTempFahrenheit": 68.0,
                        "batteryVoltage": "12.6",
                    }
                }
            }
        }

    def invalid_pin_entered(self):
        return self._pin_invalid

    def update_saved_pin(self, new_pin):
        self._pin = new_pin
        self._pin_invalid = False
        return True

    async def lock(self, vin):
        _record({"type": "cmd", "cmd": "lock", "vin": vin})
        return True

    async def unlock(self, vin, door=sc.ALL_DOORS):
        _record({"type": "cmd", "cmd": "unlock", "vin": vin, "door": door})
        return door in sc.VALID_DOORS

    async def remote_start(self, vin, preset_name):
        _record({"type": "cmd", "cmd": "remote_start", "vin": vin, "preset": preset_name})
        return preset_name in ["Full Heat", "Full Cool", "Auto", "Winter Defrost"]

    async def remote_stop(self, vin):
        _record({"type": "cmd", "cmd": "remote_stop", "vin": vin})
        return True

    async def horn(self, vin):
        return True

    async def horn_stop(self, vin):
        return True

    async def lights(self, vin):
        return True

    async def lights_stop(self, vin):
        return True

    async def charge_start(self, vin):
        return True

subarulink.Controller = MockController
`;
  fs.writeFileSync(path.join(dirPath, 'sitecustomize.py'), code, 'utf8');
}

async function testBridgeLifecycleConcurrencyAndCrashRecovery() {
  console.log('3. Testing SubaruPythonBridge telemetry, commands, 2FA, concurrency, and SIGKILL crash recovery...');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-subarulink-test-'));
  const logPath = path.join(tmpDir, 'events.json');
  writeMockSitecustomize(tmpDir, logPath);

  const mockEnv = {
    PYTHONPATH: tmpDir,
    MOCK_SLOW_FETCH: '1',
  };

  try {
    // 3.0 Verify default paths live 100% inside Homebridge storagePath (Verified Plugin requirement)
    const defaultPathCheck = new SubaruPythonBridge(
      createSilentLogger(),
      { platform: 'SubaruLink', name: 'SubaruLink' },
      tmpDir,
    );
    assert.equal(defaultPathCheck.runtimeDir, path.join(tmpDir, 'subarulink', '.runtime'));
    assert.equal(defaultPathCheck.stateFilePath, path.join(tmpDir, 'subarulink', 'subarulink.cfg'));
    assert.equal(
      defaultPathCheck.venvPythonPath,
      path.join(tmpDir, 'subarulink', '.runtime', 'venv', 'bin', 'python'),
    );

    // 3a. Test 2FA flows (2fa_required -> case-insensitive 2fa_code_sent -> 2fa code accepted)
    const logger2fa = createSilentLogger();
    const bridge2faReq = new SubaruPythonBridge(
      logger2fa,
      {
        platform: 'SubaruLink',
        name: 'SubaruLink',
        username: 'needs2fa@example.com',
        password: 'secret',
        pin: '1234',
        twoFactorContactMethod: 'username', // lowercase on purpose to test canonical matching -> 'userName'
      },
      tmpDir,
      { venvPythonPath: VENV_PYTHON, env: mockEnv },
    );
    const reqSent = await bridge2faReq.start();
    assert.equal(reqSent, false, 'Expected start() to return false while waiting for 2FA code');
    await bridge2faReq.stop();

    const bridge2faSubmit = new SubaruPythonBridge(
      logger2fa,
      {
        platform: 'SubaruLink',
        name: 'SubaruLink',
        username: 'needs2fa@example.com',
        password: 'secret',
        pin: '1234',
        twoFactorContactMethod: 'username',
        twoFactorCode: '654321',
      },
      tmpDir,
      { venvPythonPath: VENV_PYTHON, env: mockEnv },
    );
    const codeAccepted = await bridge2faSubmit.start();
    assert.equal(codeAccepted, true, 'Expected start() to return true when valid 2FA code is submitted');
    await bridge2faSubmit.stop();

    // Remove state file from 2FA test so we also verify automatic deviceId generation + persistence
    fs.rmSync(path.join(tmpDir, 'subarulink', 'subarulink.cfg'), { force: true });

    // 3b. Standard session + CLI config parity + telemetry + commands + concurrency + crash recovery
    const logger = createSilentLogger();
    const bridge = new SubaruPythonBridge(
      logger,
      {
        platform: 'SubaruLink',
        name: 'SubaruLink',
        username: 'driver@example.com',
        password: 'secret',
        pin: '1234',
        country: 'USA',
        deviceName: 'homebridge-pi5',
        vin: 'jf2btanc0r0000001',
        defaultPreset: 'Full Heat',
      },
      tmpDir,
      { venvPythonPath: VENV_PYTHON, env: mockEnv },
    );

    const started = await bridge.start();
    assert.equal(started, true);

    // Check CLI-compatible subarulink.cfg
    const cfgPath = path.join(tmpDir, 'subarulink', 'subarulink.cfg');
    assert.ok(fs.existsSync(cfgPath), 'Expected subarulink.cfg to be written');
    const cfgStat = fs.statSync(cfgPath);
    assert.equal(cfgStat.mode & 0o777, 0o600, 'Expected 0600 permissions on subarulink.cfg');
    const cfgData = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.ok(
      Number.isInteger(cfgData.device_id) && cfgData.device_id > 1700000000,
      'Expected auto-generated persistent integer device_id',
    );
    assert.equal(cfgData.default_vin, 'JF2BTANC0R0000001');
    assert.equal(cfgData.save_creds, 'Y');
    assert.equal(cfgData.remote_start_preset, 'Full Heat');

    // Verify a second SubaruPythonBridge instance reuses the persisted device_id from subarulink.cfg
    const bridgeReloadCheck = new SubaruPythonBridge(
      logger,
      {
        platform: 'SubaruLink',
        name: 'SubaruLink',
        username: 'driver@example.com',
        password: 'secret',
        pin: '1234',
      },
      tmpDir,
      { venvPythonPath: VENV_PYTHON, env: mockEnv },
    );
    await bridgeReloadCheck.start();
    const cfgDataReloaded = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.equal(
      cfgDataReloaded.device_id,
      cfgData.device_id,
      'Expected auto-generated device_id to persist across restarts',
    );
    await bridgeReloadCheck.stop();

    const vehicles = await bridge.discoverVehicles();
    assert.equal(vehicles.length, 2);
    assert.equal(vehicles[0].name, 'Outback XT');
    assert.equal(vehicles[1].is_ev, true);

    // Check Outback telemetry (doors, windows, locks, °F -> °C conversion, NOT_EQUIPPED hood filtered)
    const t1 = await bridge.getTelemetry('JF2BTANC0R0000001', { force: true });
    assert.equal(t1.odometer, 12450);
    assert.equal(t1.doors.front_left_door, 'OPEN');
    assert.equal(t1.doors.front_right_door, 'CLOSED');
    assert.equal(t1.doors.hood, undefined, 'NOT_EQUIPPED hood must be omitted');
    assert.equal(t1.windows.front_left_window, 'CLOSE');
    assert.equal(t1.windows.sunroof, 'TILT');
    assert.equal(t1.windows.rear_left_window, undefined, 'UNKNOWN window must be omitted');
    assert.equal(t1.locks.front_left_lock, 'UNLOCKED');
    assert.equal(t1.external_temp, 20.0, 'Expected 68°F converted to 20.0°C');
    assert.equal(t1.battery_voltage, 12.6);

    // Check PHEV zero-value edge cases & BAD_SENSOR_VALUES ("16383") filtering
    const t2 = await bridge.getTelemetry('JF2GTAPC0P0000002', { force: true });
    assert.equal(t2.odometer, 0, 'Odometer 0 must be preserved as 0, not null');
    assert.equal(t2.dist_to_empty, 0, 'DTE 0 must be preserved as 0, not null');
    assert.equal(t2.ev_charge_percent, 0, 'EV charge 0% must be preserved as 0, not null');
    assert.equal(t2.avg_fuel, null, 'Sentinel 16383 must be filtered out as null');

    // Concurrency test: start slow background poll (350ms) and immediately fire urgent lock command
    const t0 = Date.now();
    const slowPollPromise = bridge.getTelemetry('JF2BTANC0R0000001', { wake: false, force: false });
    await new Promise((r) => setTimeout(r, 20));
    const lockOk = await bridge.executeCommand('JF2BTANC0R0000001', 'lock');
    const lockElapsed = Date.now() - t0;
    assert.equal(lockOk, true);
    assert.ok(
      lockElapsed < 250,
      `Expected urgent lock command to finish concurrently (<250ms), took ${lockElapsed}ms`,
    );
    await slowPollPromise;

    // Test case-insensitive preset matching and door unlock constants
    assert.equal(
      await bridge.executeCommand('JF2BTANC0R0000001', 'remote_start', { preset: 'winter defrost' }),
      true,
    );
    assert.equal(
      await bridge.executeCommand('JF2BTANC0R0000001', 'unlock', { door: 'DRIVERS_DOOR' }),
      true,
    );

    // Test transient HTTP 401 session expiry auto-reconnect & HTML/cookie sanitization in Python bridge
    const recoveredTelemetry = await bridge.getTelemetry('JF2EXPIRED0000003', { force: true });
    assert.equal(recoveredTelemetry.vin, 'JF2EXPIRED0000003', 'Expected auto-reconnect retry to succeed on transient HTTP 401');
    await assert.rejects(
      () => bridge.getTelemetry('JF2PERM4010000004', { force: true }),
      (err) => {
        assert.ok(!err.message.includes('<!DOCTYPE'), 'Python bridge error must strip HTML body');
        assert.ok(!err.message.includes('JSESSIONID'), 'Python bridge error must strip session cookies');
        assert.ok(err.message.includes('/g2v33/validateSession.json'), 'Python bridge error should include endpoint path');
        return true;
      },
    );

    // Crash recovery test: SIGKILL the underlying Python daemon and immediately run executeCommand
    const eventsBeforeKill = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    const initCountBefore = eventsBeforeKill.filter((e) => e.type === 'init').length;
    assert.ok(bridge.proc && bridge.proc.pid, 'Expected active Python child process');
    bridge.proc.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 60));

    const postCrashOk = await bridge.executeCommand('JF2BTANC0R0000001', 'remote_stop');
    assert.equal(postCrashOk, true, 'Expected command after daemon crash to auto-respawn, re-init, and succeed');

    const eventsAfterKill = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    const initCountAfter = eventsAfterKill.filter((e) => e.type === 'init').length;
    assert.equal(initCountAfter, initCountBefore + 1, 'Expected automatic init RPC after daemon crash');

    await bridge.stop();
    console.log('   ✓ Bridge 2FA, CLI config sync, telemetry, concurrency, and SIGKILL crash recovery passed');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testHomebridgeV2CachedAccessoryRestart() {
  console.log('4. Testing Homebridge v2.4.0 API registration & cached PlatformAccessory restart...');
  const hapWarnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => {
    const line = args.map(String).join(' ');
    if (line.includes('HAP-NodeJS WARNING')) {
      hapWarnings.push(line);
    }
    origWarn(...args);
  };

  try {
    const api = new HomebridgeAPI();
    const initializer = typeof pluginEntry === 'function' ? pluginEntry : pluginEntry.default;
    assert.equal(typeof initializer, 'function', 'Plugin entrypoint must export initializer function');
    initializer(api);

    const logger = createSilentLogger();
    const baseConfig = {
      platform: 'SubaruLink',
      name: 'SubaruLink',
      defaultPreset: 'Full Heat',
      additionalPresets: ['Full Cool', 'Auto', 'Morning (Warm)!'],
      exposeTailgateUnlockSwitch: true,
      exposeLightsSwitch: true,
      exposeHornSwitch: true,
      exposeLocateSwitch: true,
      exposeDoorWindowSensors: true,
    };

    // Instantiate platform without credentials so it doesn't auto-launch daemon on didFinishLaunching
    const platform = new SubaruLinkPlatform(logger, baseConfig, api);

    const mockTelemetry = {
      vin: 'JF2GTAPC0P0000002',
      odometer: 8500,
      external_temp: 18.5,
      ev_charge_percent: 82,
      ev_charger_state: 'CHARGING',
      doors: {
        front_left_door: 'OPEN',
        front_right_door: 'CLOSED',
      },
      windows: {
        front_left_window: 'CLOSE',
        sunroof: 'TILT',
      },
      locks: {
        front_left_lock: 'UNLOCKED',
        front_right_lock: 'LOCKED',
      },
      raw: {},
    };

    platform.bridge = {
      hasActiveCommand: () => false,
      getTelemetry: async () => mockTelemetry,
      executeCommand: async () => true,
    };

    const vehicle = {
      vin: 'JF2GTAPC0P0000002',
      name: 'Crosstrek PHEV',
      model_year: '2024',
      model_name: 'Crosstrek Hybrid',
      api_gen: 'g2',
      is_ev: true,
      has_remote: true,
      has_res: true,
      has_safety: true,
      has_subscription: true,
      has_tpms: true,
      has_sunroof: true,
      climate_presets: ['Full Heat', 'Full Cool', 'Auto'],
    };

    const uuid = api.hap.uuid.generate(`subarulink-${vehicle.vin}`);
    const accessory = new api.platformAccessory(vehicle.name, uuid);

    // Boot #1: Fresh accessory
    const handler1 = new SubaruVehicleAccessory(platform, accessory, vehicle);
    await handler1.refreshTelemetry({ force: true });
    accessory._associatedHAPAccessory.validateAccessory(false);

    const { Service, Characteristic } = api.hap;
    assert.equal(
      accessory
        .getServiceById(Service.ContactSensor, 'sensor-front_left_door')
        .getCharacteristic(Characteristic.ContactSensorState).value,
      Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
    );
    assert.equal(
      accessory
        .getServiceById(Service.ContactSensor, 'sensor-front_left_window')
        .getCharacteristic(Characteristic.ContactSensorState).value,
      Characteristic.ContactSensorState.CONTACT_DETECTED,
    );
    assert.equal(
      accessory
        .getServiceById(Service.ContactSensor, 'sensor-sunroof')
        .getCharacteristic(Characteristic.ContactSensorState).value,
      Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
    );
    assert.equal(
      accessory.getService(Service.LockMechanism),
      undefined,
      'No stateful lock service: lock/unlock are momentary buttons',
    );
    for (const sub of ['button-lock', 'button-unlock', 'button-remote-stop', 'remote-start-primary']) {
      assert.ok(accessory.getServiceById(Service.Switch, sub), `Missing ${sub} button`);
    }
    assert.equal(
      accessory
        .getServiceById(Service.TemperatureSensor, 'ext-temp')
        .getCharacteristic(Characteristic.CurrentTemperature).value,
      18.5,
    );
    assert.equal(
      accessory
        .getServiceById(Service.Battery, 'ev-battery')
        .getCharacteristic(Characteristic.BatteryLevel).value,
      82,
    );
    handler1.dispose();

    // Boot #2: Simulated Homebridge restart with cached accessory AND modified config.
    // The cache also carries a LockMechanism from an older plugin version, which must be removed.
    accessory.addService(Service.LockMechanism, 'Crosstrek PHEV Doors', 'lock-doors');
    platform.config.defaultPreset = 'Winter Defrost';
    platform.config.additionalPresets = ['Full Cool']; // 'Auto' and 'Morning (Warm)!' removed!
    platform.config.exposeHornSwitch = false; // Horn disabled!

    const handler2 = new SubaruVehicleAccessory(platform, accessory, vehicle);
    accessory._associatedHAPAccessory.validateAccessory(false);

    assert.equal(
      accessory.getServiceById(Service.Switch, 'remote-start-auto'),
      undefined,
      'Removed additionalPreset switch should be pruned from cached accessory',
    );
    assert.equal(
      accessory.getServiceById(Service.Switch, 'remote-start-morning-warm'),
      undefined,
      'Removed custom preset switch should be pruned from cached accessory',
    );
    assert.equal(
      accessory.getServiceById(Service.Switch, 'panic-horn'),
      undefined,
      'Disabled horn switch should be pruned from cached accessory',
    );
    assert.equal(
      accessory.getService(Service.LockMechanism),
      undefined,
      'Legacy cached LockMechanism should be removed',
    );
    assert.equal(
      accessory
        .getServiceById(Service.Switch, 'remote-start-primary')
        .getCharacteristic(Characteristic.ConfiguredName).value,
      'Crosstrek PHEV Remote Start - Winter Defrost',
    );
    assert.deepEqual(hapWarnings, [], `Unexpected HAP-NodeJS warnings: ${hapWarnings.join('; ')}`);

    // Verify HTML / RequestInfo sanitization & transient poll failure suppression
    const rawHtmlErr = `SubaruException: HTTP 401: <!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN">\n<html><head><title>AdminPortal</title></head><body><h1>Oops! We can't seem to find the page you're looking for.</h1></body></html>\nRequestInfo(url=URL('https://mobileapi.prod.subarucs.com/g2v33/validateSession.json'), method='GET', headers=<CIMultiDictProxy('Cookie': 'JSESSIONID=SECRET123')>)`;
    const sanitized = formatLogError(new Error(rawHtmlErr));
    assert.ok(!sanitized.includes('\n'), 'Sanitized log error must be single-line');
    assert.ok(!sanitized.includes('JSESSIONID'), 'Sanitized log error must strip session cookies');
    assert.ok(!sanitized.includes('<!DOCTYPE'), 'Sanitized log error must strip HTML markup');
    assert.ok(sanitized.includes('/g2v33/validateSession.json'), 'Sanitized log error should preserve endpoint path');

    // Regression test for CodeQL js/incomplete-multi-character-sanitization (nested/unclosed angle brackets)
    const nestedHtmlErr =
      'HTTP 502: <html><body><h1>502 <scrip<script>t>alert(1)</script> Bad <script Gateway</h1></body></html>';
    const sanitizedNested = formatLogError(new Error(nestedHtmlErr));
    assert.ok(!sanitizedNested.includes('<'), 'Sanitized log error must not leave "<" from nested/unclosed tags');
    assert.ok(!sanitizedNested.includes('>'), 'Sanitized log error must not leave ">" from nested/unclosed tags');
    assert.ok(!sanitizedNested.toLowerCase().includes('<script'), 'Sanitized log error must not contain <script');
    assert.ok(sanitizedNested.includes('502'), 'Sanitized log error should retain readable status summary');

    // VINs must never reach the Homebridge log, whether in messages or endpoint query strings
    const vinErr = formatLogError(
      new Error(
        "SubaruException: Invalid VIN: jf2btanc0r0000001 RequestInfo(url=URL('https://mobileapi.prod.subarucs.com/g2v33/selectVehicle.json?vin=JF2BTANC0R0000001'), method='GET')",
      ),
    );
    assert.ok(!/JF2BTANC0R0000001/i.test(vinErr), `VIN leaked into log: ${vinErr}`);
    assert.ok(vinErr.includes('[VIN]'), 'VIN should be replaced with [VIN]');
    assert.equal(
      formatLogError(new Error('HTTP 500 after 12345678901234567 ms on DEVICE_NOT_AUTHENTICATED')),
      'HTTP 500 after 12345678901234567 ms on DEVICE_NOT_AUTHENTICATED',
      'All-digit numbers and words are not mistaken for VINs',
    );

    logger.logs.length = 0;
    platform.bridge.getTelemetry = async () => {
      throw new Error(rawHtmlErr);
    };
    await handler2.refreshTelemetry({ wake: false, force: false }); // failure #1 -> debug only
    await handler2.refreshTelemetry({ wake: false, force: false }); // failure #2 -> debug only
    assert.equal(
      logger.logs.filter((l) => l.level === 'warn').length,
      0,
      'First 2 transient background poll failures should log at debug, not warn',
    );
    await handler2.refreshTelemetry({ wake: false, force: false }); // failure #3 -> single concise warn
    const warns = logger.logs.filter((l) => l.level === 'warn');
    assert.equal(warns.length, 1, 'Expected 1 warn on 3rd consecutive poll failure');
    assert.ok(!warns[0].msg.includes('JSESSIONID') && !warns[0].msg.includes('\n'));

    handler2.dispose();
    console.log('   ✓ Homebridge v2.4.0 cached PlatformAccessory restart, HAP name validation & log hygiene passed');
  } finally {
    console.warn = origWarn;
  }
}

/**
 * Regression test for duplicate remote commands with stateless buttons: presses
 * must return immediately, repeated presses while a command is in flight must
 * not send it again, buttons never report a lock/engine state, and they flip
 * back to Off on their own.
 */
async function testFireAndForgetCommands() {
  console.log('5. Testing stateless lock / unlock / start / stop buttons (fire-and-forget, no duplicates)...');
  const api = new HomebridgeAPI();
  const logger = createSilentLogger();
  const platform = new SubaruLinkPlatform(
    logger,
    {
      platform: 'SubaruLink',
      name: 'SubaruLink',
      defaultPreset: 'Full Heat',
      additionalPresets: [],
      commandGapSeconds: 0, // queue spacing is covered by section 6
      commandBatchWindowMs: 0, // priority batching is covered by section 7
    },
    api,
  );
  const { calls } = installControllableBridge(platform);
  const { handler, accessory } = createTestVehicleAccessory(api, platform);
  const unlockBtn = buttonOn(api, accessory, 'button-unlock');
  const lockBtn = buttonOn(api, accessory, 'button-lock');
  const startBtn = buttonOn(api, accessory, 'remote-start-primary');
  const stopBtn = buttonOn(api, accessory, 'button-remote-stop');

  // 1. Three back-to-back Unlock presses (the reported bug) -> exactly one command.
  const writeStart = Date.now();
  for (let i = 0; i < 3; i++) {
    await unlockBtn.handleSetRequest(true);
  }
  assert.ok(Date.now() - writeStart < 500, 'Button presses must return without waiting for MySubaru');
  await settleTick();
  assert.equal(calls.length, 1, 'Repeated presses while in flight must send only one command');
  assert.equal(calls[0].command, 'unlock');
  assert.deepEqual(calls[0].args, { door: 'ALL_DOORS' });
  assert.equal(await unlockBtn.handleGetRequest(), false, 'Buttons never report a state');
  calls[0].resolve(true);
  await handler.lockRunner.whenIdle();
  assert.ok(logger.logs.some((l) => l.msg.includes('Vehicle unlocked (ALL_DOORS).')));
  await sleepMs(1100);
  assert.equal(unlockBtn.value, false, 'Button flips back to Off on its own');

  // 2. Failed lock -> error logged.
  await lockBtn.handleSetRequest(true);
  await settleTick();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].command, 'lock');
  calls[1].resolve(false);
  await handler.lockRunner.whenIdle();
  assert.ok(
    logger.logs.some((l) => l.level === 'error' && l.msg.includes('Lock command failed')),
    'Failed lock must be logged as an error',
  );

  // 3. Lock pressed, then Unlock pressed while the lock is in flight -> unlock queued, runs after.
  await lockBtn.handleSetRequest(true);
  await unlockBtn.handleSetRequest(true);
  await settleTick();
  assert.equal(calls.length, 3, 'Opposite request is queued, not sent concurrently');
  calls[2].resolve(true);
  await settleTick();
  assert.equal(calls.length, 4, 'Queued unlock runs once the lock finishes');
  assert.equal(calls[3].command, 'unlock');
  calls[3].resolve(true);
  await handler.lockRunner.whenIdle();

  // 4. Remote Start pressed twice -> one command; failure logged.
  await startBtn.handleSetRequest(true);
  await startBtn.handleSetRequest(true);
  await settleTick();
  assert.equal(calls.length, 5, 'Repeated start presses must send only one command');
  assert.equal(calls[4].command, 'remote_start');
  assert.deepEqual(calls[4].args, { preset: 'Full Heat' });
  calls[4].reject(new Error('RemoteServiceFailure: low fuel'));
  await handler.engineRunner.whenIdle();
  assert.ok(logger.logs.some((l) => l.level === 'error' && l.msg.includes('Remote start (Full Heat) failed')));

  // 5. Turning a button Off sends nothing.
  await startBtn.handleSetRequest(false);
  await stopBtn.handleSetRequest(false);
  await settleTick();
  assert.equal(calls.length, 5, 'Turning a button Off must not send a command');

  // 6. Stop Engine button sends remote_stop.
  await stopBtn.handleSetRequest(true);
  await settleTick();
  assert.equal(calls[5].command, 'remote_stop');
  calls[5].resolve(true);
  await handler.engineRunner.whenIdle();

  // 7. Stateless: pressing Start again after a confirmed start sends it again.
  await startBtn.handleSetRequest(true);
  await settleTick();
  assert.equal(calls.length, 7);
  assert.equal(calls[6].command, 'remote_start');
  calls[6].resolve(true);
  await handler.engineRunner.whenIdle();

  handler.dispose();
  console.log('   ✓ Presses return immediately, duplicates dropped, buttons stateless and self-resetting');
}

/** The On characteristic of a button (Switch service) by subtype. */
function buttonOn(api, accessory, subtype) {
  const svc = accessory.getServiceById(api.hap.Service.Switch, subtype);
  assert.ok(svc, `Missing ${subtype} button`);
  return svc.getCharacteristic(api.hap.Characteristic.On);
}

const settleTick = () => new Promise((r) => setImmediate(r));
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/** Replaces the platform bridge with one whose commands stay pending until the test settles them. */
function installControllableBridge(platform) {
  const calls = [];
  platform.bridge = {
    hasActiveCommand: () => calls.some((c) => !c.settled),
    getTelemetry: async () => ({ vin: 'JF2BTANC0R0000001', raw: {} }),
    executeCommand: (vin, command, args) =>
      new Promise((resolve, reject) => {
        const call = { vin, command, args, settled: false, startedAt: Date.now() };
        call.resolve = (v) => {
          call.settled = true;
          call.settledAt = Date.now();
          resolve(v);
        };
        call.reject = (e) => {
          call.settled = true;
          call.settledAt = Date.now();
          reject(e);
        };
        calls.push(call);
      }),
  };
  return { calls };
}

function createTestVehicleAccessory(api, platform) {
  const vehicle = {
    vin: 'JF2BTANC0R0000001',
    name: 'Test Outback',
    model_year: '2025',
    model_name: 'Outback',
    api_gen: 'g3',
    is_ev: false,
    has_remote: true,
    has_res: true,
  };
  const accessory = new api.platformAccessory(vehicle.name, api.hap.uuid.generate(`subarulink-${vehicle.vin}`));
  const handler = new SubaruVehicleAccessory(platform, accessory, vehicle);
  return { handler, accessory };
}

/**
 * An automation that starts the engine and unlocks at the same moment: both
 * HomeKit writes return immediately, but MySubaru sees one command at a time,
 * the second only after the first has finished plus the configured gap.
 */
async function testCommandQueueSpacing() {
  console.log('6. Testing account-wide command queue (start + unlock together, spaced apart)...');
  const GAP_MS = 150;
  const api = new HomebridgeAPI();
  const logger = createSilentLogger();
  const platform = new SubaruLinkPlatform(
    logger,
    {
      platform: 'SubaruLink',
      name: 'SubaruLink',
      defaultPreset: 'Full Heat',
      additionalPresets: [],
      commandGapSeconds: GAP_MS / 1000,
      commandBatchWindowMs: 0, // priority batching is covered by section 7
    },
    api,
  );
  const { calls } = installControllableBridge(platform);
  const { handler, accessory } = createTestVehicleAccessory(api, platform);
  const startBtn = buttonOn(api, accessory, 'remote-start-primary');
  const unlockBtn = buttonOn(api, accessory, 'button-unlock');
  const lockBtn = buttonOn(api, accessory, 'button-lock');
  const stopBtn = buttonOn(api, accessory, 'button-remote-stop');

  // Automation presses both at once.
  const writeStart = Date.now();
  await Promise.all([startBtn.handleSetRequest(true), unlockBtn.handleSetRequest(true)]);
  assert.ok(Date.now() - writeStart < 500, 'Both HomeKit writes return immediately');
  await settleTick();
  assert.equal(calls.length, 1, 'Only one command is sent to MySubaru at a time');
  assert.equal(calls[0].command, 'remote_start');
  assert.ok(platform.commandQueue.busy);
  assert.ok(
    logger.logs.some((l) => l.msg.includes('unlock queued behind 1 other command')),
    'Queued command is logged',
  );

  // Start finishes; unlock must wait for the gap before being sent.
  calls[0].resolve(true);
  await settleTick();
  assert.equal(calls.length, 1, 'Next command waits out the gap after the previous one finishes');
  await sleepMs(GAP_MS + 100);
  assert.equal(calls.length, 2, 'Queued unlock is sent after the gap');
  assert.equal(calls[1].command, 'unlock');
  assert.ok(
    calls[1].startedAt - calls[0].settledAt >= GAP_MS - 5,
    `Gap between commands was ${calls[1].startedAt - calls[0].settledAt}ms, expected >= ${GAP_MS}ms`,
  );

  calls[1].resolve(true);
  await platform.commandQueue.whenIdle();
  await handler.lockRunner.whenIdle();
  assert.equal(platform.commandQueue.busy, false);

  // A failed command does not block the ones behind it.
  await Promise.all([lockBtn.handleSetRequest(true), stopBtn.handleSetRequest(true)]);
  await sleepMs(GAP_MS + 100); // the previous unlock just finished, so the gap applies first
  assert.equal(calls.length, 3);
  assert.equal(calls[2].command, 'lock');
  calls[2].reject(new Error('HTTP 500'));
  await sleepMs(GAP_MS + 100);
  assert.equal(calls.length, 4, 'Command behind a failure still runs');
  assert.equal(calls[3].command, 'remote_stop');
  calls[3].resolve(true);
  await platform.commandQueue.whenIdle();
  await handler.engineRunner.whenIdle();
  assert.ok(logger.logs.some((l) => l.msg.includes('Engine stopped.')));

  handler.dispose();
  console.log(`   ✓ Simultaneous start + unlock sent one at a time with a ${GAP_MS}ms gap; failures do not block`);
}

/**
 * Remote start locks the car, so when an automation fires unlock and remote
 * start together, remote start must reach MySubaru first even if HomeKit
 * delivers the unlock first.
 */
async function testRemoteStartPriority() {
  console.log('7. Testing remote start goes before a simultaneous unlock (start locks the car)...');
  const BATCH_MS = 120;
  const GAP_MS = 30;
  const api = new HomebridgeAPI();
  const logger = createSilentLogger();
  const platform = new SubaruLinkPlatform(
    logger,
    {
      platform: 'SubaruLink',
      name: 'SubaruLink',
      defaultPreset: 'Full Heat',
      additionalPresets: [],
      commandGapSeconds: GAP_MS / 1000,
      commandBatchWindowMs: BATCH_MS,
    },
    api,
  );
  const { calls } = installControllableBridge(platform);
  const { handler, accessory } = createTestVehicleAccessory(api, platform);
  const unlockBtn = buttonOn(api, accessory, 'button-unlock');
  const startBtn = buttonOn(api, accessory, 'remote-start-primary');

  // HomeKit delivers the unlock first, the start a few ms later (same automation).
  await unlockBtn.handleSetRequest(true);
  await sleepMs(5);
  await startBtn.handleSetRequest(true);
  await settleTick();
  assert.equal(calls.length, 0, 'Idle queue waits the batch window before sending');

  await sleepMs(BATCH_MS + 50);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'remote_start', 'Remote start is sent before the earlier unlock');
  assert.ok(
    logger.logs.some((l) => l.msg.includes('remote_start goes first, ahead of') && l.msg.includes('unlock')),
    'Reordering is logged',
  );

  calls[0].resolve(true);
  await handler.engineRunner.whenIdle();
  await sleepMs(GAP_MS + 50);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].command, 'unlock', 'Unlock runs after remote start, so the car ends up unlocked');
  calls[1].resolve(true);
  await handler.lockRunner.whenIdle();
  await platform.commandQueue.whenIdle();
  assert.equal(platform.commandQueue.busy, false);

  handler.dispose();
  console.log('   ✓ Remote start overtakes a simultaneous unlock');
}

async function main() {
  console.log('==============================================================');
  console.log('  homebridge-subarulink End-to-End Verification Smoke Suite   ');
  console.log('==============================================================');
  await testUpstreamPackageSignatures();
  await testRawJsonRpcFramingAndErrors();
  await testBridgeLifecycleConcurrencyAndCrashRecovery();
  await testHomebridgeV2CachedAccessoryRestart();
  await testFireAndForgetCommands();
  await testCommandQueueSpacing();
  await testRemoteStartPriority();
  console.log('==============================================================');
  console.log('  ALL SMOKE & INTEGRATION TESTS PASSED!                       ');
  console.log('==============================================================');
}

main().catch((err) => {
  console.error('\nSMOKE TEST FAILED:', err);
  process.exitCode = 1;
});
