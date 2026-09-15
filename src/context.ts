import {
  type EncryptedValue,
  type FieldSelection,
  decryptRecord,
  decryptValue,
  encryptRecord,
  encryptedFields,
  isEncrypted,
} from "./crypto.js";
import { KEY_MATERIAL, type KeyStore, osKeyStore } from "./keystore.js";
import { type SafeResult, fail, ok } from "./result.js";
import { type StandardSchemaV1, validateAsync, validateSync } from "./schema.js";
import {
  type ContextStorage,
  type Doc,
  FileStorage,
  type FileStorageOptions,
} from "./storage.js";

export interface ContextOptions<T extends object> extends FileStorageOptions {
  /**
   * Fields stored encrypted: a list of names, or `true` for every top-level
   * value. Declared once here, so no write can forget it. Encryption applies
   * to the value; the field name stays readable.
   */
  encrypt?: true | ReadonlyArray<keyof T & string>;
  /**
   * The document to start from when nothing is stored yet: what `init()`
   * writes, what reads return, and what mutations build on.
   */
  defaults?: T;
  /**
   * A Standard Schema (zod, valibot, arktype, …). Gives `T` for autocomplete
   * and validates the plaintext document on every write and every decrypted
   * read. Nothing invalid is ever stored.
   */
  schema?: StandardSchemaV1<unknown, T>;
  /** Where the AES-256 key lives. Defaults to the OS keychain. */
  keystore?: KeyStore;
}

export interface ReadOptions {
  /**
   * Decrypt encrypted fields. Off by default: they come back as opaque
   * envelopes, which is what makes it safe to hand a read to something that
   * should not see the plaintext.
   */
  decrypt?: boolean;
}

/** One mutation of the working document, run under the lock. */
type Step<R> = (doc: Doc) => SafeResult<{ doc: Doc; result: R }>;
type AsyncStep<R> = (
  doc: Doc,
) => SafeResult<{ doc: Doc; result: R }> | Promise<SafeResult<{ doc: Doc; result: R }>>;

