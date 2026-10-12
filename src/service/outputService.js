import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';

import { StateStore } from '../core/stateStore.js';
import { Output } from '../output.js';
import { STATUS_HINT_KO } from '../core/types.js';
import { DeviceDriver, LED_METHOD, RUNTIME_METHODS } from '../device/deviceDriver.js';
import { RenderScheduler } from '../device/renderScheduler.js';
import { buildDeviceScene } from '../device/deviceScene.js';
import { capabilitiesFrom } from '../device/calibrationLoader.js';
import { InputDecoder } from '../input/inputDecoder.js';
import { DeviceEventDecoder } from '../input/deviceEventDecoder.js';
import { makeDispatcher } from '../input/intentDispatcher.js';
import { sectorsFor } from './controls.js';
import { createOrcaStack, SOURCE as ORCA_SOURCE } from '../adapters/orca/index.js';
import { createPersistence } from '../adapters/persistence/index.js';
import { parseKeymap, otherLayerNames, OUR_LAYERS } from '../keymap/keymapModel.js';
import { DeviceGuard } from './deviceGuard.js';
import { ForegroundWatcher } from './foregroundWatcher.js';
import { normalizeAction } from '../apps/appKeys.js';
import { resolveLayer, slotsOf, joystickOf } from '../apps/layers.js';
import { ledStyle } from '../apps/keyLed.js';
import { ActionRunner } from '../apps/actionRunner.js';
import { actionLabel } from '../apps/actionLabel.js';
import { buildStatusView, buildKeyMap } from './uiModel.js';
import { buildDiagnostics } from './diagnostics.js';
import { KeyRepeatMethods, LOGICAL_KEY_SLOT } from './keyRepeat.js';
import { HudPrefsMethods } from './hudPrefs.js';
import { Usage } from './usage.js';
import { LayerPickerMethods } from './layerPicker.js';
import { LayerStoreMethods } from './layerStore.js';
import { DeviceSetupMethods } from './deviceSetup.js';
import { SelfCheckMethods } from './selfCheck.js';

/**
 * 앱의 몸통 — doctor --live --orca 를 상주 서비스로 만든 것 (M5 설계 §4).
 *
 * Electron을 모른다. Electron main은 이 서비스를 만들고 IPC로 뷰를 보여줄 뿐이다.
 * 장치·Orca·앞 앱·키 합성·파일 위치는 전부 주입받는다 — 테스트는 가짜로 돈다.
 *
 * 지키는 것:
 *  - 런타임 transport는 fs.write가 막혀 있다. 키맵 쓰기는 withWriter()의 별도 transport만.
 *  - 키 합성·앱 실행·명령은 장치의 실제 조작에서만 (ActionRunner 불변식, 레이어 2026-10-03).
 *  - 장치·Orca가 없거나 권한이 없어도 죽지 않는다. health에 남기고 계속 재시도한다.
 *  - 모의 데이터를 실제인 척 섞지 않는다. Orca가 없으면 빈 슬롯과 경고.
 */
export { RUNTIME_METHODS };
export const INTERVALS = Object.freeze({ guard: 2000, orca: 2000, foreground: 1000, decoder: 100, battery: 60000 });
const LOG_MAX = 300;
/** Orca 확인 (2026-10-11 성능): Orca 레이어·상태판이 아니면 6초마다, 목록 전체는 10초마다 */
const ORCA_SLOW_MS = 6000;
const ORCA_FULL_MS = 10000;
/** LED 명령 응답을 기다리는 시간 (2026-10-11). 다른 장치 명령은 기본 5초 */
const LED_TIMEOUT_MS = 1200;
/** '지금 실행해 보기'에서 키 입력을 보내기 전 기다리는 시간 — 보낼 앱을 앞으로 가져올 시간 (2026-10-10) */
const TRY_WAIT_MS = 3000;
/** 다른 앱이 장치를 쓰는지: 이름은 2분에 한 번 찾고, 5분 조용하면 경고를 내린다 (2026-10-10) */
const SHARED_ASK_MS = 2 * 60 * 1000;
const SHARED_QUIET_MS = 5 * 60 * 1000;

const defaultTimers = {
  setInterval: (fn, ms) => { const h = setInterval(fn, ms); h.unref?.(); return h; },
  clearInterval: (h) => clearInterval(h),
};

/** 레이어 색(정수 또는 '#RRGGBB') → 복원 페이로드용 정수. 모르면 null */
function restoreColorOf(c) {
  if (c === null || c === undefined) return null;
  const n = typeof c === 'number' ? c : parseInt(String(c).replace('#', ''), 16);
  return Number.isFinite(n) ? n : null;
}

