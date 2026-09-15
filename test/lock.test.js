import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";

import { createContext, lockPathFor } from "../dist/index.js";
import { _linkSupported, _setLinkSupport, lockSync } from "../dist/lock.js";

const run = promisify(execFile);
const bump = join(dirname(new URL(import.meta.url).pathname), "helpers", "bump.mjs")
  .replace(/^\\([A-Za-z]:)/, "$1"); // file:///C:/... → C:/... on Windows

const root = mkdtempSync(join(tmpdir(), "safejsoncontext-lock-"));
let counter = 0;
const scratch = () => join(root, `case-${counter++}`, "context.json");

after(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Spawn `processes` children, each bumping `iterations` times, and count. */
async function stress(path, processes, iterations, mode) {
  const children = Array.from({ length: processes }, () =>
    run(process.execPath, [bump, path, String(iterations), mode]),
  );
  const outputs = await Promise.all(children);
  const reported = outputs.reduce((sum, { stdout }) => sum + Number(stdout), 0);
  assert.equal(reported, processes * iterations, "every child completed every increment");
  return createContext(path).get("count").value;
}

test("no increments are lost across processes — async API", { timeout: 60_000 }, async () => {
  const path = scratch();
  mkdirSync(dirname(path), { recursive: true });
  assert.equal(await stress(path, 6, 40, "async"), 240);
  assert.deepEqual(readdirSync(dirname(path)), ["context.json"], "no lock or temp files left");
});

test("no increments are lost across processes — sync API", { timeout: 60_000 }, async () => {
  const path = scratch();
  mkdirSync(dirname(path), { recursive: true });
  assert.equal(await stress(path, 6, 40, "sync"), 240);
});

test("without the lock, concurrent processes do lose increments", { timeout: 60_000 }, async () => {
  // Same race, lock disabled: proves the stress test above would catch a fault.
  const path = scratch();
  mkdirSync(dirname(path), { recursive: true });
  const script = `
    import { createContext } from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
    const ctx = createContext(process.argv[2], { defaults: { count: 0 }, lock: false });
    for (let i = 0; i < 40; i++) await ctx.updateAsync("count", (n) => n + 1);
  `;
  const file = join(dirname(path), "racer.mjs");
  writeFileSync(file, script);
  await Promise.all(
    Array.from({ length: 6 }, () => run(process.execPath, [file, path]).catch(() => {})),
  );
  const final = createContext(path).get("count").value ?? 0;
  assert.ok(final < 240, `expected lost updates without a lock, got ${final}/240`);
});

test("a stale lock left by a dead process is broken, not waited on", () => {
  const ctx = createContext(scratch(), { lock: { timeout: 500, stale: 60_000 } });
  mkdirSync(ctx.dir, { recursive: true });
  // pid 2^22 + 7 is far above any real pid on every platform.
  writeFileSync(lockPathFor(ctx.path), `4194311\n${Date.now()}\n`);

  const started = Date.now();
  assert.deepEqual(ctx.set("a", 1), { ok: true, value: undefined });
  assert.ok(Date.now() - started < 400, "did not wait for the timeout");
});

test("a lock older than `stale` is broken even if its pid is alive", () => {
  const ctx = createContext(scratch(), { lock: { timeout: 500, stale: 50 } });
  mkdirSync(ctx.dir, { recursive: true });
  const lock = lockPathFor(ctx.path);
  writeFileSync(lock, `${process.pid}\n${Date.now()}\n`);
  const old = (Date.now() - 5_000) / 1000;
  utimesSync(lock, old, old); // age is judged by mtime, not by the payload
  assert.deepEqual(ctx.set("a", 1), { ok: true, value: undefined });
});

test("an empty lock file — payload not yet written — is a live lock, not garbage", () => {
  const ctx = createContext(scratch(), { lock: { timeout: 150, stale: 60_000 } });
  mkdirSync(ctx.dir, { recursive: true });
  writeFileSync(lockPathFor(ctx.path), "");
  const result = ctx.set("a", 1);
  assert.equal(result.ok, false, "must wait for it, then time out, never break it");
  assert.equal(ctx.exists(), false);
});

test("a live lock is waited on, then times out with a useful message", () => {
  const ctx = createContext(scratch(), { lock: { timeout: 150, stale: 60_000 } });
  mkdirSync(ctx.dir, { recursive: true });
  writeFileSync(lockPathFor(ctx.path), `${process.pid}\n${Date.now()}\n`);

  const started = Date.now();
  const result = ctx.set("a", 1);
  assert.equal(result.ok, false);
  assert.match(result.error.message, /Timed out after 150 ms .*pid \d+/);
  assert.ok(Date.now() - started >= 140);
  assert.equal(ctx.exists(), false);
});

test("a sync call during an in-flight async call fails fast instead of deadlocking", async () => {
  const ctx = createContext(scratch());
  let release;
  const gate = new Promise((r) => (release = r));

  const pending = ctx.updateAsync("a", async () => {
    await gate;
    return 1;
  });
  await new Promise((r) => setTimeout(r, 20));

  const sync = ctx.set("b", 2);
  assert.equal(sync.ok, false);
  assert.match(sync.error.message, /in flight in this process/);

  release();
  assert.deepEqual(await pending, { ok: true, value: 1 });
  assert.deepEqual(ctx.set("b", 2), { ok: true, value: undefined });
});

test("async calls in one process serialise instead of contending", async () => {
  const ctx = createContext(scratch(), { defaults: { count: 0 } });
  await Promise.all(
    Array.from({ length: 25 }, () => ctx.updateAsync("count", (n) => n + 1)),
  );
  assert.deepEqual(ctx.get("count"), { ok: true, value: 25 });
});

test("a failing mutation still releases the lock", () => {
  const ctx = createContext(scratch());
  assert.equal(ctx.update("a", () => { throw new Error("boom"); }).ok, false);
  assert.deepEqual(readdirSync(ctx.dir), [], "lock file released");
  assert.equal(ctx.set("a", 1).ok, true);
});

// ── lock creation is atomic with its payload ───────────────────────────────

test("the lock file is never observable without its payload (hard link path)", () => {
  const target = scratch();
  mkdirSync(dirname(target), { recursive: true });
  const lock = lockSync(target, {});
  assert.equal(lock.ok, true);
  assert.match(readFileSync(lockPathFor(target), "utf8"), new RegExp(`^${process.pid}\\n\\d+\\n$`));
  assert.equal(_linkSupported(), true, "this filesystem supports hard links, so link was used");
  assert.deepEqual(readdirSync(dirname(target)), ["context.json.lock"], "no temp file left");
  lock.value();
  assert.deepEqual(readdirSync(dirname(target)), []);
});

test("the O_EXCL fallback still excludes and still cleans up", (t) => {
  _setLinkSupport(false);
  t.after(() => _setLinkSupport(true));

  const ctx = createContext(scratch(), { lock: { timeout: 150 } });
  assert.deepEqual(ctx.set("a", 1), { ok: true, value: undefined });
  assert.deepEqual(readdirSync(ctx.dir), ["context.json"]);

  const held = lockSync(ctx.path, {});
  assert.equal(held.ok, true);
  const contended = ctx.set("a", 2);
  assert.equal(contended.ok, false);
  assert.match(contended.error.message, /Timed out/);
  held.value();
  assert.deepEqual(ctx.set("a", 2), { ok: true, value: undefined });
});
