import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { SchemaError, createContext } from "../dist/index.js";

const root = mkdtempSync(join(tmpdir(), "safejsoncontext-"));
let counter = 0;

/** A fresh file path in a not-yet-created directory per test. */
function scratch(name = "context.json") {
  return join(root, `case-${counter++}`, name);
}

after(() => {
  rmSync(root, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────── whole file

test("createContext resolves the file and its directory, touching nothing", () => {
  const path = scratch();
  const ctx = createContext(path);
  assert.equal(ctx.path, path);
  assert.equal(ctx.dir, join(path, ".."));
  assert.equal(ctx.exists(), false);
  assert.deepEqual(readdirSync(root).filter((d) => d.startsWith("case-")), []);
});

test("write creates the directory and the file atomically", () => {
  const ctx = createContext(scratch());
  assert.deepEqual(ctx.write({ a: 1 }), { ok: true, value: undefined });
  assert.equal(ctx.exists(), true);
  assert.equal(readFileSync(ctx.path, "utf8"), '{"a":1}');
  assert.deepEqual(readdirSync(ctx.dir), ["context.json"], "no temp or lock files left");
});

test("read of a missing file is undefined, or defaults when given", () => {
  assert.deepEqual(createContext(scratch()).read(), { ok: true, value: undefined });
  assert.deepEqual(createContext(scratch(), { defaults: { runs: 0 } }).read(), {
    ok: true,
    value: { runs: 0 },
  });
});

test("read of a corrupt or non-object file is an error, not a throw", () => {
  const ctx = createContext(scratch());
  ctx.write({ a: 1 });

  writeFileSync(ctx.path, "{ not json");
  assert.equal(ctx.read().ok, false);

  writeFileSync(ctx.path, "[1,2,3]");
  const result = ctx.read();
  assert.equal(result.ok, false);
  assert.match(result.error.message, /JSON object/);
});

test("init creates once from defaults and is a no-op after", () => {
  const ctx = createContext(scratch(), { defaults: { runs: 0, tags: [] } });
  assert.deepEqual(ctx.init(), { ok: true, value: true });
  assert.deepEqual(ctx.init(), { ok: true, value: false });
  assert.deepEqual(ctx.read().value, { runs: 0, tags: [] });

  const explicit = createContext(scratch());
  assert.deepEqual(explicit.init({ seeded: true }), { ok: true, value: true });
  assert.deepEqual(explicit.read().value, { seeded: true });
});

test("write refuses what JSON cannot represent and leaves no file", () => {
  const ctx = createContext(scratch());
  const circular = {};
  circular.self = circular;
  assert.equal(ctx.write(circular).ok, false);
  assert.equal(ctx.exists(), false);
});

test("remove reports whether there was a file", () => {
  const ctx = createContext(scratch());
  ctx.write({ a: 1 });
  assert.deepEqual(ctx.remove(), { ok: true, value: true });
  assert.deepEqual(ctx.remove(), { ok: true, value: false });
});

test("pretty, durable and a custom file name", () => {
  const ctx = createContext(scratch("state.json"), { pretty: true, durable: true });
  ctx.write({ a: 1 });
  assert.match(ctx.path, /state\.json$/);
  assert.equal(readFileSync(ctx.path, "utf8"), '{\n  "a": 1\n}');
});

// ─────────────────────────────────────────────────────────────── per field

test("get / set / has / delete on individual fields", () => {
  const ctx = createContext(scratch());

  assert.deepEqual(ctx.has("a"), { ok: true, value: false });
  assert.deepEqual(ctx.get("a"), { ok: true, value: undefined });

  assert.deepEqual(ctx.set("a", 1), { ok: true, value: undefined });
  assert.deepEqual(ctx.set("b", { nested: [1, 2] }), { ok: true, value: undefined });
  assert.deepEqual(ctx.has("a"), { ok: true, value: true });
  assert.deepEqual(ctx.get("a"), { ok: true, value: 1 });
  assert.deepEqual(ctx.get("b"), { ok: true, value: { nested: [1, 2] } });
  assert.deepEqual(ctx.read().value, { a: 1, b: { nested: [1, 2] } });

  assert.deepEqual(ctx.delete("a"), { ok: true, value: true });
  assert.deepEqual(ctx.delete("a"), { ok: true, value: false });
  assert.deepEqual(ctx.read().value, { b: { nested: [1, 2] } });
});

test("get falls back to defaults for a field the file does not have", () => {
  const ctx = createContext(scratch(), { defaults: { runs: 0, name: "x" } });
  ctx.write({ name: "y" }); // a file that predates the `runs` default
  assert.deepEqual(ctx.get("name"), { ok: true, value: "y" });
  assert.deepEqual(ctx.get("runs"), { ok: true, value: 0 });
  assert.deepEqual(ctx.has("runs"), { ok: true, value: false }, "has reports the file, not defaults");
});

test("a mutation on a missing file starts from the full defaults", () => {
  const ctx = createContext(scratch(), { defaults: { runs: 0, name: "x" } });
  ctx.set("name", "y");
  assert.deepEqual(ctx.read().value, { runs: 0, name: "y" });
});

test("update(key, fn) transforms from the current value or the default", () => {
  const ctx = createContext(scratch(), { defaults: { runs: 0 } });
  assert.deepEqual(ctx.update("runs", (n) => n + 1), { ok: true, value: 1 });
  assert.deepEqual(ctx.update("runs", (n) => n + 1), { ok: true, value: 2 });
  assert.deepEqual(ctx.read().value, { runs: 2 });
});

test("update(fn) transforms the whole document", () => {
  const ctx = createContext(scratch(), { defaults: { runs: 0 } });
  assert.deepEqual(ctx.update((doc) => ({ ...doc, runs: doc.runs + 1, extra: true })), {
    ok: true,
    value: { runs: 1, extra: true },
  });
  assert.equal(ctx.update(() => "not an object").ok, false);
});

test("a throwing callback is reported and the file is untouched", () => {
  const ctx = createContext(scratch());
  ctx.write({ a: 1 });
  assert.equal(ctx.update("a", () => { throw new Error("boom"); }).ok, false);
  assert.equal(ctx.update(() => { throw new Error("boom"); }).ok, false);
  assert.deepEqual(ctx.read().value, { a: 1 });
});

test("defaults are never mutated through the context", () => {
  const defaults = { list: [] };
  const ctx = createContext(scratch(), { defaults });
  ctx.update("list", (l) => { l.push("x"); return l; });
  ctx.update((doc) => { doc.list.push("y"); return doc; });
  assert.deepEqual(defaults, { list: [] });
  assert.deepEqual(ctx.get("list").value, ["x", "y"]);
});

// ─────────────────────────────────────────────────────────────── schema

/** A hand-rolled Standard Schema, so the tests need no zod. */
const counterSchema = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate(value) {
      if (typeof value !== "object" || value === null) {
        return { issues: [{ message: "expected an object" }] };
      }
      if (typeof value.runs !== "number") {
        return { issues: [{ message: "expected a number", path: ["runs"] }] };
      }
      // Schemas may transform: this one fills a missing label.
      return { value: { label: "counter", ...value } };
    },
  },
};

test("schema rejects invalid writes before they reach the disk", () => {
  const ctx = createContext(scratch(), { schema: counterSchema, defaults: { runs: 0 } });

  const bad = ctx.set("runs", "seven");
  assert.equal(bad.ok, false);
  assert.ok(bad.error instanceof SchemaError);
  assert.equal(bad.error.message, "runs: expected a number");
  assert.equal(ctx.exists(), false);

  assert.equal(ctx.update("runs", (n) => n + 1).ok, true);
  assert.deepEqual(ctx.read().value, { label: "counter", runs: 1 }, "schema output is what gets written");
});

test("schema validates reads too, so an externally edited file is caught", () => {
  const ctx = createContext(scratch(), { schema: counterSchema });
  ctx.write({ runs: 1 });
  writeFileSync(ctx.path, '{"runs":"tampered"}');
  const result = ctx.read();
  assert.equal(result.ok, false);
  assert.ok(result.error instanceof SchemaError);
});

test("an async-only schema is refused by the sync API and honoured by the async one", async () => {
  const asyncSchema = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: async (value) => ({ value }),
    },
  };
  const ctx = createContext(scratch(), { schema: asyncSchema });
  const sync = ctx.write({ a: 1 });
  assert.equal(sync.ok, false);
  assert.match(sync.error.message, /async API/);
  assert.equal((await ctx.writeAsync({ a: 1 })).ok, true);
});