export class OutputService extends EventEmitter {
  constructor({
    calibration,
    stateDir = path.join(os.homedir(), '.output'),
    openRuntimeTransport,
    openWriteTransport = null,
    frontmost = async () => null,
    synth = async () => { const e = new Error('키 합성 수단이 없습니다.'); e.code = 'ACCESSIBILITY'; throw e; },
    isLocked = () => false,
    accessibilityTrusted = () => null,
    orcaEnabled = true,
    orcaBin = 'orca',
    orcaCli = null,
    orcaSettings = undefined,     // Orca 필터 설정 읽기. 테스트는 null로 끈다
    persist = true,
    ownBundleIds = [],
    sources = [ORCA_SOURCE],
    timers = defaultTimers,
    now = () => Date.now(),
    versions = {},
    fakeDevice = false,
    appExec = null,               // 앱별 키 실행부 (macos.js). 테스트는 가짜
    displays = () => [],          // 창 위치용 화면 목록 (Electron screen)
    keyRepeat = () => null,
    deviceUsers = async () => [],
    orcaRunning = async () => true,   // Orca 앱이 떠 있는가 (pgrep, 2026-10-11 성능)
    appName = async () => null,    // 번들 ID → 보이는 앱 이름 (실행 중 목록, 레이어 제안용, 2026-10-10)  // 장치를 함께 연 다른 앱 이름 (macos.deviceUsers, 2026-10-10)       // 누르고 있으면 반복의 { delayMs, intervalMs } (macOS 값, 2026-10-09). null이면 기본값
  }) {
    super();
    if (!calibration) throw new Error('보정(calibration)이 필요합니다.');
    this.calibration = calibration;
    this.stateDir = stateDir;
    this.openRuntimeTransport = openRuntimeTransport;
    this.openWriteTransport = openWriteTransport;
    this.frontmost = frontmost;
    this.accessibilityTrusted = accessibilityTrusted;
    this.orcaEnabled = orcaEnabled;
    this.orcaBin = orcaBin;
    this.orcaCli = orcaCli;
    this.orcaSettings = orcaSettings;
    this._lastOrcaNoteKo = null;
    this.timers = timers;
    this.now = now;
    this.versions = { app: null, firmware: null, orca: null, ...versions };
    this.fakeDevice = fakeDevice;
    this.isLocked = isLocked;
    this.keyRepeat = keyRepeat;
    this.deviceUsers = deviceUsers;
    this.orcaRunning = orcaRunning;
    this._uiVisible = false;
    this.appName = appName;
    this._frontName = null;
    this._shared = { seenAt: -Infinity, askedAt: -Infinity, names: [] };   // 다른 앱이 장치를 함께 씀
    this._repeats = new Map();     // 누르고 있는 반복 키: logical → { id, front, timer } (2026-10-09)
    this._consumed = new Set();    // 반복을 시작한 키 — 뗄 때 나오는 tap·hold를 버린다

    this.logs = [];
    this._handles = [];
    this.started = false;
    this.transport = null;
    this.deviceInfo = { layerName: null, layerColor: null, layerIsOutput: null, layerNeedsUpgrade: null, dialHintKo: null, otherLayerNames: [] };
    this.power = { battery: null, charging: null };   // device.status의 배터리 (2026-10-10)
    this.orcaState = orcaEnabled ? 'connecting' : 'disabled';
    this.orcaMessageKo = '';
    this.orca = null;
    this.lastEventKo = '';
    this.keymapDraft = null;

    // 소스 단축키: 저장된 것이 있으면 그것, 없으면 빈 4칸
    this.sources = sources;
    this._loadSources();

    this.store = new StateStore({ now });
    this._focusRouter = {
      focus: async () => ({ ok: false, reasonKo: 'Orca에 연결되지 않아 이동할 수 없습니다.' }),
    };
    this.bridge = new Output({
      store: this.store,
      focusRouter: { focus: (t) => this._focusRouter.focus(t) },
      sourceName: this.sources[0].name,
    });
    this.bridge.setActive(false);               // 앞 앱을 관측하기 전에는 대기 (스펙 §1)

    this.driver = new DeviceDriver({ calibration, send: (payload) => this._send(payload) });
    this.driver.capabilities = capabilitiesFrom(calibration);
    this._led = new Map();           // 키 LED 덧칠: logical → { down, press, hold, pressUntil } (2026-10-04)
    this.scheduler = new RenderScheduler({ bridge: this.bridge, device: this.driver, bus: this.bridge.bus, overlays: () => this._ledOverlays(), flash: () => this._flashNow() });
    this._flash = null;
    this._hudJoy = { dir: null, enteredAt: null };   // 화면 표시: 지금 들어간 방향과 그 시각
    this._prefs = this._loadPrefs();
    this._picker = null;   // 노브로 레이어 고르는 중 (2026-10-10)
    this._pin = null;      // 노브·상태판으로 고른 레이어 {layerId} — 풀 때까지 고정 (2026-10-11)
    this.usage = new Usage({ file: path.join(stateDir, 'usage.json'), now: this.now });
    this._everConnected = false;
    this.dispatch = makeDispatcher(this.bridge);
    this.decoder = new InputDecoder({
      sectors: calibration.joystick?.sectors ?? null,
      deadzone: calibration.joystick?.deadzone ?? 0.05,
      now,
      onIntent: (intent) => { this._onIntent(intent); },
      onKeyEdge: (key, down) => this._onKeyEdge(key, down),
    });
    this.eventDecoder = new DeviceEventDecoder({ decoder: this.decoder, calibration });
    this._joystickSectors = calibration.joystick?.sectors ?? null;
    this._applyDecoder(this.layers[0]);
    this.decoder.setJoystickDwell(this._prefs.joystickDwellMs);

    this.guard = new DeviceGuard({
      open: () => this.openRuntimeTransport(),
      // 프로미스를 돌려줘야 가드가 장치 정보 읽기까지 기다린다 (start() 종료 시 deviceInfo 보장)
      onConnected: (t) => this._onConnected(t),
      onDisconnected: (reason) => { this._onDisconnected(reason); },
    });
    this.mode = 'idle';           // 'orca' | 'app' | 'idle' (스펙 2026-10-03 §1)
    this._front = null;
    this._layer = null;
    this._slots = {};
    this.runner = new ActionRunner({
      exec: { synth, ...(appExec ?? {}) }, frontmost, displays, isLocked,   // 키 합성은 서비스의 synth가 기본
      ownBundleIds, orcaBundleIds: this.sources[0].bundleIds, now,
      log: (m) => this._log(`앱 키 — ${m}`),
    });
    this.watcher = new ForegroundWatcher({
      frontmost, ignoreBundleIds: ownBundleIds,
      onFront: (bundleId) => { this._front = bundleId; this._lookupFrontName(bundleId); this._reevaluateMode(); },
    });

    this.persistence = orcaEnabled && persist ? createPersistence({ store: this.store, dir: stateDir, now }) : null;
    this.restoring = false;
  }

