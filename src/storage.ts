import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  access,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  type LockOptions,
  busyInProcess,
  lockAsync,
  lockSync,
  queueInProcess,
  sleepSync,
} from "./lock.js";
import {
  OK_VOID,
  type SafeResult,
  fail,
  isNotFound,
  isTransient,
  ok,
  safeParse,
  safeStringify,
} from "./result.js";

export type Doc = Record<string, unknown>;

/**
 * Where a context keeps its document. The context itself only knows how to
 * turn a document into a safe, validated, encrypted one; the storage knows
 * how to hold it, and how to make mutations exclusive.
 */
export interface ContextStorage {
  /** Identity, for messages. A file path, or `memory://<name>`. */
  readonly path: string;
  readonly dir: string;
  exists(): boolean;
  existsAsync(): Promise<boolean>;
  load(): SafeResult<Doc | undefined>;
  loadAsync(): Promise<SafeResult<Doc | undefined>>;
  persist(doc: Doc): SafeResult<void>;
  persistAsync(doc: Doc): Promise<SafeResult<void>>;
  remove(): SafeResult<boolean>;
  removeAsync(): Promise<SafeResult<boolean>>;
  /** Run `fn` with exclusive access to the document. */
  locked<R>(fn: () => SafeResult<R>): SafeResult<R>;
  lockedAsync<R>(fn: () => Promise<SafeResult<R>>): Promise<SafeResult<R>>;
}

export interface FileStorageOptions {
  /** `true` indents with 2 spaces, a number indents with that many. */
  pretty?: boolean | number;
  /** fsync before rename. Slower, but survives a power loss. */
  durable?: boolean;
  /** Cross-process locking for every mutation. On by default. */
  lock?: false | LockOptions;
}

