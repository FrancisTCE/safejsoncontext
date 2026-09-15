import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  clearKeyCache,
  createContext,
  isEncrypted,
  memoryKeyStore,
  osKeyStore,
} from "../dist/index.js";

const root = mkdtempSync(join(tmpdir(), "safejsoncontext-secure-"));
let counter = 0;

function scratch() {
  return join(root, `case-${counter++}`, "context.json");
}

/** A context with secrets declared and a fixed in-process key. */
function secure(options = {}, key = randomBytes(32)) {
  return createContext(scratch(), {
    encrypt: ["apiKey"],
    keystore: memoryKeyStore(key),
    ...options,
  });
}

after(() => {
  rmSync(root, { recursive: true, force: true });
});

test("declared secret fields are encrypted on every write path, no flag needed", () => {
  const ctx = secure();

  ctx.write({ model: "m", apiKey: "sk-via-write" });
  assert.ok(!readFileSync(ctx.path, "utf8").includes("sk-via-write"));

  ctx.set("apiKey", "sk-via-set");
  assert.ok(!readFileSync(ctx.path, "utf8").includes("sk-via-set"));

  ctx.update("apiKey", () => "sk-via-update-key");
  assert.ok(!readFileSync(ctx.path, "utf8").includes("sk-via-update-key"));

  ctx.update((doc) => ({ ...doc, apiKey: "sk-via-update-doc" }));
  assert.ok(!readFileSync(ctx.path, "utf8").includes("sk-via-update-doc"));

  const onDisk = readFileSync(ctx.path, "utf8");
  assert.ok(onDisk.includes('"apiKey"'), "the field name stays readable");
  assert.ok(onDisk.includes('"model":"m"'), "non-secret fields stay plain");
});

test("get refuses a secret field; reveal returns it", () => {
  const ctx = secure();
  ctx.set("apiKey", "sk-secret");

  const refused = ctx.get("apiKey");
  assert.equal(refused.ok, false);
  assert.match(refused.error.message, /reveal\("apiKey"\)/);

  assert.deepEqual(ctx.reveal("apiKey"), { ok: true, value: "sk-secret" });
  assert.deepEqual(ctx.has("apiKey"), { ok: true, value: true });
});

test("reveal of a plain field is just get", () => {
  const ctx = secure();
  ctx.set("model", "m");
  assert.deepEqual(ctx.reveal("model"), { ok: true, value: "m" });
});

test("read is censored by default and plaintext on request", () => {
  const ctx = secure();
  ctx.write({ model: "m", apiKey: "sk-secret" });

  const censored = ctx.read().value;
  assert.equal(censored.model, "m");
  assert.equal(isEncrypted(censored.apiKey), true);
  assert.ok(!JSON.stringify(censored).includes("sk-secret"));

  assert.deepEqual(ctx.read({ decrypt: true }).value, { model: "m", apiKey: "sk-secret" });
  assert.deepEqual(ctx.encryptedFields(), { ok: true, value: ["apiKey"] });
});

test("encrypt: true covers every top-level value of any JSON type", () => {
  const ctx = secure({ encrypt: true });
  const doc = { s: "str", n: 7, b: false, z: null, l: [1, { two: 2 }], o: { deep: "x" } };
  ctx.write(doc);

  const raw = JSON.parse(readFileSync(ctx.path, "utf8"));
  for (const field of Object.keys(doc)) assert.equal(isEncrypted(raw[field]), true, field);
  assert.deepEqual(ctx.read({ decrypt: true }).value, doc);
});

test("update(key) sees the plaintext of a secret field and re-encrypts with a fresh IV", () => {
  const ctx = secure();
  ctx.set("apiKey", "sk-1");
  const before = JSON.parse(readFileSync(ctx.path, "utf8")).apiKey;

  assert.deepEqual(ctx.update("apiKey", (k) => `${k}-rotated`), { ok: true, value: "sk-1-rotated" });

  const after = JSON.parse(readFileSync(ctx.path, "utf8")).apiKey;
  assert.notEqual(after.iv, before.iv);
  assert.deepEqual(ctx.reveal("apiKey"), { ok: true, value: "sk-1-rotated" });
});

test("touching a non-secret field never consults the key store", () => {
  const exploding = {
    id: "exploding",
    backend: "memory",
    exists: () => assert.fail("keystore touched"),
    ensure: () => assert.fail("keystore touched"),
    remove: () => assert.fail("keystore touched"),
  };
  const ctx = createContext(scratch(), { encrypt: ["apiKey"], keystore: exploding });

  // No secret present yet, so nothing to encrypt.
  assert.equal(ctx.set("runs", 1).ok, true);
  assert.equal(ctx.update("runs", (n) => n + 1).ok, true);
  assert.deepEqual(ctx.get("runs"), { ok: true, value: 2 });
});

test("an existing envelope passes through a non-secret mutation untouched", () => {
  const key = randomBytes(32);
  const ctx = secure({}, key);
  ctx.set("apiKey", "sk-secret");
  const before = JSON.parse(readFileSync(ctx.path, "utf8")).apiKey;

  // Same file, a store that would fail if asked for a key.
  const dead = memoryKeyStore();
  dead.remove();
  const other = createContext(ctx.path, { encrypt: ["apiKey"], keystore: dead });
  assert.equal(other.set("runs", 1).ok, true);

  assert.deepEqual(JSON.parse(readFileSync(ctx.path, "utf8")).apiKey, before);
  assert.deepEqual(ctx.reveal("apiKey"), { ok: true, value: "sk-secret" });
});