  // ───────────── 수명

  async start() {
    if (this.started) return this;
    this.started = true;
    this._stopping = false;
    if (this._sourcesWarnKo) this._log(this._sourcesWarnKo, 'warn');
    for (const n of this._sourcesNotesKo ?? []) this._log(n);
    if (this.persistence) {
      const r = this.persistence.adapter.restore();
      if (r.warningKo) this._log(r.warningKo, 'warn');
      if (r.restored.length) {
        this.restoring = true;
        this._log(`복원: 작업 ${r.restored.length}개의 자리를 되살렸습니다 (상태는 확인 전)`);
      }
      for (const s of r.skipped) this._log(`복원 건너뜀: ${s.reasonKo}`, 'warn');
      if (this.persistence.fileStore.read().newerVersion) {
        this._log('더 새로운 버전의 상태 파일이 있어 이번 실행은 상태를 저장하지 않습니다.', 'warn');
        this.persistence = null;
      } else {
        this.persistence.adapter.start();
      }
    }
    if (this.orcaEnabled) {
      this.orca = await createOrcaStack({ store: this.store, bin: this.orcaBin, cli: this.orcaCli, settings: this.orcaSettings });
      this._focusRouter = this.orca.focusRouter;
      await this.refreshOrca();
    }
    this.scheduler.start();
    await this.guard.tick();
    await this.watcher.tick();
    const every = (ms, fn) => this._handles.push(this.timers.setInterval(() => { fn(); }, ms));
    every(INTERVALS.guard, () => this.guard.tick().then(() => this._changed()));
    if (this.orcaEnabled) every(INTERVALS.orca, () => this.refreshOrca());
    every(INTERVALS.foreground, () => this.watcher.tick());
    every(INTERVALS.decoder, () => this.decoder.tick());
    every(INTERVALS.battery, () => { this._readPower().then(() => { this._batteryWarn(); this._changed(); }); });
    // 밤 시간 밝기 (2026-10-10): 1분마다 구간에 들어가고 나오는지
    this._applyNight();
    every(60000, () => this._applyNight());
    this._changed();
    return this;
  }

  async stop() {
    // 키 LED '눌렀을 때' 타이머가 복원한 색을 덮지 않게 먼저 막는다
    this._stopping = true;
    this._stopAllRepeats();
    this.usage.flush();
    this._consumed.clear();
    this._led.clear();
    for (const h of this._handles) this.timers.clearInterval(h);
    this._handles = [];
    if (this.persistence) {
      const r = this.persistence.adapter.flush();
      this.persistence.adapter.stop();
      if (!r.ok) this._log(`저장 실패: ${r.messageKo}`, 'warn');
    }
    // 렌더를 먼저 멈춘다. 반대로 하면 진행 중이던 렌더(깜빡임 시계 등)가 복원한 색을 다시 덮는다.
    this.scheduler.stop();
    await this.scheduler.idle();
    await this._restoreLeds();
    this.guard.close();
    this.started = false;
  }

  /** 절전 진입/복귀 (Electron powerMonitor가 부른다) */
  suspend() {
    this.guard.suspend();
    this._changed();
  }

  async resume() {
    this.guard.resume();
    await this.guard.tick();
    if (this.orcaEnabled) await this.refreshOrca();
    this._changed();
  }

  // ───────────── Orca

  /** 한 번 읽는다. 겹쳐 불려도 한 번만 돈다 — 옛 목록이 새 목록 뒤에 적용되지 않게 (DeviceGuard.tick과 같은 규칙) */
  /** 상태판이 열렸다·닫혔다 (2026-10-11): 열려 있으면 Orca를 2초마다, 열리는 순간 바로 한 번 */
  setUiVisible(on) {
    const was = this._uiVisible;
    this._uiVisible = Boolean(on);
    if (this._uiVisible && !was && this.orcaEnabled) { this._orcaAt = -Infinity; this.refreshOrca(); }
  }

  refreshOrca() {
    if (!this._orcaBusy) {
      this._orcaBusy = this._refreshOrca().finally(() => { this._orcaBusy = null; });
    }
    return this._orcaBusy;
  }

