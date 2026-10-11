import { FakeTransport } from './transport/fakeTransport.js';
import { prepareDevice } from '../keymap/keymapModel.js';
import { RUNTIME_METHODS } from './deviceDriver.js';
import { WRITE_METHODS } from '../keymap/deviceWriter.js';

/**
 * 가짜 장치 한 쌍 (--fake-device): sudo·권한 없이 전체 흐름을 보여줄 때.
 * 런타임은 fs.write가 막혀 있고, 쓰기용 transport로 쓴 keymap을 런타임이 다시 읽는다 — 실기와 같은 규칙.
 */
export function fakeDevicePair() {
  const base = {
    activeProfileId: 0,
    profiles: [{ id: 0, layers: [{
      name: 'VS Code', color: 16711680,
      lights: { backlight: { effect: 'solid', brightness: 1, speed: 0.5, magic: 1, color: '#FFFFFF' },
        underglow: { effect: 'rainbow', brightness: 1, speed: 0.55, magic: 1, color: '#FFFFFF' } },
      layout: {
        keymap: [['KC_F13', 'KC_F14'], ['KC_A', 'KC_B', 'KA_0', 'KC_D'], ['KC_F1', 'KC_F2', 'KC_F3', 'KC_F4'], ['KC_ENT', 'KC_ESC', 'KC_DEL']],
        encoders: [[{ keycode: 'KC_VOLU' }, { keycode: 'KC_VOLD' }, { keycode: 'KC_MUTE' }]],
        joystick: { type: 'RADIAL', sectors: [] },
      },
    }] }],
  };
  const dev = { text: JSON.stringify(prepareDevice(base).config) };
  const read = () => ({ data: dev.text });
  const runtime = () => new FakeTransport({
    allowedMethods: [...RUNTIME_METHODS], blockedMethods: ['fs.write'],
    responses: {
      'sys.version': { version: '0.6.2 (가짜)' },
      'device.status': { profile_index: 0, layer_index: 2 },
      'fs.read': read,
      'v.oai.thstatus': { ok: 1 },
    },
  });
  const writer = () => new FakeTransport({
    allowedMethods: [...WRITE_METHODS],
    responses: { 'fs.read': read, 'fs.write': (p) => { dev.text = p.data; return { ok: 1 }; } },
  });
  return { runtime, writer };
}
