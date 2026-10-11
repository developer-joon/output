import fs from "node:fs";
import path from "node:path";
import {
  openDevice, readKeymap, resolveActive, matrixString,
  findAgentBindings, normalizedJson, sleep
} from "./common.mjs";

const APPLY = process.argv.includes("--apply");
const TARGET_ROW = 1; // second row: no top-row reversal ambiguity
const TARGET_COL = 0; // left-most key on that row
const TARGET_CODE = "KV_OAI_AG00";

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const dev = await openDevice();
try {
  console.log("Creator Micro 2 — bind AG00");
  console.log("==========================\n");

  const status = await dev.call("device.status");
  const { rawData, config } = await readKeymap(dev);
  const active = resolveActive(config, status);
  const keymap = active.layer?.layout?.keymap;

  if (!Array.isArray(keymap)) throw new Error("active layer has no layout.keymap");

  console.log(`Active profile: ${active.profileIndex}`);
  console.log(`Active layer: ${active.layerIndex} (${active.layer?.name ?? "unnamed"})`);
  console.log("\nBefore:");
  console.log(matrixString(keymap));

  const existing = findAgentBindings(keymap).find((x) => x.code === TARGET_CODE);
  if (existing) {
    console.log(`\n${TARGET_CODE} already exists at row ${existing.row}, col ${existing.col}.`);
    console.log("No flash write is needed. Run: node 03_led_test.mjs");
    process.exit(0);
  }

  if (!Array.isArray(keymap[TARGET_ROW]) || TARGET_COL >= keymap[TARGET_ROW].length) {
    throw new Error("expected target matrix position row 1 col 0 does not exist");
  }

  const oldCode = keymap[TARGET_ROW][TARGET_COL];
  console.log(`\nPlanned change: row ${TARGET_ROW}, col ${TARGET_COL}`);
  console.log(`  ${oldCode}  ->  ${TARGET_CODE}`);
  console.log("This is the left-most key on the second physical row.");

  if (!APPLY) {
    console.log("\nDRY RUN ONLY — nothing was written.");
    console.log("To apply: node 02_bind_ag00.mjs --apply");
    process.exit(0);
  }

  const backupDir = path.resolve(process.cwd(), "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const backupBase = path.join(backupDir, `keymap-backup-${stamp()}`);
  const rawPath = `${backupBase}.raw.txt`;
  const prettyPath = `${backupBase}.json`;

  fs.writeFileSync(rawPath, rawData, "utf8");
  fs.writeFileSync(prettyPath, JSON.stringify(JSON.parse(rawData), null, 2), "utf8");

  if (!fs.existsSync(rawPath) || fs.statSync(rawPath).size === 0) {
    throw new Error("local backup could not be created; refusing to write device");
  }

  console.log(`\nBackup created:\n  ${rawPath}\n  ${prettyPath}`);

  keymap[TARGET_ROW][TARGET_COL] = TARGET_CODE;
  const newData = JSON.stringify(config);

  console.log("\nWriting keymap.json once...");
  await dev.call("fs.write", { file: "keymap.json", data: newData });
  await sleep(500);

  const after = await readKeymap(dev);
  const afterActive = resolveActive(after.config, await dev.call("device.status"));
  const afterMap = afterActive.layer?.layout?.keymap;
  const actual = afterMap?.[TARGET_ROW]?.[TARGET_COL];

  console.log("\nRead-back:");
  console.log(matrixString(afterMap));

  if (actual !== TARGET_CODE) {
    console.error(`\nVERIFY FAILED: expected ${TARGET_CODE}, got ${actual}`);
    console.error("Your backup is safe. Do not retry in a loop.");
    process.exitCode = 2;
  } else {
    console.log(`\nVERIFY OK: ${TARGET_CODE} is active at row ${TARGET_ROW}, col ${TARGET_COL}.`);
    console.log("Next: node 03_led_test.mjs");
  }
} finally {
  dev.close();
}
