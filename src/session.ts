import { type ContextOptions, JsonContext } from "./context.js";
import { type KeyStore, memoryKeyStore } from "./keystore.js";
import { type Doc, MemoryStorage } from "./storage.js";

/** File-only knobs make no sense for a document that never touches the disk. */
export type SessionOptions<T extends object> = Omit<
  ContextOptions<T>,
  "pretty" | "durable" | "lock"
>;

/**
 * One store per name, per process. Every handle created with the same name
 * shares the same document, so modules can meet at a session by name without
 * passing the handle around.
 */
const sessions = new Map<string, MemoryStorage>();

/**
 * Session contexts default to a key that lives in this process only. Nothing
 * they hold is meant to outlive it, so there is no reason to touch the OS
 * keychain — pass `keystore: osKeyStore()` if an envelope must be readable by
 * a file context later.
 */
let processKey: KeyStore | undefined;
function processKeyStore(): KeyStore {
  processKey ??= memoryKeyStore();
  return processKey;
}

/**
 * The same API as `createContext`, backed by memory instead of a file. The
 * document lives as long as the process and is never written anywhere. Good
 * for sensitive working state: a censored `read()` is still what every caller
 * gets unless they `reveal`, but there is nothing on disk to protect.
 */
export function createSessionContext<T extends object = Doc>(
  name: string,
  options: SessionOptions<T> = {},
): JsonContext<T> {
  let storage = sessions.get(name);
  if (!storage) {
    storage = new MemoryStorage(name);
    sessions.set(name, storage);
  }
  return new JsonContext<T>(storage, {
    ...options,
    keystore: options.keystore ?? processKeyStore(),
  });
}

/** Whether a session of that name exists in this process. */
export function hasSession(name: string): boolean {
  return sessions.has(name);
}

/** Names of every session in this process. */
export function sessionNames(): string[] {
  return [...sessions.keys()];
}

/**
 * Forget a session: its document is dropped and handles to it read as empty.
 * `false` if there was no such session.
 */
export function dropSession(name: string): boolean {
  const storage = sessions.get(name);
  if (!storage) return false;
  storage.remove();
  sessions.delete(name);
  return true;
}