function isPlainRecord(value: unknown): value is Doc {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDoc(raw: string, where: string): SafeResult<Doc> {
  const parsed = safeParse<unknown>(raw);
  if (!parsed.ok) return parsed;
  if (!isPlainRecord(parsed.value)) {
    return fail(new TypeError(`${where} does not hold a JSON object`));
  }
  return ok(parsed.value);
}

function busyError(path: string): Error {
  return new Error(
    `An async operation on ${path} is in flight in this process; ` +
      "await it first, or use the async API",
  );
}

/** Temp names only need to be unique per process, so a counter beats randomness. */
let tempCounter = 0;

/** Bounded retry for Windows sharing violations: ~12 attempts, under 300 ms total. */
const SHARE_RETRIES = 12;
const SHARE_MAX_DELAY = 40;

/**
 * A JSON file on disk.
 *
 * - reads are a single `readFileSync` with no lock and no `stat`: a rename
 *   based write means a reader sees the old file or the new one, never a torn
 *   one, so reads need no coordination;
 * - writes go to a sibling temp file and `rename` over the target;
 * - the lock is a hard-linked file next to the target, held for the length of
 *   one read-modify-write, and only mutations take it.
 */
export class FileStorage implements ContextStorage {
  readonly path: string;
  readonly dir: string;

  private readonly space: string | number | undefined;
  private readonly durable: boolean;
  private readonly locking: false | LockOptions;

  constructor(path: string, options: FileStorageOptions = {}) {
    this.path = resolve(path);
    this.dir = dirname(this.path);
    this.space =
      options.pretty === true
        ? 2
        : options.pretty === false
          ? undefined
          : options.pretty;
    this.durable = options.durable ?? false;
    this.locking = options.lock ?? {};
  }

  exists(): boolean {
    return existsSync(this.path);
  }

  async existsAsync(): Promise<boolean> {
    try {
      await access(this.path);
      return true;
    } catch {
      return false;
    }
  }

  load(): SafeResult<Doc | undefined> {
    let raw: string;
    try {
      raw = this.readSource();
    } catch (error) {
      return isNotFound(error) ? ok(undefined) : fail(error);
    }
    return parseDoc(raw, this.path);
  }

  async loadAsync(): Promise<SafeResult<Doc | undefined>> {
    let raw: string;
    try {
      raw = await this.readSourceAsync();
    } catch (error) {
      return isNotFound(error) ? ok(undefined) : fail(error);
    }
    return parseDoc(raw, this.path);
  }

  persist(doc: Doc): SafeResult<void> {
    const json = safeStringify(doc, this.space);
    if (!json.ok) return json;

    const temp = this.tempPath();
    try {
      this.writeTemp(temp, json.value);
      this.renameOver(temp);
      return OK_VOID;
    } catch (error) {
      if (!isNotFound(error)) {
        this.discard(temp);
        return fail(error);
      }
      // Directory missing (only reachable with `lock: false`): create, retry once.
      try {
        mkdirSync(this.dir, { recursive: true });
        this.writeTemp(temp, json.value);
        this.renameOver(temp);
        return OK_VOID;
      } catch (retryError) {
        this.discard(temp);
        return fail(retryError);
      }
    }
  }

  async persistAsync(doc: Doc): Promise<SafeResult<void>> {
    const json = safeStringify(doc, this.space);
    if (!json.ok) return json;

    const temp = this.tempPath();
    try {
      await this.writeTempAsync(temp, json.value);
      await this.renameOverAsync(temp);
      return OK_VOID;
    } catch (error) {
      if (!isNotFound(error)) {
        await this.discardAsync(temp);
        return fail(error);
      }
      try {
        await mkdir(this.dir, { recursive: true });
        await this.writeTempAsync(temp, json.value);
        await this.renameOverAsync(temp);
        return OK_VOID;
      } catch (retryError) {
        await this.discardAsync(temp);
        return fail(retryError);
      }
    }
  }

  remove(): SafeResult<boolean> {
    try {
      unlinkSync(this.path);
      return ok(true);
    } catch (error) {
      return isNotFound(error) ? ok(false) : fail(error);
    }
  }

  async removeAsync(): Promise<SafeResult<boolean>> {
    try {
      await unlink(this.path);
      return ok(true);
    } catch (error) {
      return isNotFound(error) ? ok(false) : fail(error);
    }
  }

  locked<R>(fn: () => SafeResult<R>): SafeResult<R> {
    if (busyInProcess(this.path)) return fail(busyError(this.path));
    if (this.locking === false) return fn();

    let lock = lockSync(this.path, this.locking);
    if (!lock.ok && isNotFound(lock.error)) {
      // First write into a directory that does not exist yet.
      try {
        mkdirSync(this.dir, { recursive: true });
      } catch (error) {
        return fail(error);
      }
      lock = lockSync(this.path, this.locking);
    }
    if (!lock.ok) return lock;

    try {
      return fn();
    } finally {
      lock.value();
    }
  }

  lockedAsync<R>(fn: () => Promise<SafeResult<R>>): Promise<SafeResult<R>> {
    return queueInProcess(this.path, async () => {
      if (this.locking === false) return fn();

      let lock = await lockAsync(this.path, this.locking);
      if (!lock.ok && isNotFound(lock.error)) {
        try {
          await mkdir(this.dir, { recursive: true });
        } catch (error) {
          return fail(error);
        }
        lock = await lockAsync(this.path, this.locking);
      }
      if (!lock.ok) return lock;

      try {
        return await fn();
      } finally {
        await lock.value();
      }
    });
  }

  private tempPath(): string {
    return `${this.path}.${process.pid}.${tempCounter++}.tmp`;
  }

  /**
   * Reads take no lock, so on Windows a reader may briefly hold the target open
   * while we rename over it, and a rename may land while a reader opens. Both
   * surface as EPERM/EBUSY and clear within milliseconds; retry, bounded.
   */
  private renameOver(temp: string): void {
    let delay = 1;
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(temp, this.path);
        return;
      } catch (error) {
        if (!isTransient(error) || attempt >= SHARE_RETRIES) throw error;
        sleepSync(delay);
        delay = Math.min(delay * 2, SHARE_MAX_DELAY);
      }
    }
  }

  private async renameOverAsync(temp: string): Promise<void> {
    let delay = 1;
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temp, this.path);
        return;
      } catch (error) {
        if (!isTransient(error) || attempt >= SHARE_RETRIES) throw error;
        await sleep(delay);
        delay = Math.min(delay * 2, SHARE_MAX_DELAY);
      }
    }
  }

  private readSource(): string {
    let delay = 1;
    for (let attempt = 0; ; attempt++) {
      try {
        return readFileSync(this.path, "utf8");
      } catch (error) {
        if (!isTransient(error) || attempt >= SHARE_RETRIES) throw error;
        sleepSync(delay);
        delay = Math.min(delay * 2, SHARE_MAX_DELAY);
      }
    }
  }

  private async readSourceAsync(): Promise<string> {
    let delay = 1;
    for (let attempt = 0; ; attempt++) {
      try {
        return await readFile(this.path, "utf8");
      } catch (error) {
        if (!isTransient(error) || attempt >= SHARE_RETRIES) throw error;
        await sleep(delay);
        delay = Math.min(delay * 2, SHARE_MAX_DELAY);
      }
    }
  }

  private writeTemp(file: string, data: string): void {
    if (!this.durable) {
      writeFileSync(file, data);
      return;
    }
    const fd = openSync(file, "w");
    try {
      writeFileSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  private async writeTempAsync(file: string, data: string): Promise<void> {
    if (!this.durable) {
      await writeFile(file, data);
      return;
    }
    const handle = await open(file, "w");
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private discard(file: string): void {
    try {
      unlinkSync(file);
    } catch {
      // Never created, or already gone.
    }
  }

  private async discardAsync(file: string): Promise<void> {
    try {
      await unlink(file);
    } catch {
      // Never created, or already gone.
    }
  }
}

/**
 * A document held in this process only. It goes through the same JSON
 * round-trip as a file — so the semantics are identical, and callers can never
 * hold a live reference into the store — but it never touches the disk and
 * dies with the process.
 */
export class MemoryStorage implements ContextStorage {
  readonly path: string;
  readonly dir = "memory://";

  private json: string | undefined;

  constructor(name: string) {
    this.path = `memory://${name}`;
  }

  exists(): boolean {
    return this.json !== undefined;
  }

  existsAsync(): Promise<boolean> {
    return Promise.resolve(this.exists());
  }

  load(): SafeResult<Doc | undefined> {
    return this.json === undefined ? ok(undefined) : parseDoc(this.json, this.path);
  }

  loadAsync(): Promise<SafeResult<Doc | undefined>> {
    return Promise.resolve(this.load());
  }

  persist(doc: Doc): SafeResult<void> {
    const json = safeStringify(doc);
    if (!json.ok) return json;
    this.json = json.value;
    return OK_VOID;
  }

  persistAsync(doc: Doc): Promise<SafeResult<void>> {
    return Promise.resolve(this.persist(doc));
  }

  remove(): SafeResult<boolean> {
    const had = this.json !== undefined;
    this.json = undefined;
    return ok(had);
  }

  removeAsync(): Promise<SafeResult<boolean>> {
    return Promise.resolve(this.remove());
  }

  /** Nothing to lock across processes; the in-process rules still apply. */
  locked<R>(fn: () => SafeResult<R>): SafeResult<R> {
    if (busyInProcess(this.path)) return fail(busyError(this.path));
    return fn();
  }

  lockedAsync<R>(fn: () => Promise<SafeResult<R>>): Promise<SafeResult<R>> {
    return queueInProcess(this.path, fn);
  }
}