test("a different key cannot decrypt", () => {
  const ctx = secure();
  ctx.set("apiKey", "sk-secret");
  const intruder = createContext(ctx.path, { encrypt: ["apiKey"], keystore: memoryKeyStore() });
  assert.equal(intruder.reveal("apiKey").ok, false);
  assert.equal(intruder.read({ decrypt: true }).ok, false);
});

test("moving a ciphertext to another field, or flipping a bit, fails authentication", () => {
  const ctx = secure({ encrypt: true });
  ctx.write({ public: "harmless", apiKey: "sk-secret" });

  const raw = JSON.parse(readFileSync(ctx.path, "utf8"));
  writeFileSync(ctx.path, JSON.stringify({ public: raw.apiKey, apiKey: raw.public }));
  assert.equal(ctx.reveal("apiKey").ok, false);

  const bytes = Buffer.from(raw.apiKey.data, "base64");
  bytes[0] ^= 0xff;
  writeFileSync(ctx.path, JSON.stringify({ ...raw, apiKey: { ...raw.apiKey, data: bytes.toString("base64") } }));
  assert.equal(ctx.reveal("apiKey").ok, false);
});

test("a missing key is an error, never a silent plaintext write", () => {
  const dead = memoryKeyStore();
  dead.remove();
  const ctx = createContext(scratch(), { encrypt: ["apiKey"], keystore: dead });
  assert.equal(ctx.set("apiKey", "sk-secret").ok, false);
  assert.equal(ctx.exists(), false);
});

test("with a schema, mutations validate the plaintext and still encrypt", () => {
  const schema = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (v) =>
        typeof v.apiKey === "string" && v.apiKey.startsWith("sk-")
          ? { value: v }
          : { issues: [{ message: "must start with sk-", path: ["apiKey"] }] },
    },
  };
  const ctx = secure({ schema });

  assert.equal(ctx.set("apiKey", "nope").ok, false);
  assert.equal(ctx.exists(), false);

  assert.equal(ctx.set("apiKey", "sk-ok").ok, true);
  assert.ok(!readFileSync(ctx.path, "utf8").includes("sk-ok"));
  assert.deepEqual(ctx.read({ decrypt: true }).value, { apiKey: "sk-ok" });
  assert.equal(isEncrypted(ctx.read().value.apiKey), true, "censored read skips the schema");
});

test("async twins carry the same guarantees", async () => {
  const ctx = secure();
  assert.equal((await ctx.setAsync("apiKey", "sk-secret")).ok, true);
  assert.ok(!readFileSync(ctx.path, "utf8").includes("sk-secret"));
  assert.equal((await ctx.getAsync("apiKey")).ok, false);
  assert.deepEqual(await ctx.revealAsync("apiKey"), { ok: true, value: "sk-secret" });
  assert.deepEqual(await ctx.updateAsync("apiKey", async (k) => `${k}!`), { ok: true, value: "sk-secret!" });
  assert.deepEqual((await ctx.readAsync({ decrypt: true })).value, { apiKey: "sk-secret!" });
});

// The OS keychain is real state on the machine, so this uses its own service
// name and cleans up after itself. It is skipped where no keychain is reachable.
const keychain = () =>
  osKeyStore({ service: "safejsoncontext-test", account: `run-${process.pid}`, fallback: "none" });
const keychainReady = keychain().exists().ok;

test(
  "the OS keychain holds the key across store instances",
  { skip: keychainReady ? false : "no OS keychain on this machine" },
  (t) => {
    const store = keychain();
    t.after(() => {
      store.remove();
      clearKeyCache();
    });

    assert.deepEqual(store.exists(), { ok: true, value: false });
    assert.deepEqual(store.ensure(), { ok: true, value: true });
    assert.deepEqual(store.ensure(), { ok: true, value: false });

    const path = scratch();
    createContext(path, { encrypt: ["apiKey"], keystore: store }).set("apiKey", "sk-secret");
    assert.ok(!readFileSync(path, "utf8").includes("sk-secret"));

    clearKeyCache();
    const reopened = createContext(path, { encrypt: ["apiKey"], keystore: keychain() });
    assert.deepEqual(reopened.reveal("apiKey"), { ok: true, value: "sk-secret" });
  },
);

test("an unsupported platform falls back to a key file, same API", (t) => {
  const platform = process.platform;
  const dir = join(root, `fallback-${counter++}`);
  t.after(() => {
    Object.defineProperty(process, "platform", { value: platform });
    clearKeyCache();
  });

  Object.defineProperty(process, "platform", { value: "sunos" });
  clearKeyCache();

  const store = osKeyStore({ service: "sjc-fallback", fallbackDir: dir });
  assert.equal(store.backend, "file");

  const ctx = createContext(scratch(), { encrypt: ["apiKey"], keystore: store });
  ctx.set("apiKey", "sk-secret");
  assert.ok(!readFileSync(ctx.path, "utf8").includes("sk-secret"));

  clearKeyCache();
  const again = createContext(ctx.path, {
    encrypt: ["apiKey"],
    keystore: osKeyStore({ service: "sjc-fallback", fallbackDir: dir }),
  });
  assert.deepEqual(again.reveal("apiKey"), { ok: true, value: "sk-secret" });
  assert.deepEqual(store.remove(), { ok: true, value: true });
});
