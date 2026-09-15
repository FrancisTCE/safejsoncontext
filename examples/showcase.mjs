// Every operation the library offers, run for real against a temp directory.
//   node examples/showcase.mjs
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  clearKeyCache,
  createContext,
  createSessionContext,
  dropSession,
  hasSession,
  isEncrypted,
  lockPathFor,
  memoryKeyStore,
  osKeyStore,
  safeParse,
} from "../dist/index.js";

const run = promisify(execFile);
const root = mkdtempSync(join(tmpdir(), "safejsoncontext-showcase-"));
let n = 0;
const file = (name) => join(root, `${++n}-${name}`, "context.json");

const section = (title) =>
  console.log(`\n\x1b[1m\x1b[36m── ${title} ${"─".repeat(Math.max(0, 62 - title.length))}\x1b[0m`);
const show = (call, value) => console.log(`  \x1b[2m${call}\x1b[0m\n    → ${format(value)}`);
const disk = (ctx) =>
  console.log(`  \x1b[2mon disk\x1b[0m\n    │ ${readFileSync(ctx.path, "utf8").replaceAll("\n", "\n    │ ")}`);

function format(value) {
  if (value instanceof Error) return `\x1b[31m${value.name}: ${value.message}\x1b[0m`;
  if (value && typeof value === "object" && "ok" in value) {
    return value.ok
      ? `\x1b[32m{ ok: true, value: ${format(value.value)} }\x1b[0m`
      : `\x1b[31m{ ok: false, error: ${value.error.name}: ${value.error.message} }\x1b[0m`;
  }
  return JSON.stringify(value) ?? String(value);
}

// ─────────────────────────────────────────────────────────────── the handle

section("createContext — a file path; nothing touches the disk yet");
const ctx = createContext(file("basics"), { defaults: { user: "ada", runs: 0 } });
show("ctx.path", ctx.path);
show("ctx.exists()", ctx.exists());
show("ctx.read()                          // missing file reads as defaults", ctx.read());

section("init — create from defaults, no-op if present");
show("ctx.init()", ctx.init());
show("ctx.init()", ctx.init());
disk(ctx);

section("per-field: set / get / has / delete");
show("ctx.set('runs', 1)", ctx.set("runs", 1));
show("ctx.set('tags', ['a', 'b'])", ctx.set("tags", ["a", "b"]));
show("ctx.get('runs')", ctx.get("runs"));
show("ctx.get('tags')", ctx.get("tags"));
show("ctx.has('tags')", ctx.has("tags"));
show("ctx.delete('tags')", ctx.delete("tags"));
show("ctx.delete('tags')                  // already gone", ctx.delete("tags"));
disk(ctx);

section("update — one field from its current value, or the whole document");
show("ctx.update('runs', (n) => n + 1)", ctx.update("runs", (n) => n + 1));
show("ctx.update('runs', (n) => n + 1)", ctx.update("runs", (n) => n + 1));
show("ctx.update((doc) => ({ ...doc, seen: true }))", ctx.update((doc) => ({ ...doc, seen: true })));

section("whole file: read / write / remove");
show("ctx.read()", ctx.read());
show("ctx.write({ user: 'bob' })", ctx.write({ user: "bob" }));
disk(ctx);
show("ctx.remove()", ctx.remove());
show("ctx.remove()", ctx.remove());

section("failure modes — always a result, never a throw");
const broken = createContext(file("broken"));
broken.write({ a: 1 });
writeFileSync(broken.path, "{ not json");
show("broken.read()                       // corrupt file", broken.read());
writeFileSync(broken.path, "[1,2]");
show("broken.get('a')                     // not an object", broken.get("a"));
const circular = {};
circular.self = circular;
show("ctx.set('x', circular)", ctx.set("x", circular));
show("ctx.update('runs', () => { throw })", ctx.update("runs", () => { throw new Error("boom"); }));
show("ctx.update(() => 'not an object')", ctx.update(() => "not an object"));

section("async twins — same names, same results");
const a = createContext(file("async"), { defaults: { runs: 0 } });
show("await ctx.initAsync()", await a.initAsync());
show("await ctx.setAsync('user', 'ada')", await a.setAsync("user", "ada"));
show("await ctx.updateAsync('runs', async (n) => n + 1)", await a.updateAsync("runs", async (n) => n + 1));
show("await ctx.getAsync('runs')", await a.getAsync("runs"));
show("await ctx.readAsync()", await a.readAsync());
show("await ctx.removeAsync()", await a.removeAsync());