// ─────────────────────────────────────────────────────────────── async

test("the async API mirrors the sync one", async () => {
  const ctx = createContext(scratch(), { defaults: { runs: 0 } });

  assert.equal(await ctx.existsAsync(), false);
  assert.deepEqual(await ctx.initAsync(), { ok: true, value: true });
  assert.deepEqual(await ctx.setAsync("name", "ada"), { ok: true, value: undefined });
  assert.deepEqual(await ctx.getAsync("name"), { ok: true, value: "ada" });
  assert.deepEqual(await ctx.hasAsync("name"), { ok: true, value: true });
  assert.deepEqual(await ctx.updateAsync("runs", async (n) => n + 1), { ok: true, value: 1 });
  assert.deepEqual(await ctx.updateAsync(async (d) => ({ ...d, runs: d.runs + 1 })), {
    ok: true,
    value: { runs: 2, name: "ada" },
  });
  assert.deepEqual(await ctx.deleteAsync("name"), { ok: true, value: true });
  assert.deepEqual(await ctx.readAsync(), { ok: true, value: { runs: 2 } });
  assert.deepEqual(await ctx.writeAsync({ runs: 9 }), { ok: true, value: undefined });
  assert.deepEqual(await ctx.removeAsync(), { ok: true, value: true });
  assert.equal(await ctx.existsAsync(), false);
});
