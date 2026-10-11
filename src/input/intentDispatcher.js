/**
 * 입력 의도 → Output 호출.
 * doctor --live 와 앱 서비스가 같은 규칙을 쓴다. (tools/lib/liveSession.js에서 옮김)
 */
export function makeDispatcher(bridge) {
  return function dispatch(intent) {
    if (intent.type === 'tap' || intent.type === 'hold') {
      const slot = /^slot(10|[1-9])$/.exec(intent.key);
      if (slot) {
        return intent.type === 'hold'
          ? bridge.longPressSlot(Number(slot[1]))
          : bridge.pressSlot(Number(slot[1]));
      }
      if (intent.key === 'attention') {
        return intent.type === 'hold' ? bridge.longPressAttention() : bridge.pressAttention();
      }
      if (intent.key === 'ack') return bridge.pressAck();
      if (intent.key === 'mode_back') {
        return intent.type === 'hold' ? bridge.longPressModeBack() : bridge.pressModeBack();
      }
      if (intent.key === 'dial_click') return bridge.dialPress({ hardwareValidated: true });
    }
    // 앱 서비스는 Orca 모드의 조이스틱·노브를 레이어 칸으로 먼저 처리한다 (레이어 2026-10-03).
    // 여기는 레이어가 없는 진단 도구(doctor --live)용 고정 동작이다.
    if (intent.type === 'joystick') {
      const fixed = { up: 'attention', down: 'next_unseen', left: 'prev_bank', right: 'next_bank' }[intent.direction];
      return fixed ? bridge.runBuiltin(fixed) : null;
    }
    if (intent.type === 'dial') return bridge.runBuiltin(intent.direction === 'cw' ? 'next_session' : 'prev_session');
    return null;
  };
}