// ─────────────────────────────────────────────────────────────── schema

section("schema — types for autocomplete, validation on every write and read");
const schema = {
  "~standard": {
    version: 1,
    vendor: "hand-rolled", // zod / valibot / arktype all implement this interface
    validate: (v) =>
      typeof v?.runs === "number"
        ? { value: v }
        : { issues: [{ message: "expected a number", path: ["runs"] }] },
  },
};
const typed = createContext(file("typed"), { schema, defaults: { runs: 0 } });
show("typed.set('runs', 'seven')           // rejected before it hits the disk", typed.set("runs", "seven"));
show("typed.exists()", typed.exists());
show("typed.set('runs', 7)", typed.set("runs", 7));
writeFileSync(typed.path, '{"runs":"edited by hand"}');
show("typed.read()                         // an external edit is caught on read", typed.read());

// ─────────────────────────────────────────────────────────────── locking

section("lock — every mutation is exclusive across processes");
const shared = createContext(file("shared"), { defaults: { count: 0 } });
shared.init();
const racer = join(shared.dir, "racer.mjs");
writeFileSync(
  racer,
  `import { createContext } from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
   const ctx = createContext(process.argv[2], { defaults: { count: 0 }, lock: process.argv[3] === "off" ? false : {} });
   for (let i = 0; i < 25; i++) await ctx.updateAsync("count", (n) => n + 1);`,
);
const race = async (mode) => {
  shared.write({ count: 0 });
  await Promise.all(Array.from({ length: 4 }, () => run(process.execPath, [racer, shared.path, mode]).catch(() => {})));
  return shared.get("count").value;
};
show("4 processes × 25 increments, lock off", `${await race("off")} / 100  (lost updates)`);
show("4 processes × 25 increments, lock on ", `${await race("on")} / 100`);
show("readdirSync(dir)                     // nothing left behind", readdirSync(shared.dir));

section("lock — stale detection and timeouts");
const locked = createContext(file("locked"), { lock: { timeout: 200 } });
locked.init();
writeFileSync(lockPathFor(locked.path), `4194311\n${Date.now()}\n`); // a pid that cannot exist
show("// lock file from a dead process:\nlocked.set('a', 1)", locked.set("a", 1));
writeFileSync(lockPathFor(locked.path), `${process.pid}\n${Date.now()}\n`);
show("// lock file from a live process, 200 ms timeout:\nlocked.set('a', 2)", locked.set("a", 2));
rmSync(lockPathFor(locked.path));

section("lock — a sync call cannot wait on an async one in the same process");
let release;
const gate = new Promise((r) => (release = r));
const pending = locked.updateAsync("a", async (v) => { await gate; return v + 1; });
await new Promise((r) => setTimeout(r, 10));
show("locked.set('b', 1)                   // while updateAsync is in flight", locked.set("b", 1));
release();
show("await pending", await pending);
show("locked.set('b', 1)                   // fine once it settles", locked.set("b", 1));

// ─────────────────────────────────────────────────────────────── sessions

section("session — the same API, in memory, gone with the process");
const session = createSessionContext("agent-42", { encrypt: ["token"], defaults: { turns: 0 } });
show("session.path", session.path);
show("session.keystore.backend             // process-local key, no keychain", session.keystore.backend);
show("session.set('token', 'sk-live-51')", session.set("token", "sk-live-51"));
show("session.update('turns', (n) => n + 1)", session.update("turns", (n) => n + 1));
show("session.get('token')", session.get("token"));
show("session.reveal('token')", session.reveal("token"));
show("session.read()                       // censored, safe to hand around", session.read());
show("createSessionContext('agent-42').get('turns')   // same name, same document", createSessionContext("agent-42").get("turns"));
show("createSessionContext('agent-43').exists()       // different name, nothing", createSessionContext("agent-43").exists());
show("hasSession('agent-42')", hasSession("agent-42"));
show("dropSession('agent-42')", dropSession("agent-42"));
show("session.exists()                     // handle now reads as empty", session.exists());

