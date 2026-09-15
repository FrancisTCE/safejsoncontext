import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { type SafeResult, fail, isNotFound, ok } from "./result.js";

/** AES-256: 32 bytes of key material. */
export const KEY_BYTES = 32;

export const DEFAULT_SERVICE = "safejsoncontext";
export const DEFAULT_ACCOUNT = "default";

/**
 * Handed to the crypto layer only. It is deliberately a module-private symbol
 * and is not re-exported from the package entry point, so callers of the public
 * API have no supported way to pull the raw key out of a store.
 */
export const KEY_MATERIAL = Symbol("safejsoncontext.keyMaterial");

/** Which store actually holds the key on this machine. */
export type BackendName =
  | "windows-credential-manager"
  | "macos-keychain"
  | "libsecret"
  | "file"
  | "memory";

export interface KeyStore {
  /** Human-readable identifier, safe to log. Never contains key material. */
  readonly id: string;
  /** The store backing this key on the current machine. */
  readonly backend: BackendName;
  /** Create the key if it is not there yet. Resolves to `true` if it created one. */
  ensure(): SafeResult<boolean>;
  /** Whether a key exists for this service/account. */
  exists(): SafeResult<boolean>;
  /** Delete the key. Anything encrypted with it becomes unreadable. */
  remove(): SafeResult<boolean>;
  /** @internal */
  [KEY_MATERIAL](): SafeResult<Buffer>;
}

export interface OsKeyStoreOptions {
  /** Service name shown in the OS credential UI. */
  service?: string;
  /** Account name, so one machine can hold several independent keys. */
  account?: string;
  /**
   * What to do when the machine has no usable keychain — a headless Linux box
   * without libsecret, an unsupported platform. `"file"` (the default) keeps
   * the API working everywhere by falling back to a 0600 key file under the
   * home directory; `"none"` makes every call fail instead.
   */
  fallback?: "file" | "none";
  /** Directory for the `"file"` fallback. Defaults to `~/.safejsoncontext`. */
  fallbackDir?: string;
}

/**
 * One shell-out per process, at most: the decoded key is cached here and the
 * cache is keyed by service/account rather than by store instance.
 */
const cache = new Map<string, Buffer>();

interface Backend {
  readonly name: BackendName;
  /** Cheap probe: is this store actually usable on this machine right now? */
  available(): boolean;
  get(service: string, account: string): string | undefined;
  set(service: string, account: string, secret: string): void;
  del(service: string, account: string): boolean;
}

const MISSING = "__SJC_MISSING__";

const PS_FLAGS = [
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-Command",
];

/**
 * Bounds every shell-out. Without it a stalled `powershell.exe` (no
 * interactive session, cold WinRT assembly load, AV scanning) blocks forever
 * and only a CI job timeout ever reaps it, leaving a dangling process.
 */
const EXEC_TIMEOUT_MS = 5_000;

function run(
  file: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: string } = {},
): string {
  return execFileSync(file, args, {
    encoding: "utf8",
    env: options.env ?? process.env,
    input: options.input,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    timeout: EXEC_TIMEOUT_MS,
  });
}

function tryRun(
  file: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: string } = {},
): { status: number; stdout: string } {
  try {
    return { status: 0, stdout: run(file, args, options) };
  } catch (error) {
    const err = error as { status?: number; stdout?: string | Buffer };
    return {
      status: err.status ?? 1,
      stdout:
        typeof err.stdout === "string" ? err.stdout : (err.stdout?.toString() ?? ""),
    };
  }
}