  async _refreshOrca() {
    if (!this.orca) return;
    // 성능 (2026-10-11 측정: Orca CLI 3개를 2초마다 = CPU 한 코어의 약 23%):
    // Orca 레이어를 쓰거나 상태판이 열려 있으면 2초마다, 아니면 6초마다. 작업·터미널 목록 전체는 10초마다
    const t = this.now();
    const fast = this.mode === 'orca' || this._uiVisible;
    if (!fast && t - (this._orcaAt ?? -Infinity) < ORCA_SLOW_MS) return;
    this._orcaAt = t;
    // Orca 앱이 꺼져 있으면 CLI를 부르지 않는다 (pgrep 25ms ≪ CLI 450ms)
    let running = true;
    try { running = await this.orcaRunning(); } catch { running = true; }
    if (!running) { this._setOrca('unreachable', 'Orca 앱이 실행 중이 아닙니다.'); return; }
    const full = t - (this._orcaFullAt ?? -Infinity) >= ORCA_FULL_MS;
    if (full) this._orcaFullAt = t;
    try {
      if (this.orcaState !== 'connected') {
        const h = await this.orca.adapter.health();
        if (!h.runtimeReady) {
          this._setOrca('unreachable', 'Orca 런타임이 준비되지 않았습니다.');
          return;
        }
        this.versions.orca = h.appVersion;
      }
      const list = await this.orca.adapter.list({ full });
      this.orca.sync.indexTerminals(list.terminals);
      const d = this.orca.sync.syncOnce(list.units, { hiddenIds: list.hiddenIds, order: list.order });
      if (d.hidden.length) this._log(`Orca 필터(기본 브랜치 숨기기)로 작업 ${d.hidden.length}개의 자리를 비웠습니다`);
      // 설정을 못 읽은 경고는 바뀔 때 한 번만 남긴다
      const settingNote = list.notesKo.find((n) => /Orca 설정/.test(n)) ?? null;
      if (settingNote && settingNote !== this._lastOrcaNoteKo) this._log(settingNote, 'warn');
      this._lastOrcaNoteKo = settingNote;
      this.persistence?.adapter.noteSeen(list.units.map((u) => u.id));
      const swept = this.persistence?.adapter.sweep() ?? [];
      if (swept.length) this._log(`복원됐지만 관측되지 않은 작업 ${swept.length}개의 자리를 반납했습니다`);
      const werr = this.persistence?.adapter.lastWriteError ?? null;
      if (werr && werr !== this._lastPersistWarn) this._log(`저장 실패: ${werr}`, 'warn');
      this._lastPersistWarn = werr;
      this.restoring = this.store.allUnits().some((u) => u.restoredAt && !u.observedAt);
      this._setOrca('connected', '');
      if (d.added.length || d.vanished.length || d.hidden.length || d.arranged || d.updatedChildren || d.goneChildren || d.renamed || swept.length) {
        this.scheduler.requestRender();
      }
      this._changed();
    } catch (err) {
      this._setOrca('unreachable', String(err.message ?? err).split('\n')[0]);
    }
  }

  _setOrca(state, messageKo) {
    if (state !== this.orcaState) {
      this._log(state === 'connected' ? 'Orca 연결됨' : `Orca: ${messageKo}`, state === 'connected' ? 'info' : 'warn');
    }
    this.orcaState = state;
    this.orcaMessageKo = messageKo;
    this._changed();
  }

  // ───────────── 장치

  _send(payload) {
    if (!this.transport) return Promise.resolve({ ok: 1, offline: true });
    // 점검의 LED 테스트 중에는 평소 그리기를 보내지 않는다 — 끝나면 처음부터 다시 그린다 (selfCheck.js)
    if (this._ledTesting) return Promise.resolve({ ok: 1, skipped: true });
    // LED는 1.2초만 기다린다 (2026-10-11 실기: 블루투스에서 응답 하나가 빠지면 장치 명령이 한 줄로 서 있어
    // 다음 LED가 5초 늦었다). 정상 응답은 블루투스에서도 0.6초 안팎
    return this.transport.call(LED_METHOD, payload, LED_TIMEOUT_MS).catch((err) => {
      if (this.now() - (this._ledMissAt ?? -Infinity) >= 30000) {
        this._ledMissAt = this.now();
        this._log(`LED 응답이 없어 다음으로 넘어갔습니다 (${this.transport?.connection === 'bluetooth' ? '블루투스' : 'USB'}): ${err.message}`, 'warn');
      }
      throw err;
    });
  }

