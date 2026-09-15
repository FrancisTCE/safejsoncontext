// Rough throughput check for the sync paths. Numbers are only meaningful
// relative to each other on the same machine and filesystem.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createContext, memoryKeyStore } from "../dist/index.js";

const ITERATIONS = Number(process.argv[2] ?? 2000);
const dir = mkdtempSync(join(tmpdir(), "safejsoncontext-bench-"));
const payload = {
  id: "ctx",
  updatedAt: Date.now(),
  items: Array.from({ length: 50 }, (_, i) => ({ i })),
};

function bench(label, fn) {
  fn(); // warm up the path and the JIT
  const started = process.hrtime.bigint();
  for (let i = 0; i < ITERATIONS; i++) fn();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  const opsPerSecond = Math.round((ITERATIONS / ms) * 1000);
  console.log(
    `${label.padEnd(34)} ${ms.toFixed(1).padStart(8)} ms  ${String(opsPerSecond).padStart(9)} ops/s`,
  );
}

const locked = createContext(join(dir, "locked.json"));
const unlocked = createContext(join(dir, "unlocked.json"), { lock: false });
const durable = createContext(join(dir, "durable.json"), { durable: true });
const secret = createContext(join(dir, "secret.json"), {
  encrypt: ["token"],
  keystore: memoryKeyStore(),
});
locked.write(payload);
unlocked.write(payload);
secret.write({ ...payload, token: "sk-bench" });

console.log(`${ITERATIONS} iterations in ${dir}\n`);
bench("read (no lock, ever)", () => locked.read());
bench("get(key)", () => locked.get("id"));
bench("write (lock + atomic rename)", () => locked.write(payload));
bench("write (lock: false)", () => unlocked.write(payload));
bench("set(key)", () => locked.set("updatedAt", 1));
bench("update(key, fn)", () => locked.update("updatedAt", (t) => t + 1));
bench("set(key) on a plain field, secrets present", () => secret.set("updatedAt", 1));
bench("set(secret) — AES-GCM per write", () => secret.set("token", "sk-bench"));
bench("reveal(secret)", () => secret.reveal("token"));
bench("write (durable, fsync)", () => durable.write(payload));

rmSync(dir, { recursive: true, force: true });