/** Windows Credential Manager, through the WinRT PasswordVault. */
const windowsBackend: Backend = {
  name: "windows-credential-manager",

  available() {
    const { status } = tryRun("powershell.exe", [
      ...PS_FLAGS,
      "[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]; New-Object Windows.Security.Credentials.PasswordVault | Out-Null",
    ]);
    return status === 0;
  },

  get(service, account) {
    const script = `
[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]
$vault = New-Object Windows.Security.Credentials.PasswordVault
try {
  $cred = $vault.Retrieve($env:SJC_SERVICE, $env:SJC_ACCOUNT)
  $cred.RetrievePassword()
  Write-Output $cred.Password
} catch { Write-Output '${MISSING}' }`;
    const { stdout } = tryRun("powershell.exe", [...PS_FLAGS, script], {
      env: { ...process.env, SJC_SERVICE: service, SJC_ACCOUNT: account },
    });
    const value = stdout.trim();
    return value === MISSING || value === "" ? undefined : value;
  },

  set(service, account, secret) {
    const script = `
[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]
$vault = New-Object Windows.Security.Credentials.PasswordVault
$cred = New-Object Windows.Security.Credentials.PasswordCredential($env:SJC_SERVICE, $env:SJC_ACCOUNT, $env:SJC_SECRET)
$vault.Add($cred)`;
    // Secrets travel through the environment, never argv, so the key does not
    // show up in another process listing.
    run("powershell.exe", [...PS_FLAGS, script], {
      env: {
        ...process.env,
        SJC_SERVICE: service,
        SJC_ACCOUNT: account,
        SJC_SECRET: secret,
      },
    });
  },

  del(service, account) {
    const script = `
[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]
$vault = New-Object Windows.Security.Credentials.PasswordVault
try {
  $vault.Remove($vault.Retrieve($env:SJC_SERVICE, $env:SJC_ACCOUNT))
  Write-Output 'removed'
} catch { Write-Output '${MISSING}' }`;
    const { stdout } = tryRun("powershell.exe", [...PS_FLAGS, script], {
      env: { ...process.env, SJC_SERVICE: service, SJC_ACCOUNT: account },
    });
    return stdout.trim() === "removed";
  },
};

/** macOS Keychain, through the `security` tool. */
const macosBackend: Backend = {
  name: "macos-keychain",

  available() {
    return tryRun("security", ["-h"]).stdout !== "" || tryRun("security", ["help"]).status === 0;
  },

  get(service, account) {
    const { status, stdout } = tryRun("security", [
      "find-generic-password",
      "-s",
      service,
      "-a",
      account,
      "-w",
    ]);
    return status === 0 && stdout.trim() !== "" ? stdout.trim() : undefined;
  },

  set(service, account, secret) {
    // `security` cannot take the secret on stdin, so it goes in argv here.
    // See the README note about shared machines.
    run("security", [
      "add-generic-password",
      "-s",
      service,
      "-a",
      account,
      "-w",
      secret,
      "-U",
    ]);
  },

  del(service, account) {
    return (
      tryRun("security", [
        "delete-generic-password",
        "-s",
        service,
        "-a",
        account,
      ]).status === 0
    );
  },
};

/** Linux: libsecret / gnome-keyring, through `secret-tool`. */
const linuxBackend: Backend = {
  name: "libsecret",

  available() {
    // `secret-tool --version` is not universally supported; a lookup that finds
    // nothing still proves the tool and the daemon are reachable.
    const { status, stdout } = tryRun("secret-tool", [
      "lookup",
      "service",
      "__safejsoncontext_probe__",
      "account",
      "probe",
    ]);
    return status === 0 || stdout === "";
  },

  get(service, account) {
    const { status, stdout } = tryRun("secret-tool", [
      "lookup",
      "service",
      service,
      "account",
      account,
    ]);
    return status === 0 && stdout !== "" ? stdout.trim() : undefined;
  },

  set(service, account, secret) {
    run(
      "secret-tool",
      [
        "store",
        "--label",
        `${service} (${account})`,
        "service",
        service,
        "account",
        account,
      ],
      { input: secret },
    );
  },

  del(service, account) {
    return (
      tryRun("secret-tool", ["clear", "service", service, "account", account])
        .status === 0
    );
  },
};

/**
 * Portable fallback: a 0600 file under the home directory. Weaker than a real
 * keychain — anything running as this user can read it — but it keeps the same
 * API working on machines that have no credential store at all.
 */
function fileBackend(dir: string): Backend {
  const pathFor = (service: string, account: string) =>
    join(dir, `${encodeURIComponent(service)}.${encodeURIComponent(account)}.key`);

  return {
    name: "file",

    available() {
      return true;
    },

    get(service, account) {
      try {
        return readFileSync(pathFor(service, account), "utf8").trim() || undefined;
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw error;
      }
    },

    set(service, account, secret) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = pathFor(service, account);
      writeFileSync(file, secret, { mode: 0o600 });
      try {
        chmodSync(file, 0o600);
      } catch {
        // Windows has no POSIX mode; the file inherits the directory ACL.
      }
    },

    del(service, account) {
      try {
        unlinkSync(pathFor(service, account));
        return true;
      } catch (error) {
        if (isNotFound(error)) return false;
        throw error;
      }
    },
  };
}

