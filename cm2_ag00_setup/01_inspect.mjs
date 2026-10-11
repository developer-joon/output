import {
  openDevice, readKeymap, resolveActive, matrixString, findAgentBindings
} from "./common.mjs";

const dev = await openDevice();
try {
  console.log("Creator Micro 2 — inspect");
  console.log("=========================\n");
  console.log(`Device: ${dev.info.product || "Creator Micro 2"}`);
  console.log(`PID: 0x${dev.info.productId.toString(16)}`);

  const version = await dev.call("sys.version");
  const status = await dev.call("device.status");
  console.log("\nFirmware:", JSON.stringify(version));
  console.log("Status:", JSON.stringify(status));

  const { config } = await readKeymap(dev);
  const active = resolveActive(config, status);
  const keymap = active.layer?.layout?.keymap;

  console.log(`\nActive profile index: ${active.profileIndex}`);
  console.log(`Active layer index: ${active.layerIndex} (device reports ${status.layer_index})`);
  console.log(`Layer name: ${active.layer?.name ?? "(unnamed)"}`);

  console.log("\nActive-layer keymap:");
  console.log(matrixString(keymap));

  const agents = findAgentBindings(keymap);
  console.log("\nAG bindings:");
  if (!agents.length) {
    console.log("  none");
  } else {
    for (const a of agents) {
      console.log(`  ${a.code} -> row ${a.row}, col ${a.col}`);
    }
  }

  console.log("\nPhysical note:");
  console.log("  Device matrix rows are 2 / 4 / 4 / 3.");
  console.log("  The top row is electrically reversed; row 0 col 0 is the top-right key.");
} finally {
  dev.close();
}
