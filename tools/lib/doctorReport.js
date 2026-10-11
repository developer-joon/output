/**
 * doctor의 순수 로직 — 관측값을 받아 리포트와 capability 초안을 만든다.
 * 장치와 통신하지 않으므로 전부 단위 테스트 가능하다.
 */
import { LOGICAL_TO_AG } from '../../src/core/hardware.js';
import { agLabel } from './layout.js';
import { toHexString } from './ledRestore.js';

/** 관측 상태 값. 'unknown'이 기본이며 '미검증'과 '미지원'은 다르다. */
export const Obs = Object.freeze({
  YES: 'yes', NO: 'no', UNKNOWN: 'unknown', SKIPPED: 'skipped',
  UNCERTAIN: 'uncertain', NOT_FOUND: 'not_found', NEVER_PROBED: 'never_probed',
});

export const AG_KEYS = Object.freeze(
  Array.from({ length: 13 }, (_, i) => agLabel(i)),
);

/** keymap 칸 → 키코드. 칸은 문자열이거나 {keycode} 객체다. */
export function cellKeycode(cell) {
  return cell && typeof cell === 'object' ? cell.keycode : cell;
}

/** @returns {{family:string, index:number}|null} */
export function parseAgentKeycode(code) {
  const m = /^KV_OAI_(AG|ACT)(\d{2})$/.exec(String(code ?? ''));
  return m ? { family: m[1], index: Number(m[2]) } : null;
}

/** keymap 행렬에서 Output 키코드를 찾는다 (AG/ACT 양쪽). */
export function findAgentBindings(keymap) {
  const out = [];
  if (!Array.isArray(keymap)) return out;
  for (let row = 0; row < keymap.length; row += 1) {
    if (!Array.isArray(keymap[row])) continue;
    for (let col = 0; col < keymap[row].length; col += 1) {
      const cell = keymap[row][col];
      const code = String(cellKeycode(cell) ?? '');
      const parsed = parseAgentKeycode(code);
      if (!parsed) continue;
      out.push({
        row,
        col,
        code,
        family: parsed.family,
        index: parsed.index,
        // 계약은 논리 키를 AGnn 번호로 부른다. 번호를 정규 식별자로 쓴다.
        ag: agLabel(parsed.index),
        slot: parsed.index,
      });
    }
  }
  return out;
}

/**
 * 모든 프로필·레이어를 훑는다.
 * 활성 레이어에 AG가 없어도 다른 레이어에 있을 수 있다.
 * @returns {{profileIndex:number, profileId:*, layerIndex:number, layerName:string,
 *            rows:number[], bindings:object[], keymap:*}[]}
 */
export function scanAllLayers(config) {
  const out = [];
  const profiles = Array.isArray(config?.profiles) ? config.profiles : [];
  profiles.forEach((profile, profileIndex) => {
    const layers = Array.isArray(profile?.layers) ? profile.layers : [];
    layers.forEach((layer, layerIndex) => {
      const layout = layer?.layout ?? {};
      // 동반 앱 export는 base/encoders/joystick, 장치 keymap.json은 keymap을 쓴다.
      const keymap = layout.keymap ?? layout.base ?? null;
      out.push({
        profileIndex,
        profileId: profile?.id ?? null,
        layerIndex,
        layerName: layer?.name ?? '(이름 없음)',
        color: layer?.color ?? null,
        rows: Array.isArray(keymap) ? keymap.map((r) => (Array.isArray(r) ? r.length : 0)) : [],
        bindings: findAgentBindings(keymap),
        keymap,
        encoders: layout.encoders ?? null,
        joystick: layout.joystick ?? null,
        layoutFields: Object.keys(layout),
      });
    });
  });
  return out;
}

/**
 * 키코드 접두사 분포. AG가 어디에도 없을 때
 * '그럼 무엇이 들어 있는가'를 추측 없이 보여주기 위한 것이다.
 */