function isPlainRecord(value: unknown): value is Doc {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<V>(value: V): V {
  return value === undefined ? value : structuredClone(value);
}

/**
 * A JSON document with per-field access, field-level encryption under an
 * OS-held key, optional schema validation, and exclusive mutations. Where the
 * document lives — a file, or this process's memory — is the storage's
 * business; everything here is the same either way.
 */
export class JsonContext<T extends object = Doc> {
  /** Identity of the document: a file path, or `memory://<name>`. */
  readonly path: string;
  /** Directory of the file, or `memory://`. */
  readonly dir: string;

  private readonly storage: ContextStorage;
  private readonly secrets: FieldSelection;
  private readonly defaults: T | undefined;
  private readonly schema: StandardSchemaV1<unknown, T> | undefined;
  private readonly store: KeyStore;

  constructor(target: string | ContextStorage, options: ContextOptions<T> = {}) {
    this.storage = typeof target === "string" ? new FileStorage(target, options) : target;
    this.path = this.storage.path;
    this.dir = this.storage.dir;
    this.secrets = options.encrypt ?? false;
    this.defaults = options.defaults;
    this.schema = options.schema;
    this.store = options.keystore ?? osKeyStore();
  }

  /**
   * The key store backing this context. It can report whether a key exists and
   * create or delete one; it hands out no key material.
   */
  get keystore(): KeyStore {
    return this.store;
  }

  // ───────────────────────────────────────────────────────────── whole document

  /** Whether anything is stored. */
  exists(): boolean {
    return this.storage.exists();
  }

  /**
   * Store `doc`, else `defaults`, else `{}` — only if nothing is stored yet.
   * `true` if it did. Safe to call on every start-up.
   */
  init(doc?: T): SafeResult<boolean> {
    return this.storage.locked(() => {
      if (this.storage.exists()) return ok(false);
      const written = this.commit((doc as Doc | undefined) ?? this.seed());
      return written.ok ? ok(true) : written;
    });
  }

  /**
   * The whole document. Encrypted fields come back as envelopes unless
   * `decrypt` is set. Nothing stored reads as `defaults`, or `undefined`.
   */
  read(options: ReadOptions = {}): SafeResult<T | undefined> {
    const raw = this.storage.load();
    if (!raw.ok) return raw;
    if (raw.value === undefined) return ok(clone(this.defaults));

    let doc = raw.value;
    if (options.decrypt) {
      const plain = this.plaintext(doc);
      if (!plain.ok) return plain;
      doc = plain.value;
    }

    // The schema describes plaintext, so a censored read is only checked when
    // there is nothing encrypted in it.
    if (this.schema && encryptedFields(doc).length === 0) {
      const valid = validateSync(this.schema, doc);
      if (!valid.ok) return valid;
      return ok(valid.value);
    }
    return ok(doc as T);
  }

  /** Replace the whole document. Validated, encrypted, stored atomically. */
  write(doc: T): SafeResult<void> {
    return this.storage.locked(() => this.commit(doc as Doc));
  }

  /** Delete the document. `false` when there was nothing to delete. */
  remove(): SafeResult<boolean> {
    return this.storage.locked(() => this.storage.remove());
  }

  /** Names of the fields currently stored encrypted. */
  encryptedFields(): SafeResult<string[]> {
    const raw = this.storage.load();
    if (!raw.ok) return raw;
    return ok(raw.value ? encryptedFields(raw.value) : []);
  }

  // ───────────────────────────────────────────────────────────── per field

  /**
   * One field. Refuses an encrypted field: that must be a deliberate
   * `reveal()`, so a plain `get` can never leak plaintext.
   */
  get<K extends keyof T & string>(key: K): SafeResult<T[K] | undefined> {
    const raw = this.storage.load();
    if (!raw.ok) return raw;
    return this.pick(raw.value, key, false);
  }

  /** One field, decrypted if it is encrypted. Greppable on purpose. */
  reveal<K extends keyof T & string>(key: K): SafeResult<T[K] | undefined> {
    const raw = this.storage.load();
    if (!raw.ok) return raw;
    return this.pick(raw.value, key, true);
  }

  /** Whether the field is stored (encrypted or not). */
  has<K extends keyof T & string>(key: K): SafeResult<boolean> {
    const raw = this.storage.load();
    if (!raw.ok) return raw;
    return ok(raw.value !== undefined && Object.hasOwn(raw.value, key));
  }

  /** Put a value. Encrypted on the way in if the field is declared secret. */
  set<K extends keyof T & string>(key: K, value: T[K]): SafeResult<void> {
    return this.mutate(this.setStep(key, value));
  }

  /** Drop a field. `false` when it was not there. */
  delete<K extends keyof T & string>(key: K): SafeResult<boolean> {
    return this.mutate(this.deleteStep(key));
  }

  /**
   * Transform one field from its current plaintext, or the whole document —
   * decrypted for the callback, re-encrypted on the way out.
   */
  update<K extends keyof T & string>(
    key: K,
    fn: (current: T[K] | undefined) => T[K],
  ): SafeResult<T[K]>;
  update(fn: (doc: T) => T): SafeResult<T>;
  update(
    keyOrFn: string | ((doc: T) => T),
    fn?: (current: unknown) => unknown,
  ): SafeResult<unknown> {
    return typeof keyOrFn === "function"
      ? this.mutate(this.updateDocStep(keyOrFn))
      : this.mutate(this.updateKeyStep(keyOrFn, fn!));
  }

  // ───────────────────────────────────────────────────────────── async twins

  existsAsync(): Promise<boolean> {
    return this.storage.existsAsync();
  }

  initAsync(doc?: T): Promise<SafeResult<boolean>> {
    return this.storage.lockedAsync(async () => {
      if (await this.storage.existsAsync()) return ok(false);
      const written = await this.commitAsync((doc as Doc | undefined) ?? this.seed());
      return written.ok ? ok(true) : written;
    });
  }

  async readAsync(options: ReadOptions = {}): Promise<SafeResult<T | undefined>> {
    const raw = await this.storage.loadAsync();
    if (!raw.ok) return raw;
    if (raw.value === undefined) return ok(clone(this.defaults));

    let doc = raw.value;
    if (options.decrypt) {
      const plain = this.plaintext(doc);
      if (!plain.ok) return plain;
      doc = plain.value;
    }
    if (this.schema && encryptedFields(doc).length === 0) {
      const valid = await validateAsync(this.schema, doc);
      if (!valid.ok) return valid;
      return ok(valid.value);
    }
    return ok(doc as T);
  }

  writeAsync(doc: T): Promise<SafeResult<void>> {
    return this.storage.lockedAsync(() => this.commitAsync(doc as Doc));
  }

  removeAsync(): Promise<SafeResult<boolean>> {
    return this.storage.lockedAsync(() => this.storage.removeAsync());
  }

  async encryptedFieldsAsync(): Promise<SafeResult<string[]>> {
    const raw = await this.storage.loadAsync();
    if (!raw.ok) return raw;
    return ok(raw.value ? encryptedFields(raw.value) : []);
  }

  async getAsync<K extends keyof T & string>(key: K): Promise<SafeResult<T[K] | undefined>> {
    const raw = await this.storage.loadAsync();
    if (!raw.ok) return raw;
    return this.pick(raw.value, key, false);
  }

  async revealAsync<K extends keyof T & string>(
    key: K,
  ): Promise<SafeResult<T[K] | undefined>> {
    const raw = await this.storage.loadAsync();
    if (!raw.ok) return raw;
    return this.pick(raw.value, key, true);
  }

  async hasAsync<K extends keyof T & string>(key: K): Promise<SafeResult<boolean>> {
    const raw = await this.storage.loadAsync();
    if (!raw.ok) return raw;
    return ok(raw.value !== undefined && Object.hasOwn(raw.value, key));
  }

  setAsync<K extends keyof T & string>(key: K, value: T[K]): Promise<SafeResult<void>> {
    return this.mutateAsync(this.setStep(key, value));
  }

  deleteAsync<K extends keyof T & string>(key: K): Promise<SafeResult<boolean>> {
    return this.mutateAsync(this.deleteStep(key));
  }

  updateAsync<K extends keyof T & string>(
    key: K,
    fn: (current: T[K] | undefined) => T[K] | Promise<T[K]>,
  ): Promise<SafeResult<T[K]>>;
  updateAsync(fn: (doc: T) => T | Promise<T>): Promise<SafeResult<T>>;
  updateAsync(
    keyOrFn: string | ((doc: T) => T | Promise<T>),
    fn?: (current: unknown) => unknown,
  ): Promise<SafeResult<unknown>> {
    return typeof keyOrFn === "function"
      ? this.mutateAsync(this.updateDocStepAsync(keyOrFn))
      : this.mutateAsync(this.updateKeyStepAsync(keyOrFn, fn!));
  }

  // ───────────────────────────────────────────────────────────── steps

  private setStep<R = void>(key: string, value: unknown): Step<R> {
    return (doc) => {
      doc[key] = value;
      return ok({ doc, result: undefined as R });
    };
  }

  private deleteStep(key: string): Step<boolean> {
    return (doc) => {
      const had = Object.hasOwn(doc, key);
      delete doc[key];
      return ok({ doc, result: had });
    };
  }

  /** Current plaintext of one field inside a working document. */
  private currentOf(doc: Doc, key: string): SafeResult<unknown> {
    const value = doc[key];
    if (isEncrypted(value)) {
      const key_ = this.key();
      if (!key_.ok) return key_;
      return decryptValue(key_.value, key, value);
    }
    if (value === undefined && this.defaults !== undefined) {
      return ok(clone((this.defaults as Doc)[key]));
    }
    return ok(value);
  }

  private updateKeyStep(key: string, fn: (current: unknown) => unknown): Step<unknown> {
    return (doc) => {
      const current = this.currentOf(doc, key);
      if (!current.ok) return current;
      let next: unknown;
      try {
        next = fn(current.value);
      } catch (error) {
        return fail(error);
      }
      doc[key] = next;
      return ok({ doc, result: next });
    };
  }

  private updateKeyStepAsync(
    key: string,
    fn: (current: unknown) => unknown,
  ): AsyncStep<unknown> {
    return async (doc) => {
      const current = this.currentOf(doc, key);
      if (!current.ok) return current;
      let next: unknown;
      try {
        next = await fn(current.value);
      } catch (error) {
        return fail(error);
      }
      doc[key] = next;
      return ok({ doc, result: next });
    };
  }

  private updateDocStep(fn: (doc: T) => T): Step<unknown> {
    return (doc) => {
      const plain = this.plaintext(doc);
      if (!plain.ok) return plain;
      let next: unknown;
      try {
        next = fn(plain.value as T);
      } catch (error) {
        return fail(error);
      }
      if (!isPlainRecord(next)) return fail(new TypeError("update must return an object"));
      return ok({ doc: next, result: next });
    };
  }

  private updateDocStepAsync(fn: (doc: T) => T | Promise<T>): AsyncStep<unknown> {
    return async (doc) => {
      const plain = this.plaintext(doc);
      if (!plain.ok) return plain;
      let next: unknown;
      try {
        next = await fn(plain.value as T);
      } catch (error) {
        return fail(error);
      }
      if (!isPlainRecord(next)) return fail(new TypeError("update must return an object"));
      return ok({ doc: next, result: next });
    };
  }

  // ───────────────────────────────────────────────────────────── pipeline

  /** Lock → load → step → validate → encrypt → store → unlock. */
  private mutate<R>(step: Step<R>): SafeResult<R> {
    return this.storage.locked(() => {
      const raw = this.storage.load();
      if (!raw.ok) return raw;
      const working = this.working(raw.value);
      if (!working.ok) return working;

      const stepped = step(working.value);
      if (!stepped.ok) return stepped;

      const written = this.commit(stepped.value.doc);
      return written.ok ? ok(stepped.value.result) : written;
    });
  }

  private mutateAsync<R>(step: AsyncStep<R>): Promise<SafeResult<R>> {
    return this.storage.lockedAsync(async () => {
      const raw = await this.storage.loadAsync();
      if (!raw.ok) return raw;
      const working = this.working(raw.value);
      if (!working.ok) return working;

      const stepped = await step(working.value);
      if (!stepped.ok) return stepped;

      const written = await this.commitAsync(stepped.value.doc);
      return written.ok ? ok(stepped.value.result) : written;
    });
  }

  /**
   * The document a step operates on. With a schema it must be fully plaintext,
   * because the schema will be checked afterwards; without one, untouched
   * encrypted fields pass through as envelopes and the keychain stays idle.
   */
  private working(raw: Doc | undefined): SafeResult<Doc> {
    const doc = raw ?? this.seed();
    return this.schema ? this.plaintext(doc) : ok(doc);
  }

  /** Validate (if there is a schema), encrypt secret fields, store. */
  private commit(doc: Doc): SafeResult<void> {
    let out: Doc = doc;
    if (this.schema) {
      const valid = validateSync(this.schema, out);
      if (!valid.ok) return valid;
      out = valid.value as Doc;
    }
    const sealed = this.seal(out);
    if (!sealed.ok) return sealed;
    return this.storage.persist(sealed.value);
  }

  private async commitAsync(doc: Doc): Promise<SafeResult<void>> {
    let out: Doc = doc;
    if (this.schema) {
      const valid = await validateAsync(this.schema, out);
      if (!valid.ok) return valid;
      out = valid.value as Doc;
    }
    const sealed = this.seal(out);
    if (!sealed.ok) return sealed;
    return this.storage.persistAsync(sealed.value);
  }

  // ───────────────────────────────────────────────────────────── helpers

  private pick<K extends keyof T & string>(
    raw: Doc | undefined,
    key: K,
    decrypt: boolean,
  ): SafeResult<T[K] | undefined> {
    if (raw === undefined || !Object.hasOwn(raw, key)) {
      return ok(clone(this.defaults?.[key]));
    }
    const value = raw[key];
    if (!isEncrypted(value)) return ok(value as T[K]);
    if (!decrypt) {
      return fail(
        new Error(`Field "${key}" is encrypted; read it with reveal("${key}")`),
      );
    }
    const key_ = this.key();
    if (!key_.ok) return key_;
    const plain = decryptValue(key_.value, key, value as EncryptedValue);
    return plain.ok ? ok(plain.value as T[K]) : plain;
  }

  private seed(): Doc {
    return this.defaults === undefined ? {} : (structuredClone(this.defaults) as Doc);
  }

  private isSecret(field: string): boolean {
    return this.secrets === true || (this.secrets !== false && this.secrets.includes(field));
  }

  /** The key, fetched from the store only when a call actually needs it. */
  private key(): SafeResult<Buffer> {
    return this.store[KEY_MATERIAL]();
  }

  /** Every envelope decrypted. Touches the keychain only if there is one. */
  private plaintext(doc: Doc): SafeResult<Doc> {
    if (encryptedFields(doc).length === 0) return ok(doc);
    const key = this.key();
    if (!key.ok) return key;
    return decryptRecord(key.value, doc);
  }

  /** Secret fields encrypted; envelopes already present pass through untouched. */
  private seal(doc: Doc): SafeResult<Doc> {
    if (this.secrets === false) return ok(doc);
    const pending = Object.entries(doc).some(
      ([field, value]) => this.isSecret(field) && !isEncrypted(value),
    );
    if (!pending) return ok(doc);

    const key = this.key();
    if (!key.ok) return key;
    return encryptRecord(key.value, doc, this.secrets);
  }
}

/**
 * Bind a JSON file. Nothing touches the disk until a method runs. `T` comes
 * from the type argument, from `defaults`, or from `schema`.
 */
export function createContext<T extends object = Doc>(
  path: string,
  options?: ContextOptions<T>,
): JsonContext<T> {
  return new JsonContext<T>(path, options);
}