function nativeBackend(): Backend | undefined {
  switch (process.platform) {
    case "win32":
      return windowsBackend;
    case "darwin":
      return macosBackend;
    case "linux":
      return linuxBackend;
    default:
      return undefined;
  }
}

/** Probing costs a process spawn, so the answer is remembered per process. */
let probed: Backend | undefined | null = null;

function resolveBackend(fallback: Backend | undefined): Backend | undefined {
  if (probed === null) {
    const native = nativeBackend();
    probed = native && native.available() ? native : undefined;
  }
  return probed ?? fallback;
}

/**
 * An AES-256 key held by the operating system: Credential Manager on Windows,
 * Keychain on macOS, libsecret on Linux, with a key-file fallback elsewhere.
 * The platform is detected at runtime — calling code is the same everywhere.
 *
 * The key is generated on first use and read back on demand. Only the crypto
 * layer ever sees the bytes.
 */
export function osKeyStore(options: OsKeyStoreOptions = {}): KeyStore {
  const service = options.service ?? DEFAULT_SERVICE;
  const account = options.account ?? DEFAULT_ACCOUNT;
  const cacheKey = `${service} ${account}`;
  const fallback =
    options.fallback === "none"
      ? undefined
      : fileBackend(options.fallbackDir ?? join(homedir(), ".safejsoncontext"));

  function unsupported(): Error {
    return new Error(
      `No key store available on ${process.platform}: no OS keychain and the file fallback is disabled`,
    );
  }

  return {
    id: `${service}/${account}`,
    // Resolving costs a process spawn (the probe), so it happens here, on
    // first actual use, rather than when this store is constructed — a
    // JsonContext with no `encrypt` fields never has to pay it.
    get backend(): BackendName {
      return resolveBackend(fallback)?.name ?? "file";
    },

    exists(): SafeResult<boolean> {
      if (cache.has(cacheKey)) return ok(true);
      const backend = resolveBackend(fallback);
      if (!backend) return fail(unsupported());
      try {
        return ok(backend.get(service, account) !== undefined);
      } catch (error) {
        return fail(error);
      }
    },

    ensure(): SafeResult<boolean> {
      const backend = resolveBackend(fallback);
      if (!backend) return fail(unsupported());
      try {
        if (cache.has(cacheKey) || backend.get(service, account) !== undefined) {
          return ok(false);
        }
        backend.set(service, account, randomBytes(KEY_BYTES).toString("base64"));
        return ok(true);
      } catch (error) {
        return fail(error);
      }
    },

    remove(): SafeResult<boolean> {
      const backend = resolveBackend(fallback);
      if (!backend) return fail(unsupported());
      cache.delete(cacheKey);
      try {
        return ok(backend.del(service, account));
      } catch (error) {
        return fail(error);
      }
    },

    [KEY_MATERIAL](): SafeResult<Buffer> {
      const cached = cache.get(cacheKey);
      if (cached) return ok(cached);
      const backend = resolveBackend(fallback);
      if (!backend) return fail(unsupported());

      try {
        let encoded = backend.get(service, account);
        if (encoded === undefined) {
          encoded = randomBytes(KEY_BYTES).toString("base64");
          backend.set(service, account, encoded);
        }

        const key = Buffer.from(encoded, "base64");
        if (key.length !== KEY_BYTES) {
          return fail(
            new Error(
              `Key ${service}/${account} is ${key.length} bytes, expected ${KEY_BYTES}`,
            ),
          );
        }

        cache.set(cacheKey, key);
        return ok(key);
      } catch (error) {
        return fail(error);
      }
    },
  };
}

/**
 * An in-process key, for tests and for throwaway contexts. It offers none of
 * the protection of the OS store: the bytes live in this process only and are
 * gone when it exits.
 */
export function memoryKeyStore(key: Buffer = randomBytes(KEY_BYTES)): KeyStore {
  let current: Buffer | undefined = key;
  return {
    id: "memory",
    backend: "memory",
    exists: () => ok(current !== undefined),
    ensure: () => {
      if (current) return ok(false);
      current = randomBytes(KEY_BYTES);
      return ok(true);
    },
    remove: () => {
      const had = current !== undefined;
      current = undefined;
      return ok(had);
    },
    [KEY_MATERIAL]: () =>
      current
        ? ok(current)
        : fail(new Error("Key was removed from the memory keystore")),
  };
}

/** Drop cached key material and the cached backend probe for this process. */
export function clearKeyCache(): void {
  cache.clear();
  probed = null;
}
