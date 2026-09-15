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
const ctx = createContext(file("basics"), { defaults: { model: "claude-opus-5", turns: 0 } });
show("ctx.path", ctx.path);
show("ctx.exists()", ctx.exists());
show("ctx.read()                          // missing file reads as defaults", ctx.read());

section("init — create from defaults, no-op if present");
show("ctx.init()", ctx.init());
show("ctx.init()", ctx.init());
disk(ctx);

section("per-field: set / get / has / delete");
show("ctx.set('turns', 1)", ctx.set("turns", 1));
show("ctx.set('tools', ['search_docs', 'run_tests'])", ctx.set("tools", ["search_docs", "run_tests"]));
show("ctx.get('turns')", ctx.get("turns"));
show("ctx.get('tools')", ctx.get("tools"));
show("ctx.has('tools')", ctx.has("tools"));
show("ctx.delete('tools')", ctx.delete("tools"));
show("ctx.delete('tools')                 // already gone", ctx.delete("tools"));
disk(ctx);

section("update — one field from its current value, or the whole document");
show("ctx.update('turns', (n) => n + 1)", ctx.update("turns", (n) => n + 1));
show("ctx.update('turns', (n) => n + 1)", ctx.update("turns", (n) => n + 1));
show("ctx.update((doc) => ({ ...doc, compacted: true }))", ctx.update((doc) => ({ ...doc, compacted: true })));

section("whole file: read / write / remove");
show("ctx.read()", ctx.read());
show("ctx.write({ model: 'claude-sonnet-5' })", ctx.write({ model: "claude-sonnet-5" }));
disk(ctx);
show("ctx.remove()", ctx.remove());
show("ctx.remove()", ctx.remove());

section("failure modes — always a result, never a throw");
const broken = createContext(file("broken"));
broken.write({ turns: 1 });
writeFileSync(broken.path, "{ not json");
show("broken.read()                       // corrupt file", broken.read());
writeFileSync(broken.path, "[1,2]");
show("broken.get('turns')                 // not an object", broken.get("turns"));
const circular = {};
circular.self = circular;
show("ctx.set('memory', circular)", ctx.set("memory", circular));
show("ctx.update('turns', () => { throw })", ctx.update("turns", () => { throw new Error("boom"); }));
show("ctx.update(() => 'not an object')", ctx.update(() => "not an object"));

section("async twins — same names, same results");
const a = createContext(file("async"), { defaults: { turns: 0 } });
show("await ctx.initAsync()", await a.initAsync());
show("await ctx.setAsync('model', 'claude-opus-5')", await a.setAsync("model", "claude-opus-5"));
show("await ctx.updateAsync('turns', async (n) => n + 1)", await a.updateAsync("turns", async (n) => n + 1));
show("await ctx.getAsync('turns')", await a.getAsync("turns"));
show("await ctx.readAsync()", await a.readAsync());
show("await ctx.removeAsync()", await a.removeAsync());

// ─────────────────────────────────────────────────────────────── schema

section("schema — types for autocomplete, validation on every write and read");
const schema = {
  "~standard": {
    version: 1,
    vendor: "hand-rolled", // zod / valibot / arktype all implement this interface
    validate: (v) =>
      typeof v?.turns === "number"
        ? { value: v }
        : { issues: [{ message: "expected a number", path: ["turns"] }] },
  },
};
const typed = createContext(file("typed"), { schema, defaults: { turns: 0 } });
show("typed.set('turns', 'seven')          // rejected before it hits the disk", typed.set("turns", "seven"));
show("typed.exists()", typed.exists());
show("typed.set('turns', 7)", typed.set("turns", 7));
writeFileSync(typed.path, '{"turns":"edited by hand"}');
show("typed.read()                         // an external edit is caught on read", typed.read());

// ─────────────────────────────────────────────────────────────── locking