  async _onConnected(t) {
    this.transport = t;
    this.driver.invalidate();   // 다시 연결되면 장치 쪽 LED는 모른다 — 같은 장면도 다시 보낸다 (2026-10-11)
    this._offNotify = t.onNotification((obj) => { this._hudInput(obj); this.eventDecoder.handle(obj); });
    this._offForeign = t.onForeignResponse?.((m) => { this._onForeign(m); }) ?? null;
    this._log('장치 연결됨');
    this._startConnectFlash();
    try {
      const v = await t.call('sys.version');
      this.versions.firmware = v?.version ?? null;
      const status = await t.call('device.status');
      this._setPower(status);
      const raw = await t.call('fs.read', { file: 'keymap.json' });
      const { config } = parseKeymap(raw?.data ?? '');
      if (config) {
        const pi = Number.isInteger(status?.profile_index) ? status.profile_index : 0;
        // layer_index는 1부터 센다 (9/20 실측과 일치, tools/lib/doctorReport.resolveActive)
        const li = Number.isInteger(status?.layer_index) && status.layer_index >= 1 ? status.layer_index - 1 : 0;
        const profileLayers = config.profiles?.[pi]?.layers ?? [];
        // 장치 준비 뒤에는 레이어가 하나뿐이다. 장치가 옛 번호를 알려 줘도 그 하나가 지금 레이어다 (2026-10-04)
        const layer = profileLayers[li] ?? (profileLayers.length === 1 ? profileLayers[0] : undefined);
        const codes = (layer?.layout?.keymap ?? []).flat().map((c) => (c && typeof c === 'object' ? c.keycode : c));
        this.deviceInfo = {
          layerName: layer?.name ?? null,
          layerColor: layer?.color ?? null,
          layerIsOutput: codes.some((c) => String(c).startsWith('KV_OAI_')),
          // 실기 16차: ACT 코드는 LED 채널이 없다. 옛 Output 레이어와 Input의 ChatGPT 프리셋이 여기에 해당한다.
          layerNeedsUpgrade: codes.some((c) => String(c).startsWith('KV_OAI_ACT')),
          dialHintKo: null,
          profileIndex: pi,
          otherLayerNames: otherLayerNames(profileLayers, layer),
        };
        // 노브 누름이 아직 옛 레이어 전환 키(KI_LS)면 안내한다 (2026-10-03: 누름 = Output 칸). 경고가 아니라 안내다
        const encClick = layer?.layout?.encoders?.[0]?.[2];
        const clickCode = encClick && typeof encClick === 'object' ? encClick.keycode : encClick;
        this.deviceInfo.dialHintKo = /^KI_LS\d$/.test(String(clickCode ?? ''))
          ? '노브 누름이 아직 하드웨어 레이어 전환 키입니다. 설정 → 앱 정보 → 장치 준비를 실행하면 노브 누름에 레이어마다 동작을 넣을 수 있습니다.'
          : null;
      }
      this.driver.restoreColor = restoreColorOf(this.deviceInfo.layerColor);
    } catch (err) {
      this._log(`장치 정보를 읽지 못했습니다: ${err.message}`, 'warn');
    }
    this.scheduler.resync();
    this._changed();
  }

/**
   * 다른 앱(예: ChatGPT)이 장치에 명령을 보냈다 — 그 응답이 우리에게도 온다 (2026-10-10).
   * 누가 열었는지 2분에 한 번만 찾아 상태판에 알린다. 5분 동안 없으면 경고는 사라진다.
   */
  async _onForeign() {
    const t = this.now();
    this._shared.seenAt = t;
    if (t - this._shared.askedAt < SHARED_ASK_MS) return;
    this._shared.askedAt = t;
    try { this._shared.names = await this.deviceUsers(); } catch { this._shared.names = []; }
    this._changed();
  }

  _setPower(status) {
    this.power = {
      battery: Number.isFinite(status?.battery) ? status.battery : null,
      charging: typeof status?.is_charging === 'boolean' ? status.is_charging : null,
    };
  }

  /** 1분마다 배터리를 다시 읽는다. 실패는 조용히 넘긴다 (다음 회차에 다시) */
  async _readPower() {
    if (!this.transport) return;
    try { this._setPower(await this.transport.call('device.status')); } catch { /* 다음 회차 */ }
  }

  _onDisconnected(reason) {
    // 누른 채 끊긴 키를 비운다. 안 그러면 0.5초 뒤 '길게 누름'이 만들어진다 (C26)
    this.eventDecoder.disconnected();
    this.power = { battery: null, charging: null };
    this._stopAllRepeats();
    this._consumed.clear();          // 끊기면 뗌 탭이 오지 않는다 — 남겨 두면 다음 정상 탭을 버린다
    this._led.clear();               // 일시정지·끊김: 키 LED 덧칠도 지운다
    this._offNotify?.();
    this._offNotify = null;
    this._offForeign?.();
    this._offForeign = null;
    this.transport = null;
    this._log(`장치 연결 해제 (${reason})`);
    this._changed();
  }

  async _restoreLeds() {
    if (!this.transport || this.driver.restoreColor === null) return;
    try { await this.transport.call(LED_METHOD, this.driver.restorePayload()); } catch { /* 종료를 막지 않는다 */ }
  }

  // ───────────── 입력

