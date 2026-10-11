import fs from "node:fs";
import path from "node:path";
import {
  openDevice, readKeymap, normalizedJson, sleep
} from "./common.mjs";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const backupArg = args.find((x) => !x.startsWith("--"));

function newestBackup() {
  const dir = path.resolve(process.cwd(), "backups");
  if (!fs.existsSync(dir)) return null;

  const files = fs.readdirSync(dir)
    .filter((x) => /^keymap-backup-.*\.raw\.txt$/.test(x))
    .map((x) => path.join(dir, x))
    .sort()
    .reverse();

  return files[0] ?? null;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const backupPath = backupArg ? path.resolve(backupArg) : newestBackup();

if (!backupPath || !fs.existsSync(backupPath)) {
  console.error("No backup found.");
  console.error("Usage: node 04_restore.mjs [backups/keymap-backup-....raw.txt] --apply");
  process.exit(2);
}

const restoreData = fs.readFileSync(backupPath, "utf8");
JSON.parse(restoreData); // refuse malformed backups

console.log("Creator Micro 2 — restore keymap");
console.log("===============================\n");
console.log("Restore source:", backupPath);

if (!APPLY) {
  console.log("\nDRY RUN ONLY — nothing was written.");
  console.log("To restore: node 04_restore.mjs --apply");
  console.log("Or specify a backup: node 04_restore.mjs <backup.raw.txt> --apply");
  process.exit(0);
}

const dev = await openDevice();
try {
  // Back up the current device state before restoring an older backup.
  const current = await readKeymap(dev);
  const dir = path.resolve(process.cwd(), "backups");
  fs.mkdirSync(dir, { recursive: true });
  const preRestore = path.join(dir, `pre-restore-${stamp()}.raw.txt`);
  fs.writeFileSync(preRestore, current.rawData, "utf8");
  console.log("Current device keymap backed up to:", preRestore);

  console.log("\nWriting restore data once...");
  await dev.call("fs.write", { file: "keymap.json", data: restoreData });
  await sleep(500);

  const after = await readKeymap(dev);

  if (normalizedJson(after.rawData) !== normalizedJson(restoreData)) {
    console.error("\nVERIFY FAILED: device keymap does not match the selected backup.");
    process.exitCode = 3;
  } else {
    console.log("\nVERIFY OK: keymap restored successfully.");
  }
} finally {
  dev.close();
}