// ─────────────────────────────────────────────────────────────── encryption

section("keystore — where the AES key lives");
const store = osKeyStore({ service: "safejsoncontext-showcase", account: `demo-${process.pid}` });
show("store.backend", store.backend);
show("store.exists()", store.exists());
show("store.ensure()                      // generated a 256-bit key", store.ensure());
console.log("  \x1b[2mthere is no store.getKey(): key material is not reachable from the public API\x1b[0m");

section("encrypt — declared once on the handle, applied to every write path");
const agent = createContext(file("agent"), {
  encrypt: ["apiKey"],
  keystore: store,
  defaults: { model: "claude-opus-5", apiKey: "" },
});
show("agent.set('apiKey', 'sk-live-51-DO-NOT-LOG')", agent.set("apiKey", "sk-live-51-DO-NOT-LOG"));
disk(agent);

section("get refuses a secret; reveal is the one deliberate, greppable way in");
show("agent.get('model')", agent.get("model"));
show("agent.get('apiKey')", agent.get("apiKey"));
show("agent.reveal('apiKey')", agent.reveal("apiKey"));
show("agent.read()                        // censored", agent.read());
show("agent.read({ decrypt: true })", agent.read({ decrypt: true }));
show("agent.encryptedFields()", agent.encryptedFields());

section("update on a secret sees plaintext, re-encrypts with a fresh IV");
const before = safeParse(readFileSync(agent.path, "utf8")).value.apiKey.iv;
show("agent.update('apiKey', (k) => k + '-rotated')", agent.update("apiKey", (k) => `${k}-rotated`));
show("iv changed", before !== safeParse(readFileSync(agent.path, "utf8")).value.apiKey.iv);

section("touching a plain field leaves the envelope alone — and never asks for the key");
show("agent.set('model', 'claude-sonnet-5')", agent.set("model", "claude-sonnet-5"));
show("isEncrypted(agent.read().value.apiKey)", isEncrypted(agent.read().value.apiKey));

section("everything that should fail, does");
const raw = safeParse(readFileSync(agent.path, "utf8")).value;
const swapped = createContext(file("swapped"), { encrypt: true, keystore: store });
swapped.write({ public: "harmless", apiKey: "sk-live-51" });
const s = safeParse(readFileSync(swapped.path, "utf8")).value;
writeFileSync(swapped.path, JSON.stringify({ public: s.apiKey, apiKey: s.public }));
show("// ciphertexts swapped between fields:\nswapped.reveal('apiKey')", swapped.reveal("apiKey"));
const bytes = Buffer.from(raw.apiKey.data, "base64");
bytes[0] ^= 0xff;
writeFileSync(agent.path, JSON.stringify({ ...raw, apiKey: { ...raw.apiKey, data: bytes.toString("base64") } }));
show("// one bit flipped:\nagent.reveal('apiKey')", agent.reveal("apiKey"));
writeFileSync(agent.path, JSON.stringify(raw));
show(
  "// a different key:\ncreateContext(same, { keystore: memoryKeyStore() }).reveal('apiKey')",
  createContext(agent.path, { encrypt: ["apiKey"], keystore: memoryKeyStore() }).reveal("apiKey"),
);

section("the key really comes back from the OS, not from memory");
clearKeyCache();
const reopened = createContext(agent.path, {
  encrypt: ["apiKey"],
  keystore: osKeyStore({ service: "safejsoncontext-showcase", account: `demo-${process.pid}` }),
});
show("clearKeyCache(); createContext(...).reveal('apiKey')", reopened.reveal("apiKey"));

section("removing the key makes the ciphertext unreadable, for good");
show("store.remove()", store.remove());
clearKeyCache();
const orphan = createContext(agent.path, {
  encrypt: ["apiKey"],
  keystore: osKeyStore({ service: "safejsoncontext-showcase", account: `demo-${process.pid}`, fallback: "none" }),
});
show("orphan.reveal('apiKey')", orphan.reveal("apiKey"));
show("orphan.get('model')                  // plain fields still work", orphan.get("model"));
orphan.keystore.remove(); // the reveal minted a replacement key; a demo leaves nothing behind

console.log(`\n\x1b[2mscratch dir removed: ${root}\x1b[0m`);
rmSync(root, { recursive: true, force: true });
