/**
 * snapshot을 외부에서 변형할 수 없게 만든다 (C16).
 * Store는 snapshot과 객체를 공유하지 않으므로, 이 동결은 소비자 실수를 막는 용도다.
 */
export function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze(value[key], seen);
  }
  return Object.freeze(value);
}
