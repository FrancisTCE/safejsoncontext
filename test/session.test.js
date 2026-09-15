import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";

import {
  createSessionContext,
  dropSession,
  hasSession,
  isEncrypted,
  memoryKeyStore,
  sessionNames,
} from "../dist/index.js";

let counter = 0;
const name = () => `session-${process.pid}-${counter++}`;

test("a session is identified by a memory:// path and nothing is on disk", () => {
  const n = name();
  const ctx = createSessionContext(n);
  assert.equal(ctx.path, `memory://${n}`);
  assert.equal(ctx.dir, "memory://");
  assert.equal(ctx.exists(), false);
  assert.equal(existsSync(ctx.path), false);
  assert.equal(existsSync(n), false);
});

test("the whole per-field and whole-document API works in memory", () => {
  const ctx = createSessionContext(name(), { defaults: { runs: 0 } });

  assert.deepEqual(ctx.read(), { ok: true, value: { runs: 0 } });
  assert.deepEqual(ctx.init(), { ok: true, value: true });
  assert.deepEqual(ctx.init(), { ok: true, value: false });
  assert.deepEqual(ctx.set("name", "ada"), { ok: true, value: undefined });
  assert.deepEqual(ctx.update("runs", (n) => n + 1), { ok: true, value: 1 });
  assert.deepEqual(ctx.update((d) => ({ ...d, seen: true })), {
    ok: true,
    value: { runs: 1, name: "ada", seen: true },
  });
  assert.deepEqual(ctx.get("name"), { ok: true, value: "ada" });
  assert.deepEqual(ctx.has("seen"), { ok: true, value: true });
  assert.deepEqual(ctx.delete("seen"), { ok: true, value: true });
  assert.deepEqual(ctx.read(), { ok: true, value: { runs: 1, name: "ada" } });
  assert.deepEqual(ctx.write({ runs: 9 }), { ok: true, value: undefined });
  assert.deepEqual(ctx.remove(), { ok: true, value: true });
  assert.deepEqual(ctx.remove(), { ok: true, value: false });
  assert.equal(ctx.exists(), false);
});

test("handles with the same name share one document; different names do not", () => {
  const shared = name();
  const a = createSessionContext(shared);
  const b = createSessionContext(shared);
  const other = createSessionContext(name());

  a.set("x", 1);
  assert.deepEqual(b.get("x"), { ok: true, value: 1 });
  assert.deepEqual(other.get("x"), { ok: true, value: undefined });
  assert.equal(other.exists(), false);
});

test("values are copied in and out, never aliased into the store", () => {
  const ctx = createSessionContext(name());
  const list = [1, 2];
  ctx.set("list", list);
  list.push(3);
  assert.deepEqual(ctx.get("list").value, [1, 2]);

  const out = ctx.get("list").value;
  out.push(99);
  assert.deepEqual(ctx.get("list").value, [1, 2]);
});

test("JSON semantics match a file: circular refused, functions dropped", () => {
  const ctx = createSessionContext(name());
  const circular = {};
  circular.self = circular;
  assert.equal(ctx.set("a", circular).ok, false);
  assert.equal(ctx.exists(), false);

  // JSON.stringify drops a function-valued field, exactly as it would on disk.
  assert.equal(ctx.set("fn", () => {}).ok, true);
  assert.deepEqual(ctx.read().value, {});
});

test("secrets are encrypted in memory under a process-local key by default", () => {
  const ctx = createSessionContext(name(), { encrypt: ["token"] });
  assert.equal(ctx.keystore.backend, "memory");

  ctx.set("token", "sk-secret");
  assert.equal(ctx.get("token").ok, false);
  assert.equal(isEncrypted(ctx.read().value.token), true);
  assert.ok(!JSON.stringify(ctx.read().value).includes("sk-secret"));
  assert.deepEqual(ctx.reveal("token"), { ok: true, value: "sk-secret" });

  // Every session in the process shares that key, so envelopes travel between them.
  const twin = createSessionContext(name(), { encrypt: ["token"] });
  twin.write(ctx.read().value);
  assert.deepEqual(twin.reveal("token"), { ok: true, value: "sk-secret" });
});

test("a custom keystore is honoured", () => {
  const key = memoryKeyStore();
  const ctx = createSessionContext(name(), { encrypt: ["token"], keystore: key });
  ctx.set("token", "sk-secret");
  const stranger = createSessionContext(ctx.path.slice("memory://".length), {
    encrypt: ["token"],
    keystore: memoryKeyStore(),
  });
  assert.equal(stranger.reveal("token").ok, false);
});

test("a schema validates in memory too", () => {
  const schema = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (v) =>
        typeof v.runs === "number"
          ? { value: v }
          : { issues: [{ message: "expected a number", path: ["runs"] }] },
    },
  };
  const ctx = createSessionContext(name(), { schema, defaults: { runs: 0 } });
  assert.equal(ctx.set("runs", "x").ok, false);
  assert.equal(ctx.exists(), false);
  assert.equal(ctx.set("runs", 1).ok, true);
});

test("async calls serialise, and a sync call during one fails fast", async () => {
  const ctx = createSessionContext(name(), { defaults: { count: 0 } });
  await Promise.all(Array.from({ length: 25 }, () => ctx.updateAsync("count", (n) => n + 1)));
  assert.deepEqual(ctx.get("count"), { ok: true, value: 25 });

  let release;
  const gate = new Promise((r) => (release = r));
  const pending = ctx.updateAsync("count", async (n) => {
    await gate;
    return n + 1;
  });
  await new Promise((r) => setTimeout(r, 10));
  const sync = ctx.set("count", 0);
  assert.equal(sync.ok, false);
  assert.match(sync.error.message, /in flight in this process/);
  release();
  assert.deepEqual(await pending, { ok: true, value: 26 });
});

test("the registry: hasSession, sessionNames, dropSession", () => {
  const n = name();
  assert.equal(hasSession(n), false);
  const ctx = createSessionContext(n);
  assert.equal(hasSession(n), true);
  assert.ok(sessionNames().includes(n));

  ctx.set("a", 1);
  assert.equal(dropSession(n), true);
  assert.equal(dropSession(n), false);
  assert.equal(hasSession(n), false);

  // The old handle now reads as empty; a new handle with the name starts fresh.
  assert.equal(ctx.exists(), false);
  assert.deepEqual(createSessionContext(n).get("a"), { ok: true, value: undefined });
});