section("lock — every mutation is exclusive across processes");
const shared = createContext(file("shared"), { defaults: { turns: 0 } });
shared.init();
const racer = join(shared.dir, "racer.mjs");
writeFileSync(
  racer,
  `import { createContext } from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
   const ctx = createContext(process.argv[2], { defaults: { turns: 0 }, lock: process.argv[3] === "off" ? false : {} });
   for (let i = 0; i < 25; i++) await ctx.updateAsync("turns", (n) => n + 1);`,
);
const race = async (mode) => {
  shared.write({ turns: 0 });
  await Promise.all(Array.from({ length: 4 }, () => run(process.execPath, [racer, shared.path, mode]).catch(() => {})));
  return shared.get("turns").value;
};
show("4 agent processes × 25 turns, lock off", `${await race("off")} / 100  (lost updates)`);
show("4 agent processes × 25 turns, lock on ", `${await race("on")} / 100`);
show("readdirSync(dir)                     // nothing left behind", readdirSync(shared.dir));

section("lock — stale detection and timeouts");
const locked = createContext(file("locked"), { lock: { timeout: 200 } });
locked.init();
writeFileSync(lockPathFor(locked.path), `4194311\n${Date.now()}\n`); // a pid that cannot exist
show("// lock file from a dead agent process:\nlocked.set('turns', 1)", locked.set("turns", 1));
writeFileSync(lockPathFor(locked.path), `${process.pid}\n${Date.now()}\n`);
show("// lock file from a live process, 200 ms timeout:\nlocked.set('turns', 2)", locked.set("turns", 2));
rmSync(lockPathFor(locked.path));

section("lock — a sync call cannot wait on an async one in the same process");
let release;
const gate = new Promise((r) => (release = r));
const pending = locked.updateAsync("turns", async (v) => { await gate; return v + 1; });
await new Promise((r) => setTimeout(r, 10));
show("locked.set('tools', [])              // while updateAsync is in flight", locked.set("tools", []));
release();
show("await pending", await pending);
show("locked.set('tools', [])              // fine once it settles", locked.set("tools", []));

// ─────────────────────────────────────────────────────────────── sessions

section("session — the same API, in memory, gone with the process");
const session = createSessionContext("thread-42", {
  encrypt: ["userToken"],
  defaults: { turn: 0, toolCalls: [] },
});
show("session.path", session.path);
show("session.keystore.backend             // process-local key, no keychain", session.keystore.backend);
show("session.set('userToken', 'ya29.…')", session.set("userToken", "ya29.a0Ae-end-user-oauth"));
show("session.update('turn', (n) => n + 1)", session.update("turn", (n) => n + 1));
show("session.update('toolCalls', (c) => [...c, 'search_docs'])", session.update("toolCalls", (c) => [...c, "search_docs"]));
show("session.get('userToken')", session.get("userToken"));
show("session.reveal('userToken')", session.reveal("userToken"));
show("session.read()                       // censored, safe to put in a trace", session.read());
show("createSessionContext('thread-42').get('turn')   // same thread, same document", createSessionContext("thread-42").get("turn"));
show("createSessionContext('thread-43').exists()      // different thread, nothing", createSessionContext("thread-43").exists());
show("hasSession('thread-42')", hasSession("thread-42"));
show("dropSession('thread-42')", dropSession("thread-42"));
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
  defaults: { model: "claude-opus-5", turns: 0, memory: [], apiKey: "" },
});
show("agent.set('apiKey', 'sk-ant-DO-NOT-LOG')", agent.set("apiKey", "sk-ant-DO-NOT-LOG"));
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
show("agent.update('memory', (m) => [...m, 'prefers metric'])", agent.update("memory", (m) => [...m, "prefers metric"]));
show("isEncrypted(agent.read().value.apiKey)", isEncrypted(agent.read().value.apiKey));

section("everything that should fail, does");
const raw = safeParse(readFileSync(agent.path, "utf8")).value;
const swapped = createContext(file("swapped"), { encrypt: true, keystore: store });
swapped.write({ memory: "harmless", apiKey: "sk-ant-secret" });
const s = safeParse(readFileSync(swapped.path, "utf8")).value;
writeFileSync(swapped.path, JSON.stringify({ memory: s.apiKey, apiKey: s.memory }));
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
