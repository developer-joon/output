// Output 키 입력 (2026-10-09, 미디어 키 2026-10-10). 함수 다섯, 상태 없음. 예외를 던지지 않고 false·null로 알린다.
#import <AppKit/AppKit.h>
#include <ApplicationServices/ApplicationServices.h>
#include <Carbon/Carbon.h>
#include <napi.h>

static Napi::Value Post(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsNumber() || !info[2].IsBoolean()) return Napi::Boolean::New(env, false);
  int32_t code = info[0].As<Napi::Number>().Int32Value();
  if (code < 0 || code > 127) return Napi::Boolean::New(env, false);
  uint64_t flags = (uint64_t)info[1].As<Napi::Number>().Int64Value();
  bool down = info[2].As<Napi::Boolean>().Value();
  CGEventSourceRef src = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
  CGEventRef ev = CGEventCreateKeyboardEvent(src, (CGKeyCode)code, down);
  if (!ev) { if (src) CFRelease(src); return Napi::Boolean::New(env, false); }
  CGEventSetFlags(ev, (CGEventFlags)flags);
  CGEventPost(kCGHIDEventTap, ev);
  CFRelease(ev);
  if (src) CFRelease(src);
  return Napi::Boolean::New(env, true);
}

// 미디어 키 (2026-10-10): 재생·볼륨 같은 NX 시스템 키. 키보드의 미디어 키와 같은 NSSystemDefined 이벤트(subtype 8)
static Napi::Value PostMedia(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) return Napi::Boolean::New(env, false);
  int32_t key = info[0].As<Napi::Number>().Int32Value();
  if (key < 0 || key > 31) return Napi::Boolean::New(env, false);
  for (int down = 1; down >= 0; down -= 1) {
    NSEvent* e = [NSEvent otherEventWithType:NSEventTypeSystemDefined location:NSZeroPoint
                               modifierFlags:(down ? 0xa00 : 0xb00) timestamp:0 windowNumber:0 context:nil
                                     subtype:8 data1:((key << 16) | ((down ? 0xa : 0xb) << 8)) data2:-1];
    if (!e || ![e CGEvent]) return Napi::Boolean::New(env, false);
    CGEventPost(kCGHIDEventTap, [e CGEvent]);
  }
  return Napi::Boolean::New(env, true);
}

// 숫자 키패드 키 코드 (kVK_ANSI_Keypad*)
static bool IsKeypad(UInt16 code) {
  switch (code) {
    case 65: case 67: case 69: case 71: case 75: case 76: case 78: case 81: case 82: case 83: case 84:
    case 85: case 86: case 87: case 88: case 89: case 91: case 92: return true;
    default: return false;
  }
}

// 지금 쓰는 영문(ASCII 가능) 자판에서 이 글자를 내는 키를 찾는다. 한글 입력 중에도 ⌘C가 ⌘C가 되게
static Napi::Value KeyCodeFor(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) return env.Null();
  std::u16string want = info[0].As<Napi::String>().Utf16Value();
  if (want.size() != 1) return env.Null();
  TISInputSourceRef source = TISCopyCurrentASCIICapableKeyboardLayoutInputSource();
  if (!source) return env.Null();
  CFDataRef data = (CFDataRef)TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData);
  Napi::Value result = env.Null();
  if (data) {
    const UCKeyboardLayout* layout = (const UCKeyboardLayout*)CFDataGetBytePtr(data);
    const UInt32 mods[2] = { 0, (shiftKey >> 8) & 0xFF };
    // 본 자판(Shift 포함)을 먼저, 숫자 키패드는 마지막에 — '*'가 키패드 *가 아니라 Shift+8이 되게 (osascript와 같음)
    for (int pad = 0; pad < 2 && result.IsNull(); pad++) {
      for (int m = 0; m < 2 && result.IsNull(); m++) {
        for (UInt16 code = 0; code < 128; code++) {
          if (IsKeypad(code) != (pad == 1)) continue;
          UInt32 dead = 0; UniChar chars[4]; UniCharCount len = 0;
          if (UCKeyTranslate(layout, code, kUCKeyActionDown, mods[m], LMGetKbdType(), kUCKeyTranslateNoDeadKeysMask, &dead, 4, &len, chars) != noErr) continue;
          if (len == 1 && chars[0] == want[0]) {
            Napi::Object o = Napi::Object::New(env);
            o.Set("keyCode", Napi::Number::New(env, code));
            o.Set("shift", Napi::Boolean::New(env, m == 1));
            result = o;
            break;
          }
        }
      }
    }
  }
  CFRelease(source);
  return result;
}

// 시스템 설정 → 키보드의 '반복 지연'·'키 반복 속도' (초 → 밀리초)
static Napi::Value RepeatTiming(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object o = Napi::Object::New(env);
  o.Set("delayMs", Napi::Number::New(env, [NSEvent keyRepeatDelay] * 1000.0));
  o.Set("intervalMs", Napi::Number::New(env, [NSEvent keyRepeatInterval] * 1000.0));
  return o;
}

static Napi::Value Trusted(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), AXIsProcessTrusted());
}

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("post", Napi::Function::New(env, Post));
  exports.Set("keyCodeFor", Napi::Function::New(env, KeyCodeFor));
  exports.Set("repeatTiming", Napi::Function::New(env, RepeatTiming));
  exports.Set("trusted", Napi::Function::New(env, Trusted));
  exports.Set("postMedia", Napi::Function::New(env, PostMedia));
  return exports;
}

NODE_API_MODULE(keysynth, Init)
