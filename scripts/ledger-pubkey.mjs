// Read a base64 Ed25519 seed (the EARTHDECK_LEDGER_KEY format) on stdin, print its base64
// public key (the `ledger.pub` format). Used by the deploy scripts so a seed never appears
// in argv or on screen. Needs `pnpm build` (imports dist/).
import { keyFromSeed } from "../dist/ledger/checkpoint.js";

let s = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
  const seed = Buffer.from(s.trim(), "base64");
  if (seed.length !== 32) {
    process.stderr.write("ledger-pubkey: seed must be base64 of exactly 32 bytes\n");
    process.exit(1);
  }
  process.stdout.write(`${keyFromSeed(seed).publicRaw.toString("base64")}\n`);
});
