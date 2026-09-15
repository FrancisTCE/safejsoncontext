import {
  closeSync,
  linkSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { link, open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import { type SafeResult, fail, isNotFound, isTransient, ok } from "./result.js";

export interface LockOptions {
  /** How long to wait for another holder before giving up. Default 5 s. */
  timeout?: number;
  /**
   * A lock older than this is treated as abandoned and broken. Holders keep the
   * lock for milliseconds, so the default of 10 s is generous. Default 10 s.
   */
  stale?: number;
}

export const DEFAULT_LOCK_TIMEOUT = 5_000;
export const DEFAULT_LOCK_STALE = 10_000;

/** Backoff between attempts: starts at 1 ms, doubles, caps here. */
const MAX_DELAY = 50;

/** Atomics.wait is the only way to sleep synchronously without burning a core. */
const sleeper = new Int32Array(new SharedArrayBuffer(4));
export function sleepSync(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

export function lockPathFor(target: string): string {
  return `${target}.lock`;
}

function payload(): string {
  return `${process.pid}\n${Date.now()}\n`;
}

let tempCounter = 0;
function tempPathFor(lockPath: string): string {
  return `${lockPath}.${process.pid}.${tempCounter++}.tmp`;
}

/**
 * Whether this process may use hard links to create locks. Flipped off the
 * first time `link` fails for a reason other than EEXIST — a filesystem without
 * hard links — after which `O_EXCL` creation is used instead.
 */
let linkSupported = true;

/** @internal test hook */
export function _setLinkSupport(value: boolean): void {
  linkSupported = value;
}

/** @internal test hook */
export function _linkSupported(): boolean {
  return linkSupported;
}

type Attempt = "acquired" | "held";

/**
 * Create the lock file with its payload already in it.
 *
 * Preferred: write the payload to a private temp file and hard-link it to the
 * lock path. `link` is atomic and fails with EEXIST when the lock exists, so
 * the lock is never observable without its payload. Fallback: `O_EXCL` create
 * then write, which leaves a window where the file exists but is empty — the
 * stale check below is written so that window is harmless.
 */
function createSync(lockPath: string): Attempt {
  if (linkSupported) {
    const temp = tempPathFor(lockPath);
    writeFileSync(temp, payload());
    try {
      linkSync(temp, lockPath);
      return "acquired";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return "held";
      if (code === "ENOENT" || isTransient(error)) throw error;
      linkSupported = false; // this filesystem cannot link: fall through
    } finally {
      try {
        unlinkSync(temp);
      } catch {
        // Best effort; the temp name is unique to this attempt.
      }
    }
  }

  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return "held";
    throw error;
  }
  try {
    writeSync(fd, payload());
  } finally {
    closeSync(fd);
  }
  return "acquired";
}

async function createAsync(lockPath: string): Promise<Attempt> {
  if (linkSupported) {
    const temp = tempPathFor(lockPath);
    await writeFile(temp, payload());
    try {
      await link(temp, lockPath);
      return "acquired";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return "held";
      if (code === "ENOENT" || isTransient(error)) throw error;
      linkSupported = false;
    } finally {
      try {
        await unlink(temp);
      } catch {
        // Best effort.
      }
    }
  }

  let handle;
  try {
    handle = await open(lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return "held";
    throw error;
  }
  try {
    await handle.writeFile(payload());
  } finally {
    await handle.close();
  }
  return "acquired";
}

/** Signal 0 checks for existence without sending anything. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else. Still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Whether the holder recorded in the lock file is a process that no longer
 * exists. An empty or partial payload (only possible on the O_EXCL fallback)
 * proves nothing and is never grounds for breaking the lock.
 */
function holderIsDead(content: string): boolean {
  const pid = Number(content.split("\n")[0]);
  return Number.isFinite(pid) && pid > 0 && pid !== process.pid && !isAlive(pid);
}

/**
 * Age comes from the filesystem, not the payload: the mtime is fixed when the
 * file is created, so it is right even on the fallback path while the payload
 * is still being written. A vanished lock (ENOENT) is simply not stale — it
 * was released and the next attempt will succeed.
 */
function isStaleSync(lockPath: string, content: string, staleMs: number): boolean {
  if (holderIsDead(content)) return true;
  try {
    return Date.now() - statSync(lockPath).mtimeMs > staleMs;
  } catch {
    return false;
  }
}

async function isStaleAsync(
  lockPath: string,
  content: string,
  staleMs: number,
): Promise<boolean> {
  if (holderIsDead(content)) return true;
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs > staleMs;
  } catch {
    return false;
  }
}

function timeoutError(target: string, timeout: number, holder: string): Error {
  return new Error(
    `Timed out after ${timeout} ms waiting for the lock on ${target}` +
      (holder ? ` (held by pid ${holder.split("\n")[0]})` : ""),
  );
}

/**
 * Take an exclusive lock on `target` via `<target>.lock`. Returns the release
 * function. Never throws: a filesystem error is a failed result.
 */
export function lockSync(
  target: string,
  options: LockOptions = {},
): SafeResult<() => void> {
  const timeout = options.timeout ?? DEFAULT_LOCK_TIMEOUT;
  const stale = options.stale ?? DEFAULT_LOCK_STALE;
  const lockPath = lockPathFor(target);
  const deadline = Date.now() + timeout;
  let delay = 1;
  let lastHolder = "";

  const backoff = (): SafeResult<never> | undefined => {
    if (Date.now() >= deadline) return fail(timeoutError(target, timeout, lastHolder));
    sleepSync(delay);
    delay = Math.min(delay * 2, MAX_DELAY);
    return undefined;
  };

  for (;;) {
    let attempt: Attempt;
    try {
      attempt = createSync(lockPath);
    } catch (error) {
      // Windows: the previous holder's lock file is mid-deletion. Back off.
      if (!isTransient(error)) return fail(error);
      const out = backoff();
      if (out) return out;
      continue;
    }

    if (attempt === "acquired") {
      return ok(() => {
        try {
          unlinkSync(lockPath);
        } catch {
          // Already gone, or cannot be removed right now: a lock file that
          // outlives its holder is broken as stale by the next contender.
        }
      });
    }

    // Someone holds it. Break it if they are gone, otherwise wait a little.
    let content: string;
    try {
      content = readFileSync(lockPath, "utf8");
    } catch (error) {
      if (isNotFound(error)) continue; // released meanwhile: retry at once
      if (!isTransient(error)) return fail(error);
      const out = backoff();
      if (out) return out;
      continue;
    }
    lastHolder = content;

    if (isStaleSync(lockPath, content, stale)) {
      try {
        unlinkSync(lockPath);
      } catch (error) {
        // Gone already, or another contender is breaking it: either way, retry.
        if (!isNotFound(error) && !isTransient(error)) return fail(error);
      }
      continue;
    }

    const out = backoff();
    if (out) return out;
  }
}

export async function lockAsync(
  target: string,
  options: LockOptions = {},
): Promise<SafeResult<() => Promise<void>>> {
  const timeout = options.timeout ?? DEFAULT_LOCK_TIMEOUT;
  const stale = options.stale ?? DEFAULT_LOCK_STALE;
  const lockPath = lockPathFor(target);
  const deadline = Date.now() + timeout;
  let delay = 1;
  let lastHolder = "";

  const backoff = async (): Promise<SafeResult<never> | undefined> => {
    if (Date.now() >= deadline) return fail(timeoutError(target, timeout, lastHolder));
    await sleep(delay);
    delay = Math.min(delay * 2, MAX_DELAY);
    return undefined;
  };

  for (;;) {
    let attempt: Attempt;
    try {
      attempt = await createAsync(lockPath);
    } catch (error) {
      if (!isTransient(error)) return fail(error);
      const out = await backoff();
      if (out) return out;
      continue;
    }

    if (attempt === "acquired") {
      return ok(async () => {
        try {
          await unlink(lockPath);
        } catch {
          // Same as the sync release: a leftover lock is broken as stale.
        }
      });
    }

    let content: string;
    try {
      content = await readFile(lockPath, "utf8");
    } catch (error) {
      if (isNotFound(error)) continue;
      if (!isTransient(error)) return fail(error);
      const out = await backoff();
      if (out) return out;
      continue;
    }
    lastHolder = content;

    if (await isStaleAsync(lockPath, content, stale)) {
      try {
        await unlink(lockPath);
      } catch (error) {
        if (!isNotFound(error) && !isTransient(error)) return fail(error);
      }
      continue;
    }

    const out = await backoff();
    if (out) return out;
  }
}

/**
 * In-process serialisation. Async operations on the same target queue behind
 * one another here instead of contending on disk; and a sync operation can ask
 * whether an async one is mid-flight — it must not block waiting for that,
 * because blocking the thread is exactly what would stop the async operation
 * from ever finishing.
 */
const inflight = new Map<string, Promise<void>>();

export function busyInProcess(target: string): boolean {
  return inflight.has(target);
}

export async function queueInProcess<R>(
  target: string,
  work: () => Promise<R>,
): Promise<R> {
  const previous = inflight.get(target) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => mine);
  inflight.set(target, chained);

  await previous;
  try {
    return await work();
  } finally {
    release();
    if (inflight.get(target) === chained) inflight.delete(target);
  }
}
