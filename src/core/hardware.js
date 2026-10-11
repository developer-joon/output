// HARDWARE_CONTRACT.md 물리 배치의 읽기 전용 사본.
// 이 파일은 계약을 '표현'만 한다. 재배치/재해석 금지.

export const PHYSICAL_ROWS = Object.freeze([
  Object.freeze(['dial', 'slot1', 'slot2', 'joystick']),
  Object.freeze(['slot3', 'slot4', 'slot5', 'slot6']),
  Object.freeze(['slot7', 'slot8', 'slot9', 'slot10']),
  Object.freeze(['mini_led_x3', 'attention', 'ack', 'mode_back']),
]);

export const LOGICAL_TO_AG = Object.freeze({
  slot1: 'AG01',
  slot2: 'AG00',
  slot3: 'AG02',
  slot4: 'AG03',
  slot5: 'AG04',
  slot6: 'AG05',
  slot7: 'AG06',
  slot8: 'AG07',
  slot9: 'AG08',
  slot10: 'AG09',
  attention: 'AG10',
  ack: 'AG11',
  mode_back: 'AG12',
  dial_cw: 'AG13',
  dial_ccw: 'AG14',
  joystick_up: 'AG15',
  joystick_left: 'AG16',
  joystick_down: 'AG17',
  joystick_right: 'AG18',
});

// 키 1~10이 모두 작업 칸이다 (2026-10-01, 이전에는 6칸 + A1~A4)
export const SLOTS_PER_BANK = 10;

// Dial press는 hardware 검증 전까지 optional capability. 추측 매핑 금지.
export const DIAL_PRESS_AG = null;

// MINI LED x3는 hardware layer indicator 전용.
export const MINI_LED_PURPOSE = 'hardware_layer_indicator_only';
