import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const HID = require("node-hid");

export const VID = 0x303a;
export const PIDS = new Set([0x8297, 0x8298]);
export const USAGE_PAGE = 0xff00;
export const USAGE = 1;
export const REPORT_ID = 0x06;
export const CH_RPC = 2;
export const CH_DEBUG = 1;
export const CHUNK = 61;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function drainObjects(state) {
  const out = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < state.accum.length; i++) {
    const c = state.accum[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") {
      if (depth++ === 0) start = i;
    } else if (c === "}" && depth > 0 && --depth === 0) {
      try {
        out.push(JSON.parse(state.accum.slice(start, i + 1)));
        state.accum = state.accum.slice(i + 1);
        i = -1;
        start = -1;
      } catch {}
    }
  }
  if (state.accum.length > 16384) state.accum = "";
  return out;
}

export async function openDevice() {
  const devices = await Promise.resolve(HID.devices());
  const candidates = devices.filter(
    (d) =>
      d.vendorId === VID &&
      PIDS.has(d.productId) &&
      d.usagePage === USAGE_PAGE &&
      d.usage === USAGE
  );

  if (!candidates.length) {
    throw new Error(
      "Creator Micro 2 vendor HID interface not found (expected VID 303A, PID 8297/8298, usage page FF00, usage 1)."
    );
  }

  const info = candidates[0];
  const hid = new HID.HID(info.path, { nonExclusive: true });
  const pending = new Map();
  const state = { accum: "" };

  hid.on("data", (raw) => {
    const buf = Buffer.from(raw);

    // node-hid may return the report ID as byte 0 or may omit it.
    for (const off of [1, 0]) {
      const channel = buf[off];
      const len = buf[off + 1];
      if (channel !== CH_RPC && channel !== CH_DEBUG) continue;
      if (len === undefined || len > CHUNK) continue;

      const text = buf.slice(off + 2, off + 2 + len).toString("utf8");
      if (channel === CH_DEBUG) return;

      state.accum += text;
      for (const obj of drainObjects(state)) {
        if (obj?.id === undefined) continue; // notification or another envelope
        const waiter = pending.get(obj.id);
        if (!waiter) continue; // response to another shared client
        pending.delete(obj.id);
        clearTimeout(waiter.timer);

        if (obj.error) {
          const err = new Error(obj.error.message || "RPC error");
          err.code = obj.error.code;
          err.rpc = obj.error;
          waiter.reject(err);
        } else {
          waiter.resolve(obj.result);
        }
      }
      return;
    }
  });

  hid.on("error", (err) => {
    for (const [, waiter] of pending) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    pending.clear();
  });

  async function call(method, params = null, timeoutMs = 5000) {
    const id = Math.floor(Math.random() * 999);
    const payload = Buffer.from(JSON.stringify({ method, params, id }), "utf8");

    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
    });

    try {
      for (let off = 0; off < payload.length; off += CHUNK) {
        const n = Math.min(CHUNK, payload.length - off);
        const report = Buffer.alloc(64);
        report[0] = REPORT_ID;
        report[1] = CH_RPC;
        report[2] = n;
        payload.copy(report, 3, off, off + n);
        hid.write(Array.from(report));
      }
    } catch (err) {
      const waiter = pending.get(id);
      if (waiter) {
        clearTimeout(waiter.timer);
        pending.delete(id);
      }
      throw err;
    }

    return promise;
  }

  function close() {
    try { hid.close(); } catch {}
  }

  return { info, call, close };
}

export function resolveActive(config, status) {
  const profiles = Array.isArray(config?.profiles) ? config.profiles : [];
  if (!profiles.length) throw new Error("keymap.json has no profiles[]");

  let profileIndex = 0;
  const activeProfileId = config?.activeProfileId;

  if (activeProfileId !== undefined && activeProfileId !== null) {
    const byId = profiles.findIndex((p) => p?.id === activeProfileId);
    if (byId >= 0) profileIndex = byId;
    else if (
      Number.isInteger(Number(activeProfileId)) &&
      Number(activeProfileId) >= 0 &&
      Number(activeProfileId) < profiles.length
    ) {
      profileIndex = Number(activeProfileId);
    }
  } else if (
    Number.isInteger(Number(status?.profile_index)) &&
    Number(status.profile_index) >= 0 &&
    Number(status.profile_index) < profiles.length
  ) {
    profileIndex = Number(status.profile_index);
  }

  const layers = profiles[profileIndex]?.layers;
  if (!Array.isArray(layers) || !layers.length) {
    throw new Error(`profile ${profileIndex} has no layers[]`);
  }

  const reportedLayer = Number(status?.layer_index);
  const layerIndex =
    Number.isInteger(reportedLayer) &&
    reportedLayer >= 1 &&
    reportedLayer <= layers.length
      ? reportedLayer - 1
      : 0;

  return {
    profileIndex,
    layerIndex,
    profile: profiles[profileIndex],
    layer: layers[layerIndex],
  };
}

export function matrixString(keymap) {
  if (!Array.isArray(keymap)) return "(no keymap array)";
  return keymap
    .map((row, i) =>
      `row ${i}: ` +
      (Array.isArray(row) ? row.map((x) => String(x)).join(" | ") : "(invalid)")
    )
    .join("\n");
}

export function findAgentBindings(keymap) {
  const out = [];
  if (!Array.isArray(keymap)) return out;

  for (let row = 0; row < keymap.length; row++) {
    if (!Array.isArray(keymap[row])) continue;
    for (let col = 0; col < keymap[row].length; col++) {
      const code = String(keymap[row][col] ?? "");
      const m = /^KV_OAI_AG(\d{2})$/.exec(code);
      if (m) {
        out.push({ row, col, slot: Number(m[1]), code });
      }
    }
  }
  return out;
}

export async function readKeymap(dev) {
  const raw = await dev.call("fs.read", { file: "keymap.json" });
  if (!raw || typeof raw.data !== "string") {
    throw new Error("fs.read keymap.json returned an unexpected payload");
  }
  return { rawData: raw.data, config: JSON.parse(raw.data) };
}

export function normalizedJson(textOrObject) {
  const obj = typeof textOrObject === "string" ? JSON.parse(textOrObject) : textOrObject;
  return JSON.stringify(obj);
}