  /** 앞 앱으로 레이어와 모드를 정한다 (프리셋 스펙 §3.2). Orca 모드 = Orca 프리셋을 연결한 레이어 */
  _reevaluateMode() {
    // 노브·상태판으로 고른 레이어: 풀 때까지 고정 (2026-10-11 사용자 결정 — 앞 앱이 바뀌어도 유지).
    // '자동'을 고르거나 앱을 다시 시작하면(저장하지 않음) 앞 앱 따라. 고른 레이어가 없어졌으면 풀린다
    const pinned = this._pin ? this.layers.find((l) => l.id === this._pin.layerId) : null;
    if (!pinned && this._pin) { this._log('고정한 레이어가 없어져 앞 앱 따라'); }
    if (!pinned) this._pin = null;
    const r = pinned ? { layer: pinned, mode: pinned.preset === 'orca' ? 'orca' : 'app' }
      : resolveLayer(this.layers, this._front);   // 앞 앱을 아직 모르면 기본 레이어 (2026-10-11)
    const mode = r?.mode ?? 'idle';
    this._layer = r?.layer ?? null;
    this._slots = r ? slotsOf(r.layer) : {};
    this._applyDecoder(r?.layer ?? this.layers[0]);
    let appMode = null;
    let layerKeys = null;
    // 키별 LED 평소 모습 (2026-10-04). 동작에 led가 있는 키만 — 없는 키는 장면이 레이어 색 기본으로
    const keyLeds = {};
    for (const [id, a] of Object.entries(this._slots)) {
      if (/^key\d+$/.test(id) && a.led?.normal) keyLeds[id] = ledStyle(a.led.normal, r.layer.color);
    }
    if (mode === 'orca') {
      this.bridge.setSourceName(this.sources[0].name);
      // 키 11·12·13은 레이어 칸 (2026-10-05)
      const ids = Object.values(LOGICAL_KEY_SLOT);
      layerKeys = { color: r.layer.color, assigned: ids.filter((id) => this._slots[id]),
        keyLeds: Object.fromEntries(Object.entries(keyLeds).filter(([id]) => ids.includes(id))) };
    } else if (mode === 'app') {
      // 레이어에 앱이 여러 개라 키 입력 재확인은 '지금 앞 앱'으로 한다
      appMode = {
        kind: r.layer.kind === 'default' ? 'default' : 'app', bundleId: r.layer.kind === 'default' ? null : this._front,
        name: r.layer.name, color: r.layer.color, assigned: Object.keys(this._slots), keyLeds,
        underglow: r.layer.underglow ? ledStyle(r.layer.underglow, r.layer.color) : null,
      };
    }
    // 레이어가 바뀌면 진행 중인 키 LED 덧칠을 지운다 (누른 채 앱을 바꿔도 찌꺼기 없음)
    if (this._ledLayerId !== (r?.layer?.id ?? null)) {
      // 레이어가 바뀌면 언더글로우를 새 레이어 색으로 잠깐 (처음 정할 때는 연결 인사가 있으니 빼고, 2026-10-10)
      if (this._ledLayerId !== undefined && r?.layer) this._layerFlash(r.layer.color);
      this._led.clear(); this._stopAllRepeats(); this._ledLayerId = r?.layer?.id ?? null;
    }
    const changed = mode !== this.mode;
    this.mode = mode;
    this.bridge.setActive(mode === 'orca');
    this.bridge.setAppMode(appMode);
    this.bridge.setLayerKeys(layerKeys);
    if (changed) this._log(mode === 'orca' ? 'Orca가 앞에 있어 활성' : mode === 'app' ? `${appMode.name} 레이어` : '대기');
    this._changed();
  }

  /** 레이어의 조이스틱 방향 수·축을 입력 해석기에 반영한다 (프리셋이면 프리셋 것) */
  _applyDecoder(layer) {
    const j = joystickOf(layer);
    this.decoder.setSectors(sectorsFor(j.directions, this._joystickSectors, j.axis));
  }

  /** 의도 → 레이어 칸 id */
  _slotOf(intent) {
    if (intent.type === 'dial') return `dial_${intent.direction}`;
    if (intent.type === 'joystick') return `joystick_${intent.direction}`;
    if (intent.type !== 'tap') return null;
    if (intent.key === 'dial_click') return 'dial_press';
    const m = /^slot(10|[1-9])$/.exec(intent.key ?? '');
    return m ? `key${m[1]}` : LOGICAL_KEY_SLOT[intent.key] ?? null;
  }

  /** 칸 하나 실행: 내장 동작은 Output, 나머지는 실행기 (실제 조작 기록 포함) */
  /** 오늘 키별 사용 횟수 {레이어 id: {칸: 횟수}} (2026-10-10) */
  usageToday() {
    return this.usage.today();
  }

  async _runSlot(slotId, ctx) {
    const action = this._slots[slotId];
    if (!action) return;
    if (action.type === 'builtin') {
      this.usage.add(this._layer?.id, slotId);
      try {
        const r = await this.bridge.runBuiltin(action.builtin);
        this.lastEventKo = r?.ok === false ? `이동 실패: ${r.reasonKo}` : `${actionLabel(action)} 실행`;
      } catch (err) {
        this._log(`입력 처리 실패: ${err.message}`, 'warn');
        this.lastEventKo = `${actionLabel(action)}: 실행하지 못했습니다.`;
      }
      return;
    }
    this.usage.add(this._layer?.id, slotId);   // 키별 사용 횟수 (2026-10-10)
    this.runner.notePhysical(slotId);
    const r = await this.runner.run(slotId, action, ctx);
    this.lastEventKo = r.ok ? `${actionLabel(action)} 실행` : `${actionLabel(action)}: ${r.reasonKo}`;
  }

  /** 앱 모드 입력: 키 n·노브·조이스틱 → 그 칸 (스펙 §1·§4). 키 11도 레이어 칸이다 (2026-10-05) */
  async _onAppIntent(intent) {
    const slotId = this._slotOf(intent);
    // 키 입력 재확인은 '지금 앞 앱' 기준 (기본 레이어도). Orca 레이어를 지웠으면 Orca도 기본 레이어를 쓴다 (2026-10-04)
    if (slotId) await this._runSlot(slotId, { kind: 'app', bundleId: this._front });
    this._changed();
  }

  /** 누른 순간 앞 앱을 다시 본다 — 앱을 막 바꿨으면 감시 주기(1초)를 기다리지 않고 새 레이어로 */
  async _refreshFront() {
    let front;
    try { front = await this.frontmost(); } catch { return; }
    if (!front || front === this._front || this.watcher.ignore.has(front)) return;
    this._front = front;
    this._reevaluateMode();
  }

