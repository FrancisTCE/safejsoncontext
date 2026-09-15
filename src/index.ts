export {
  JsonContext,
  createContext,
  type ContextOptions,
  type ReadOptions,
} from "./context.js";

export {
  createSessionContext,
  dropSession,
  hasSession,
  sessionNames,
  type SessionOptions,
} from "./session.js";

export {
  FileStorage,
  MemoryStorage,
  type ContextStorage,
  type FileStorageOptions,
} from "./storage.js";

export {
  isEncrypted,
  encryptedFields,
  type EncryptedValue,
  type FieldSelection,
} from "./crypto.js";

// `KEY_MATERIAL` is deliberately absent: the key never leaves the crypto layer.
export {
  DEFAULT_ACCOUNT,
  DEFAULT_SERVICE,
  KEY_BYTES,
  clearKeyCache,
  memoryKeyStore,
  osKeyStore,
  type BackendName,
  type KeyStore,
  type OsKeyStoreOptions,
} from "./keystore.js";

export {
  DEFAULT_LOCK_STALE,
  DEFAULT_LOCK_TIMEOUT,
  lockPathFor,
  type LockOptions,
} from "./lock.js";

export { type SafeResult, safeParse, safeStringify } from "./result.js";

export {
  SchemaError,
  type InferOutput,
  type StandardIssue,
  type StandardSchemaV1,
} from "./schema.js";
