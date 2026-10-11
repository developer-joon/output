import {
  openDevice, readKeymap, resolveActive, findAgentBindings, sleep
} from "./common.mjs";

const dev = await openDevice();
try {
  console.log("Creator Micro 2 — AG00 LED test");
  console.log("===============================\n");

  const status = await dev.call("device.status");
  const { config } = await readKeymap(dev);
  const active = resolveActive(config, status);
  const keymap = active.layer?.layout?.keymap;
  const ag00 = findAgentBindings(keymap).find((x) => x.code === "KV_OAI_AG00");

  console.log(`Active layer: ${active.layerIndex} (${active.layer?.name ?? "unnamed"})`);

  if (!ag00) {
    console.error("\nKV_OAI_AG00 is NOT present on the active layer.");
    console.error("Run: node 02_bind_ag00.mjs --apply");
    process.exitCode = 2;
  } else {
    console.log(`AG00 found at row ${ag00.row}, col ${ag00.col}.`);
    console.log("\nVisible test starts now.");
    console.log("RED -> OFF -> GREEN -> OFF -> BLUE -> OFF -> WHITE -> OFF -> MAGENTA");
    console.log("Repeated 3 times at full brightness.\n");

    const colors = [
      ["RED", 0xff0000],
      ["GREEN", 0x00ff00],
      ["BLUE", 0x0000ff],
      ["WHITE", 0xffffff],
      ["MAGENTA", 0xff00ff],
    ];

    for (let round = 1; round <= 3; round++) {
      console.log(`Round ${round}/3`);
      for (const [name, color] of colors) {
        console.log(`  ${name}`);
        await dev.call("v.oai.thstatus", [
          { id: 0, c: color, b: 1, e: 1, s: 0.5, sk: 0, sa: 0 }
        ]);
        await sleep(1000);

        await dev.call("v.oai.thstatus", [
          { id: 0, c: 0, b: 0, e: 0, s: 0.5, sk: 0, sa: 0 }
        ]);
        await sleep(350);
      }
    }

    console.log("\nLeaving AG00 solid yellow for 5 seconds as a final obvious marker...");
    await dev.call("v.oai.thstatus", [
      { id: 0, c: 0xffff00, b: 1, e: 1, s: 0.5, sk: 0, sa: 0 }
    ]);
    await sleep(5000);

    await dev.call("v.oai.thstatus", [
      { id: 0, c: 0, b: 0, e: 0, s: 0.5, sk: 0, sa: 0 }
    ]);

    console.log("\nDone.");
  }
} finally {
  dev.close();
}