  async _onIntent(intent) {
    // 반복을 시작한 키를 뗄 때 나오는 tap·hold는 이미 처리했다 (한 번 더 들어가지 않게)
    if ((intent.type === 'tap' || intent.type === 'hold') && this._consumed.delete(intent.key)) return;
    // 노브 길게 = 레이어 고르기 (2026-10-10). 열려 있으면 노브 돌림·누름은 고르기에 쓴다
    if (this._pickerIntent(intent)) return;
    await this._refreshFront();
    if (this.mode === 'app') {
      await this._onAppIntent(intent);
      return;
    }
    // Orca 모드의 노브·조이스틱은 Orca 레이어 칸 (내장은 Output, 단축키 등은 실행기 — 앞 앱=Orca 재확인).
    // 키 11·12·13도 레이어 칸이다 — 비어 있으면 아무것도 안 하고, 길게 누름도 아무것도 하지 않는다 (2026-10-05)
    const layerKey = (intent.type === 'tap' || intent.type === 'hold') && this.mode === 'orca'
      ? LOGICAL_KEY_SLOT[intent.key] ?? null : null;
    if (this.mode === 'orca' && (layerKey || intent.type === 'dial' || intent.type === 'joystick' || (intent.type === 'tap' && intent.key === 'dial_click'))) {
      if (intent.type !== 'hold') await this._runSlot(layerKey ?? this._slotOf(intent), { kind: 'app', bundleId: this._front });
      this.scheduler.requestRender();
      this._changed();
      return;
    }
    try {
      await this.dispatch(intent);
    } catch (err) {
      this._log(`입력 처리 실패: ${err.message}`, 'warn');
    }
    this.lastEventKo = this._describeResult(intent);
    this.scheduler.requestRender();
    this._changed();
  }

  _describeResult(intent) {
    const b = this.bridge;
    if (b.lastFocusFailure) return `이동 실패: ${b.lastFocusFailure.reasonKo}`;
    if (intent.key === 'ack' && b.lastAckResult) return b.lastAckResult.ok ? '확인했습니다' : `ACK: ${b.lastAckResult.reasonKo}`;
    return '';
  }

  // ───────────── 뷰

  health() {
    return {
      device: { state: this.guard.state, messageKo: this.guard.messageKo, connection: this.transport?.connection ?? null, ...this.power },
      orca: { state: this.orcaState, version: this.versions.orca, messageKo: this.orcaMessageKo },
      mock: false,
      active: this.bridge.active,
      permissions: { accessibility: this.accessibilityTrusted() },
      persistWarningKo: this.persistence?.adapter.lastWriteError ?? null,
    };
  }

  view() {
    const snapshot = this.bridge.render();
    const unitDetails = {};
    for (const u of this.store.allUnits()) {
      const agents = u.children.filter((c) => c.role === 'agent').map((c) => c.title);
      unitDetails[u.id] = { agentKo: agents.length ? `에이전트 ${agents.length}` : '' };
    }
    const v = buildStatusView({
      snapshot,
      health: this.health(),
      restoring: this.restoring,
      unitDetails,
    });
    v.layerLine = this._layerLine();
    v.suggestLayer = this._suggestLayer();
    // 지금 레이어의 키 그림 (2026-10-05): 장치에 보내는 장면 그대로의 LED 색. Orca 레이어만 [세션 | 키] 탭, 대기는 세션 목록만
    v.tabs = this.mode === 'orca';
    v.keyMap = this.mode === 'idle' ? null : buildKeyMap({
      mode: this.mode,
      scene: buildDeviceScene(snapshot, this.driver.capabilities, { overlays: this._ledOverlays() }),
      slots: this._slots,
      titles: snapshot.slots.map((x) => x.title),
      statuses: snapshot.slots.map((x) => (x.id ? x.labelKo : null)),
      hints: snapshot.slots.map((x) => (x.id ? STATUS_HINT_KO[x.status] ?? null : null)),
      color: this._layer?.color ?? null,
      joystick: joystickOf(this._layer),
    });
    // 지금 장치를 연 다른 앱을 찾았을 때만 (2026-10-10: 이미 끝난 실행의 늦은 응답으로 이름 없는 헛경고가 떴다)
    if (this.now() - this._shared.seenAt <= SHARED_QUIET_MS && this._shared.names.length) {
      const who = this._shared.names.join(', ');
      v.warnings.push({ code: 'device-shared', level: 'warn',
        messageKo: `${who}도 키보드를 쓰고 있습니다. LED 색이 섞이거나, 키를 누르면 ${who}에서도 동작할 수 있습니다. 함께 쓰지 않으려면 ${who}를 종료하세요.` });
    }
    if (this.fakeDevice) {
      v.warnings.unshift({ code: 'fake-device', level: 'info', messageKo: '가짜 장치로 실행 중입니다 (--fake-device). 실제 키보드에는 아무것도 보내지 않습니다.' });
    }
    if (!this.calibration.calibrated) {
      v.warnings.unshift({
        code: 'calibration', level: 'warn', action: 'open-setup',
        messageKo: '키 위치 보정이 없어 LED와 키 해석이 동작하지 않습니다. 설치 마법사에서 보정을 진행하세요.',
      });
    }
    if (this.transport && this.deviceInfo.layerIsOutput === false) {
      v.warnings.unshift({
        code: 'layer', level: 'warn', action: 'open-device',
        messageKo: `지금 장치 레이어가 '${this.deviceInfo.layerName ?? '알 수 없음'}'입니다. 설정 → 앱 정보 → 장치 준비를 실행하면 Output 레이어 하나로 맞춥니다.`,
      });
    }
    if (this.transport && this.deviceInfo.layerIsOutput === true && this.deviceInfo.layerNeedsUpgrade === true) {
      // 장치 준비는 남의 레이어(Input의 ChatGPT 프리셋 등)도 지우고 Output 하나로 맞춘다 (프리셋·장치 스펙 §4.2)
      v.warnings.unshift({
        code: 'layer-upgrade', level: 'warn', action: 'open-device',
        messageKo: OUR_LAYERS.includes(this.deviceInfo.layerName)
          ? '지금 레이어에 옛 키코드(ACT)가 있어 아래 7키 LED가 켜지지 않습니다. 설정 → 앱 정보 → 장치 준비를 실행하세요.'
          : `지금 장치 레이어 '${this.deviceInfo.layerName ?? '알 수 없음'}'는 Output 레이어가 아니어서 아래 7키 LED가 켜지지 않습니다. 설정 → 앱 정보 → 장치 준비를 실행하면 Output 레이어 하나로 맞춥니다.`,
      });
    }
    v.lastEventKo = this.lastEventKo;
    v.deviceLayerKo = this.deviceInfo.layerName;
    if (this.transport && this.deviceInfo.layerIsOutput === true && this.deviceInfo.dialHintKo) {
      v.warnings.push({ code: 'dial-hint', level: 'info', action: 'open-device', messageKo: this.deviceInfo.dialHintKo });
    }
    return v;
  }