export function keycodePrefixes(keymap) {
  const counts = new Map();
  if (!Array.isArray(keymap)) return [];
  for (const row of keymap) {
    if (!Array.isArray(row)) continue;
    for (const cell of row) {
      const code = String(cellKeycode(cell) ?? '');
      const prefix = /^([A-Za-z]+_[A-Za-z]+)/.exec(code)?.[1] ?? code.slice(0, 8);
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/** 활성 프로필/레이어를 고른다 (common.mjs resolveActive 이식). */
export function resolveActive(config, status) {
  const profiles = Array.isArray(config?.profiles) ? config.profiles : [];
  if (!profiles.length) throw new Error('keymap.json에 profiles[]가 없습니다.');

  let profileIndex = 0;
  const activeProfileId = config?.activeProfileId;
  if (activeProfileId !== undefined && activeProfileId !== null) {
    const byId = profiles.findIndex((p) => p?.id === activeProfileId);
    if (byId >= 0) profileIndex = byId;
    else if (Number.isInteger(Number(activeProfileId))
      && Number(activeProfileId) >= 0 && Number(activeProfileId) < profiles.length) {
      profileIndex = Number(activeProfileId);
    }
  } else if (Number.isInteger(Number(status?.profile_index))
    && Number(status.profile_index) >= 0 && Number(status.profile_index) < profiles.length) {
    profileIndex = Number(status.profile_index);
  }

  const layers = profiles[profileIndex]?.layers;
  if (!Array.isArray(layers) || !layers.length) {
    throw new Error(`profile ${profileIndex}에 layers[]가 없습니다.`);
  }
  const reported = Number(status?.layer_index);
  const layerIndex = Number.isInteger(reported) && reported >= 1 && reported <= layers.length
    ? reported - 1 : 0;

  return { profileIndex, layerIndex, profile: profiles[profileIndex], layer: layers[layerIndex] };
}

/** 계약상 논리 매핑과 실제 바인딩을 대조한다. 계약을 고치지는 않는다. */
export function compareWithContract(bindings) {
  const byAg = new Map(bindings.map((b) => [b.ag, b]));
  return Object.entries(LOGICAL_TO_AG).map(([logical, ag]) => {
    const hit = byAg.get(ag) ?? null;
    return {
      logical,
      ag,
      // AG13~AG18(노브/조이스틱)은 LED 키가 아니므로 keymap에 없을 수 있다.
      expectedInKeymap: AG_KEYS.includes(ag),
      present: Boolean(hit),
      code: hit?.code ?? null,
      family: hit?.family ?? null,
      // 번호는 맞지만 계약이 가정한 접두사(AG)와 다른 경우
      familyDiffers: Boolean(hit) && hit.family !== 'AG',
    };
  });
}

/**
 * 읽기 전용 관측만으로 capability 초안을 만든다.
 * LED/입력은 이 단계에서 확인할 수 없으므로 전부 unknown이다.
 */
export function buildCapabilityDraft({ version, status, bindings, methodsSeen, observedAt }) {
  const keys = {};
  for (const ag of AG_KEYS) {
    const hit = bindings.find((b) => b.ag === ag) ?? null;
    keys[ag] = {
      boundInKeymap: Boolean(hit),
      keycode: hit?.code ?? null,
      family: hit?.family ?? null,
      led: Obs.UNKNOWN,
      press: Obs.UNKNOWN,
      release: Obs.UNKNOWN,
    };
  }
  const zoneMethod = methodsSeen.find((m) => /zone/i.test(m)) ?? null;
  return {
    version: 1,
    observedAt,
    method: 'doctor (읽기 전용)',
    device: {
      firmware: version ?? null,
      status: status ?? null,
    },
    keys,
    zones: {
      keysZone: zoneMethod ? Obs.UNKNOWN : Obs.NOT_FOUND,
      ambientZone: zoneMethod ? Obs.UNKNOWN : Obs.NOT_FOUND,
    },
    dial: { cw: Obs.UNKNOWN, ccw: Obs.UNKNOWN, click: Obs.UNKNOWN },
    joystick: {
      up: Obs.UNKNOWN, down: Obs.UNKNOWN, left: Obs.UNKNOWN, right: Obs.UNKNOWN,
    },
    miniLeds: Obs.NEVER_PROBED,
    notes: zoneMethod ? [] : ['zone 제어 RPC method가 발견되지 않음'],
  };
}

const pad = (s, n) => String(s ?? '').padEnd(n, ' ');

/** 한국어 리포트 본문. 관측하지 못한 것을 '정상'으로 쓰지 않는다. */
export function formatReport({
  info, version, status, active, keymap, bindings, contract, capability, ownership,
  allLayers = [], dumpKeymap = false,
}) {
  const L = [];
  L.push('Output doctor — 읽기 전용');
  L.push('================================');
  L.push('이 실행은 장치에 아무것도 쓰지 않습니다.');
  L.push('');
  L.push(`장치      ${info?.product ?? '(이름 없음)'} `
    + `(VID ${hex(info?.vendorId)} / PID ${hex(info?.productId)})`);
  L.push(`펌웨어    ${json(version)}`);
  L.push(`상태      ${json(status)}`);
  L.push(`소유권    ${ownership}`);
  L.push('');

  const rows = Array.isArray(keymap) ? keymap.map((r) => (Array.isArray(r) ? r.length : 0)) : [];
  L.push(`키맵 (활성 프로필 ${active.profileIndex} / 레이어 ${active.layerIndex}`
    + ` "${active.layer?.name ?? '이름 없음'}")`);
  L.push(`  행 구성: ${rows.join(' / ')}  (총 ${rows.reduce((a, b) => a + b, 0)}키)`);
  L.push(`  활성 레이어의 AG 바인딩: ${bindings.length}개`);
  for (const b of bindings) L.push(`    ${pad(b.code, 14)} → row ${b.row}, col ${b.col}`);
  if (!bindings.length) {
    const pre = keycodePrefixes(keymap);
    if (pre.length) {
      L.push(`    대신 들어 있는 키코드: ${pre.map(([k, n]) => `${k}×${n}`).join(', ')}`);
    }
  }
  L.push('');

  if (allLayers.length) {
    L.push('전체 프로필·레이어 스캔');
    const totalAg = allLayers.reduce((a, l) => a + l.bindings.length, 0);
    for (const l of allLayers) {
      const here = l.profileIndex === active.profileIndex && l.layerIndex === active.layerIndex;
      L.push(`  ${here ? '▶' : ' '} 프로필 ${l.profileIndex} / 레이어 ${l.layerIndex} `
        + `${pad(`"${l.layerName}"`, 22)} 키 ${l.rows.reduce((a, b) => a + b, 0)}개 `
        + `· AG ${l.bindings.length}개`
        + (l.color !== null && l.color !== undefined ? ` · 색 ${toHexString(l.color)}` : ' · 색 정보 없음')
        + (l.bindings.length ? ` (${l.bindings.map((b) => b.ag).join(' ')})` : ''));
    }
    if (totalAg === 0) {
      L.push('');
      L.push('  ⚠ 어떤 레이어에서도 KV_OAI_AG 키코드를 찾지 못했습니다.');
      L.push('    가능한 원인 (확인 전까지 단정하지 않습니다):');
      L.push('      1. 아직 AG를 바인딩하지 않았다');
      L.push('      2. 이 펌웨어에서 키코드 이름이 다르다');
      L.push('      3. 백업으로 되돌려 바인딩이 사라졌다');
      L.push('    원문을 보려면: node tools/doctor.mjs --dump-keymap');
    }
    L.push('');
  }

  L.push('논리 매핑 점검 (HARDWARE_CONTRACT.md 대비)');
  for (const c of contract) {
    const mark = !c.expectedInKeymap ? '해당 없음 (keymap 키가 아님)'
      : !c.present ? '⚠ 어느 레이어에서도 못 찾음'
        : c.familyDiffers ? `번호 일치 · 키코드는 ${c.code} — ACT는 LED 채널이 없음 (Input 프리셋 또는 옛 Output/Output 레이어)`
          : `계약과 일치 (${c.code})`;
    L.push(`  ${pad(c.logical, 14)} → ${pad(c.ag, 6)} ${mark}`);
  }
  const differing = contract.filter((c) => c.familyDiffers);
  if (differing.length) {
    L.push('');
    L.push(`  ℹ 키코드 계열이 둘로 나뉩니다 (실기 관측).`);
    L.push(`    KV_OAI_AG…  ${contract.filter((c) => c.family === 'AG').length}개 — `
      + contract.filter((c) => c.family === 'AG').map((c) => c.logical).join(' '));
    L.push(`    KV_OAI_ACT… ${differing.length}개 — ${differing.map((c) => c.logical).join(' ')}`);
    L.push('    HARDWARE_CONTRACT.md의 물리 역할과 번호는 그대로입니다.');
    L.push('    접두사 차이는 calibration에 기록합니다. 계약 문서를 고치지 않습니다.');
    L.push('    Output 레이어는 13키 전부 AG를 씁니다 (실기 16차). ACT 레이어에서는 아래 7키 LED가 켜지지 않습니다.');
  }
  L.push('  ⚠ 상단 행의 전기적 반전은 keymap 주석 기준입니다. 실물 확인이 필요합니다.');
  L.push('');

  const enc = allLayers.find((l) => l.encoders)?.encoders ?? null;
  const joy = allLayers.find((l) => l.joystick)?.joystick ?? null;
  L.push('노브 / 조이스틱 설정');
  if (!enc && !joy) {
    L.push('  장치 keymap 응답에 encoders / joystick 필드가 없습니다.');
    L.push(`  레이어가 담고 있는 필드: ${allLayers[0]?.layoutFields?.join(', ') ?? '(없음)'}`);
    L.push('  → 동반 앱 export에는 있으나 장치 응답에는 없을 수 있습니다. 미확인으로 둡니다.');
  } else {
    for (const l of allLayers) {
      if (!l.encoders && !l.joystick) continue;
      L.push(`  레이어 ${l.layerIndex} "${l.layerName}"`);
      if (l.encoders) {
        l.encoders.forEach((e, i) => {
          const codes = (Array.isArray(e) ? e : [e]).map(cellKeycode);
          L.push(`    엔코더 ${i}: ${codes.join(' | ')}`);
        });
      }
      if (l.joystick) {
        L.push(`    조이스틱: type=${l.joystick.type ?? '?'} `
          + `sectors=${Array.isArray(l.joystick.sectors) ? l.joystick.sectors.length : '?'}`);
        if (l.joystick.type === 'VENDOR') {
          L.push('      VENDOR 모드 — 방향별 키코드가 없습니다. 이벤트는 벤더 채널로 옵니다.');
          L.push('      → --input 으로 관측해야 확인됩니다.');
        }
      }
    }
  }
  L.push('');

  L.push('조명 zone 조사');
  L.push('  발견된 LED method: v.oai.thstatus (키 단위)');
  L.push(`  zone 제어 method: ${capability.notes.length ? '없음' : '있음'}`);
  if (capability.notes.length) {
    L.push('  → 백라이트/언더글로우는 계속 미지원으로 둡니다.');
    L.push('     키별 LED로 대체할지는 calibrate 이후 결정합니다.');
  }
  L.push('');

  L.push('이번 실행으로 확인되지 않은 항목');
  L.push('  · AG00~AG12 LED 독립 제어      → node tools/doctor.mjs --leds');
  L.push('  · 키 press/release 이벤트       → node tools/doctor.mjs --input');
  L.push('  · 노브 회전/클릭, 조이스틱 4방향 → 동일');
  L.push('  · mini LED — 조사하지 않습니다 (하드웨어 레이어 표시 전용)');
  L.push('');
  L.push('다음: 결과를 config/capability.json 으로 저장하려면 --save 를 붙여 실행하세요.');

  if (dumpKeymap && allLayers.length) {
    L.push('');
    L.push('── keymap 원문 ──');
    for (const l of allLayers) {
      L.push(`프로필 ${l.profileIndex} / 레이어 ${l.layerIndex} "${l.layerName}"`);
      if (!Array.isArray(l.keymap)) {
        L.push('  (keymap 배열 없음)');
        continue;
      }
      l.keymap.forEach((row, i) => {
        const cells = Array.isArray(row)
          ? row.map((x) => String(cellKeycode(x))).join(' | ')
          : '(형식 오류)';
        L.push(`  row ${i}: ${cells}`);
      });
      L.push(`  layout 필드: ${l.layoutFields.join(', ')}`);
      if (l.encoders) L.push(`  encoders: ${JSON.stringify(l.encoders)}`);
      if (l.joystick) L.push(`  joystick: ${JSON.stringify(l.joystick)}`);
    }
  }
  return L.join('\n');
}

function hex(n) {
  return typeof n === 'number' ? `0x${n.toString(16)}` : '?';
}

function json(v) {
  if (v === null || v === undefined) return '(응답 없음)';
  return typeof v === 'string' ? v : JSON.stringify(v);
}
