import assert from "node:assert/strict";
import { test } from "node:test";

import { safeParse, safeStringify } from "../dist/index.js";

test("safeParse returns the parsed value", () => {
  assert.deepEqual(safeParse('{"a":1}'), { ok: true, value: { a: 1 } });
});

test("safeParse reports invalid JSON instead of throwing", () => {
  const result = safeParse("{nope}");
  assert.equal(result.ok, false);
  assert.ok(result.error instanceof SyntaxError);
});

test("safeStringify round-trips a value", () => {
  assert.deepEqual(safeStringify({ a: 1 }), { ok: true, value: '{"a":1}' });
});

test("safeStringify honours the space argument", () => {
  assert.equal(safeStringify({ a: 1 }, 2).value, '{\n  "a": 1\n}');
});

test("safeStringify reports circular structures instead of throwing", () => {
  const circular = {};
  circular.self = circular;
  assert.equal(safeStringify(circular).ok, false);
});

test("safeStringify reports values JSON drops at the top level", () => {
  for (const value of [undefined, () => {}, Symbol("s")]) {
    assert.equal(safeStringify(value).ok, false, `expected ${String(value)} to fail`);
  }
});