  /** 지금 얹을 덧칠. 번쩍(press) 시간 안이면 press, 아니면 누르는 중이고 hold가 있으면 hold. 뗀 뒤 끝난 것은 지운다 */
  _ledOverlays() {
    const t = this.now();
    const out = {};
    for (const [k, st] of this._led) {
      const active = st.pressUntil > t ? st.press : (st.down && st.hold ? st.hold : null);
      if (active) out[k] = active;
      else if (!st.down) this._led.delete(k);
    }
    return out;
  }

  /** 상태판의 '지금' 줄과 레이어 목록 (2026-10-04): 앞 앱 → 고른 레이어, 활성/비활성 */
  _layerLine() {
    const appName = (bundleId) => {
      for (const l of this.layers) {
        const a = l.apps.find((x) => x.bundleId === bundleId);
        if (a) return a.name;
      }
      if (bundleId === this._front && this._frontName) return this._frontName;   // 실행 중 목록의 이름 (2026-10-10)
      return String(bundleId ?? '').split('.').pop() || '앞 앱';
    };
    const layer = this._layer;
    const nowKo = !layer ? '대기'
      : !this._front ? `${layer.name || '이름 없는'} 레이어 — 앞 앱 확인 전`
      : this._pin ? `${layer.name || '이름 없는'} 레이어 — 고정 (앞 앱 따르려면 '자동')`
      : layer ? `${layer.name || '이름 없는'} 레이어 — ${appName(this._front)} 앞`
        : `대기 — ${appName(this._front)}에 연결된 레이어 없음`;
    return {
      mode: this.mode,
      nowKo,
      pinned: Boolean(this._pin),   // 노브·상태판으로 고른 레이어 (2026-10-11)
      layers: this.layers.map((l) => ({ id: l.id, name: l.name || '이름 없음', color: l.color, active: layer?.id === l.id })),
    };
  }

  _changed() {
    this.emit('update');
  }

  _log(messageKo, level = 'info') {
    const entry = { at: this.now(), level, messageKo };
    this.logs.push(entry);
    if (this.logs.length > LOG_MAX) this.logs.splice(0, this.logs.length - LOG_MAX);
    this.emit('log', entry);
  }

  // ───────────── UI 명령 (IPC)

  /** 상태판에서 슬롯 줄을 눌렀다 — 이동만. 키 합성과 무관하다 */
  async focusSlot(n) {
    await this.bridge.focusSlotFromPanel(n);
    this.lastEventKo = this.bridge.lastFocusFailure ? `이동 실패: ${this.bridge.lastFocusFailure.reasonKo}` : `슬롯 ${n}로 이동`;
    this.scheduler.requestRender();
    this._changed();
  }

  /**
   * 설정 화면의 '지금 실행해 보기' (2026-10-10). 키 입력·앞 창 위치는 3초 기다린다 —
   * 그 사이 보낼 앱을 앞으로 가져온다 (설정 창에 보내지 않게). 나머지는 바로.
   */
  async actionTry(action) {
    const a = normalizeAction(action);
    if (a && ['shortcut', 'sequence', 'insertText', 'moveWindow'].includes(a.type)) await this.runner.sleep(TRY_WAIT_MS);
    return this.runner.run('-', a, { kind: 'any', bundleId: null }, { manual: true });
  }

  // ───────────── 진단

  diagnostics() {
    return buildDiagnostics({
      snapshot: this.bridge.render(),
      health: this.health(),
      versions: this.versions,
      logs: this.logs,
      home: os.homedir(),
      calibration: this.calibration,
    });
  }
}

// 나눈 메서드 묶음을 붙인다 (2026-10-10). 동작은 그대로 — 파일만 나눴다
for (const part of [KeyRepeatMethods, LayerStoreMethods, DeviceSetupMethods, HudPrefsMethods, LayerPickerMethods, SelfCheckMethods]) {
  for (const name of Object.getOwnPropertyNames(part.prototype)) {
    if (name !== 'constructor') Object.defineProperty(OutputService.prototype, name, Object.getOwnPropertyDescriptor(part.prototype, name));
  }
}
