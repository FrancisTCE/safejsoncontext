# safejsoncontext

Just to be clear, the reason I created this repo was because i was using this for RHI agentic context, its usefull if well used, I decided to clean it up a repack it as a npm pkg (https://www.npmjs.com/package/safejsoncontext)

A JSON file with per-field access, field-level encryption under a key the
operating system holds, optional schema validation, and a cross-process lock
around every mutation. Built for agentic context: the file stays readable and
diffable, but anything declared sensitive is ciphertext on disk **and**
ciphertext to any reader that does not explicitly ask.

- **Safe:** nothing throws, every call returns a result; every mutation is
  exclusive across processes; a forgotten flag hides, it never leaks.
- **Fast:** one syscall per read with no lock; atomic rename per write; the
  keychain is touched at most once per process, and only when plaintext of a
  secret is actually needed.
- **OS agnostic:** identical calls on Windows, macOS and Linux; the key store is
  probed at runtime.

## Install

```sh
npm install safejsoncontext
```

## Quick start

```js
import { createContext } from "safejsoncontext";

const ctx = createContext("./.agent/context.json", {
  defaults: { model: "claude-opus-5", turns: 0, memory: [], apiKey: "" },
  encrypt: ["apiKey"],
});

ctx.init();                                    // create from defaults if missing
ctx.set("apiKey", "sk-ant-…");                 // encrypted on the way to disk
ctx.update("turns", (n) => n + 1);             // locked read-modify-write
ctx.update("memory", (m) => [...m, "user prefers metric units"]);

ctx.get("turns");                              // { ok: true, value: 1 }
ctx.get("apiKey");                             // { ok: false, error: … use reveal("apiKey") }
ctx.reveal("apiKey");                          // { ok: true, value: "sk-ant-…" }
```

An agent context that survives restarts: the model choice and the memory it has
accumulated stay readable and diffable, the credential does not. Two agent
processes incrementing `turns` on the same file cannot lose a turn. Nothing
touches the disk until a method runs — the directory is created on the first
write.

### Session context — the same thing, in memory

Per-conversation variables that must not outlive the process: turn counters,
tool history, the end user's token for this thread.

```js
import { createSessionContext } from "safejsoncontext";

const session = createSessionContext("thread-42", {
  defaults: { turn: 0, toolCalls: [], userToken: "" },
  encrypt: ["userToken"],
});

session.set("userToken", "ya29.a0Ae…");            // the end user's OAuth token
session.update("turn", (n) => n + 1);
session.update("toolCalls", (calls) => [...calls, "search_docs"]);

session.get("userToken");      // { ok: false, error: … use reveal("userToken") }
session.reveal("userToken");   // { ok: true, value: "ya29.a0Ae…" }
```

Identical API, but the document lives in this process only: never written
anywhere, gone when the process exits. Every handle created with the same name
shares the same document, so the model loop, a tool handler and a subagent can
all meet at one thread id without a reference being passed around. Meant for
sensitive working state — the censored `read()` / `get()` behaviour is still
what every caller gets unless they `reveal`, so a tool that dumps its session
for a trace logs `{ __enc: 1, … }` where the user's token is. Session secrets
are encrypted under a key that lives in the process by default
(`keystore.backend === "memory"`); pass `keystore: osKeyStore()` if their
envelopes must be readable by a file context later.

`hasSession(name)`, `sessionNames()` and `dropSession(name)` manage the
per-process registry. `pretty`, `durable` and `lock` do not apply.

### Results, not exceptions

```ts
type SafeResult<T> = { ok: true; value: T } | { ok: false; error: Error };
```

A missing file is not an error: reads return `defaults` (or `undefined`). A
corrupt file, a schema violation, a wrong key, a lock timeout, or a value JSON
cannot represent all come back as `{ ok: false, error }` — and a failed
mutation never leaves a partial file behind.

## API

Every method has an async twin with the `Async` suffix (`getAsync`, `setAsync`,
…) that returns the same result in a `Promise`. `updateAsync` also accepts an
async callback.

### Per field

| Method | Returns | Notes |
| --- | --- | --- |
| `get(key)` | `T[K] \| undefined` | Refuses an encrypted field. Falls back to `defaults`. |
| `reveal(key)` | `T[K] \| undefined` | `get`, but decrypts. The one way to plaintext. |
| `set(key, value)` | `void` | Encrypted if `key` is declared in `encrypt`. |
| `update(key, fn)` | `T[K]` | `fn` sees the current plaintext (or the default). |
| `has(key)` | `boolean` | Present in the file, encrypted or not. |
| `delete(key)` | `boolean` | `false` when it was not there. |

### Whole file

| Method | Returns | Notes |
| --- | --- | --- |
| `exists()` | `boolean` | |
| `init(doc?)` | `boolean` | Create from `doc`, else `defaults`, else `{}`. No-op if present. |
| `read({ decrypt? })` | `T \| undefined` | Censored unless `decrypt: true`. |
| `write(doc)` | `void` | Replace everything. Validated, encrypted, atomic. |
| `update(fn)` | `T` | `fn` sees the fully decrypted document. |
| `remove()` | `boolean` | Delete the file. |
| `encryptedFields()` | `string[]` | |
| `path`, `dir`, `keystore` | | Absolute paths (or `memory://…`); key lifecycle, never key bytes. |

### Options

```ts
createContext<T>("./path/to/context.json", {
  defaults: T,                      // start state for init(), reads, and mutations
  encrypt: ["apiKey"] | true,       // which top-level values are stored encrypted
  schema: StandardSchemaV1,         // zod / valibot / arktype; gives T, validates
  keystore: osKeyStore(),           // where the AES key lives
  lock: { timeout: 5000, stale: 10000 } | false,
  pretty: false | true | number,
  durable: false,                   // fsync before rename
});
```

### Types and autocomplete

`T` is the shape of the document. It comes from one of three places, in order
of convenience:

```ts
// 1. from defaults
const ctx = createContext("…", { defaults: { turns: 0, apiKey: "" } });

// 2. from a schema — types and runtime validation from one source
const ctx = createContext("…", { schema: z.object({ turns: z.number(), apiKey: z.string() }) });

// 3. explicitly
interface AgentContext { model: string; turns: number; apiKey: string }
const ctx = createContext<AgentContext>("…");
```

All three give you `ctx.get("tu` completing to `turns`, `ctx.set("turns", "x")`
as a type error, and `encrypt: ["apiKe` completing too.

## Encryption

Declare the secret fields once, on the handle. After that there is no flag to
forget: `set`, `update`, `write` and `init` all encrypt those fields on the way
to disk.

On disk, the field name stays readable and the value does not:

```json
{
  "model": "claude-opus-5",
  "turns": 12,
  "memory": ["user prefers metric units"],
  "apiKey": { "__enc": 1, "alg": "aes-256-gcm", "iv": "…", "tag": "…", "data": "…" }
}
```

Reading is where the safety property lives:

| Call | Secret field comes back as |
| --- | --- |
| `get("apiKey")` | **an error** — not an envelope, not plaintext |
| `read()` | an envelope |
| `reveal("apiKey")` | plaintext |
| `read({ decrypt: true })` | plaintext |

So anything that reads without asking — a tool, a log, a subagent, a `cat` —
gets nothing sensitive, and every place plaintext is exposed is findable with
`grep reveal(`.

Mutations that only touch plain fields pass existing envelopes through
untouched and never ask the key store for anything; `update` on a secret field
decrypts just that field for the callback and re-encrypts with a fresh IV.

### Where the key lives

A 256-bit AES key, generated on first use and held by the operating system:

| Platform | Store |
| --- | --- |
| Windows | Credential Manager (WinRT `PasswordVault`) |
| macOS | Keychain (`security`) |
| Linux | libsecret / gnome-keyring (`secret-tool`) |
| anything else, or no keyring | `~/.safejsoncontext/*.key`, mode 0600 |

Same code everywhere — the backend is probed at runtime and reported as
`ctx.keystore.backend`. Pass `fallback: "none"` to fail instead of using the
key file.

**The key is never exposed.** `KeyStore` can `ensure`, `exists` and `remove` a
key; nothing on the public API returns key material. The bytes travel from the
store to the cipher through a module-private symbol that is not exported.

```js
import { osKeyStore } from "safejsoncontext";

// One key per agent per environment: the dev agent cannot read prod's context.
const store = osKeyStore({ service: "research-agent", account: "prod" });
store.ensure();   // { ok: true, value: true } when it created one
store.remove();   // anything encrypted with it is now unreadable

createContext("./.agent/context.json", { encrypt: ["apiKey"], keystore: store });
```

`memoryKeyStore(key?)` is the in-process store for tests. It protects nothing.

### Crypto details

AES-256-GCM, a fresh 96-bit IV per value, and the **field name authenticated as
additional data**, so a ciphertext moved from `memory` to `apiKey` fails the tag
check. Values are JSON-encoded before encryption, so any JSON value works.
Tampering fails the read rather than returning a wrong value.

### What this does and does not protect

- Protects the file at rest and from anything that can read the file but is not
  this OS user — backups, syncs, repos, an agent tool that slurps the directory.
- Does **not** protect against code running as you: anything that can call
  `reveal` can read the plaintext, because the OS will hand it the key.
- Field names, the shape of the file, and value sizes stay visible.
- On macOS the key passes to `security` in argv during creation, briefly
  visible to other processes on a shared machine. Windows and Linux use the
  environment and stdin respectively.

## Schema

Any [Standard Schema](https://standardschema.dev) — zod, valibot, arktype, or a
hand-written object — plugs in with no dependency on any of them.

```js
import { z } from "zod";

const ctx = createContext("./.agent/context.json", {
  schema: z.object({
    model: z.enum(["claude-opus-5", "claude-sonnet-5"]),
    turns: z.number().int().nonnegative(),
    apiKey: z.string().startsWith("sk-ant-"),
  }),
  encrypt: ["apiKey"],
});

ctx.set("turns", "seven");   // { ok: false, error: SchemaError: turns: Expected number … }
ctx.set("model", "gpt-4");   // { ok: false, error: SchemaError: model: … } — nothing written
```

Pinning the model to an enum and the key to a prefix means a hand-edited
context file, or an agent that writes its own config, cannot put the loop into
a state the code does not expect.

The schema describes the **plaintext** document. It runs on every mutation
(before encryption — nothing invalid reaches the disk) and on every decrypted
read, which also catches a file edited by hand. A censored `read()` that still
contains envelopes is not validated. A schema that validates asynchronously is
refused by the sync API and honoured by the async one.

## Locking

Every mutation — `set`, `update`, `delete`, `write`, `init`, `remove` — runs
under an exclusive lock, so two processes doing read-modify-write on the same
file cannot lose an update. Reads take no lock: a rename-based write means a
reader sees the old file or the new one, never a torn one.

How it works:

- The lock is `<file>.lock`, holding the owner's pid, released by `unlink`.
  It is created by writing the payload to a private temp file and **hard
  linking** it to the lock path: `link` is atomic and fails with `EEXIST` if
  the lock exists, so the lock is never observable without its payload. On a
  filesystem without hard links (FAT, some network mounts) creation falls
  back to `O_EXCL` + write, and the stale check below is written so that the
  brief empty-file window on that path is harmless.
- A contender waits with exponential backoff (1 ms → 50 ms) up to `timeout`
  (default 5 s), then fails with `{ ok: false }` naming the holder's pid.
- A lock whose pid no longer exists is broken immediately. A lock older than
  `stale` (default 10 s) is broken even if its pid is alive — a holder that is
  wedged. Age is judged by the file's mtime, never by its payload, and an
  unreadable payload is never grounds for breaking a lock.
- Async calls on the same file **in one process** queue behind each other
  rather than contending on disk. A **sync** call made while an async call is
  in flight fails fast (`… in flight in this process; await it first`) rather
  than blocking the thread the async call needs to finish.
- `lock: false` turns it off for a file you know a single process owns.

The test suite runs six processes hammering one file and checks that every
increment lands; the same test with `lock: false` demonstrably loses updates.

Honest limit: if a holder is alive but stalls for longer than `stale`, a
contender will break its lock, and the two can then overlap for one write. Set
`stale` above your longest plausible critical section (they are milliseconds
by default).

## How it stays fast

- **One syscall per read, no lock.** `readFileSync(path, "utf8")` with no
  `stat` first; a missing file is recognised from ENOENT.
- **Atomic writes.** Content goes to a sibling temp file and is `rename`d over
  the target — a reader sees old or new, never a partial file.
- **Lock only what needs it.** Reads are lock-free; mutations hold the lock for
  one read-modify-write, in the tens of microseconds.
- **The keychain is lazy.** Untouched until a call needs plaintext of a secret
  field; then the key is cached for the process (`clearKeyCache()` drops it).
- **`fsync` is opt-in.** It costs more than the rest of a small write combined.
- **Sync by default.** For files this size the sync calls beat the threadpool
  round-trip; the async API exists for when you must not block the loop.

```sh
npm run bench
```

## Development

```sh
npm install
npm test          # builds, then runs node:test against dist/
npm run showcase  # every operation, run for real, with its output
npm run bench
```

The keychain test uses its own service name and removes the credential
afterwards; it skips itself where no keyring is reachable.

## An honest account

Everything above says what the library does. This section says what it does
*not* do, what has actually been verified versus merely written, and where the
edges are. Read it before trusting the library with anything that matters.

### What has actually been run

| Claim | Status |
| --- | --- |
| Results, never throws | Tested (62 tests) |
| Atomic writes via temp + rename | Tested on NTFS only |
| Cross-process lock loses no updates | Tested: 6 processes × 40 increments, both APIs, repeated runs; the same test with `lock: false` demonstrably loses updates |
| Hard-linked lock creation | Tested on NTFS. `_linkSupported()` reports `true` here |
| `O_EXCL` fallback | Tested by forcing it; **never** exercised by a real filesystem that lacks links |
| Windows sharing-violation retries | Fixed a real failure in the stress test; the retry bound (~300 ms) is a guess |
| AES-256-GCM, field name as AAD, tamper detection | Tested (swap, bit-flip, wrong key) |
| Windows Credential Manager backend | Tested end to end, including reading the key back through a fresh store after the cache is cleared |
| macOS Keychain backend (`security`) | **Written from documentation. Never executed.** |
| Linux libsecret backend (`secret-tool`) | **Written from documentation. Never executed.** The `available()` probe is a best guess |
| Key-file fallback | Tested by faking `process.platform` |
| Standard Schema integration | Tested with a hand-written schema. Never run against real zod / valibot / arktype |
| In-memory session context | Tested |
| Sync-during-async fails fast | Tested |

No one outside this conversation has read
the code. The cryptography has not been reviewed by anyone who does that for a
living.

### What "safe" means here, and what it does not

#### Encryption

- **Protects against:** anything that can read the file but is not this OS
  user — backups, sync clients, a repo you accidentally commit it to, a tool
  that slurps the directory, a subagent handed a `read()`.
- **Does not protect against:** code running as you. Any process running as
  this user can ask the OS for the key. `reveal` is a convention that makes
  plaintext access greppable; it is not an access control.
- **Key in memory.** After the first `reveal`, the key sits in this process's
  heap for the life of the process. It is not zeroised. A memory dump, a core
  file, or a debugger gets it. `clearKeyCache()` drops the reference; it does
  not scrub the bytes.
- **Plaintext in memory.** Every decrypted value is an ordinary JavaScript
  string. Strings are immutable and garbage-collected; they may be copied by
  the engine and may linger until collected. There is no secure-erase.
- **What stays visible:** field names, which fields are encrypted, the shape of
  the document, and the approximate length of every encrypted value (ciphertext
  length equals plaintext length plus 16 bytes).
- **Nonces:** a random 96-bit IV per value. Collision under one key becomes a
  concern around 2³² encryptions; for a context file it is not a concern, but
  there is no counter and no key-rotation API to make it one you can manage.
- **No key rotation.** `store.remove()` then a new key makes existing
  envelopes permanently unreadable. Rotating means `read({ decrypt: true })`
  with the old key and `write()` with the new one, by hand.
- **Encryption is top-level only.** `encrypt: ["config"]` encrypts the whole
  `config` object as one value. It cannot encrypt `config.apiKey` alone.

#### The key store

- **First-use race.** Two processes that both find no key and both generate one
  will each store their own; the loser's data is unreadable by the winner's
  key. There is no cross-process lock around key creation. Call `ensure()`
  once at install or start-up, single-process, before anything else.
- **Windows: credentials may roam.** `PasswordVault` credentials are the same
  store as Windows "Web Credentials", which can sync between devices signed in
  to the same Microsoft account. That may be what you want or the opposite.
- **Windows: first fetch is slow.** Each key-store operation spawns PowerShell
  (~1–2 s). The key is fetched once per process and cached; `exists()` and
  `ensure()` each pay the cost.
- **macOS: the key is in argv** of `security add-generic-password` during
  creation, visible to `ps` on a shared machine for that instant.
- **The file fallback is not a keychain.** `~/.safejsoncontext/*.key` at mode
  0600 is exactly as protected as any other file you own. On Windows the mode
  bits are meaningless and the file relies on the directory ACL. `backend`
  tells you when you are on it; `fallback: "none"` refuses it.
- **The "never exposed" claim is a module boundary, not a sandbox.** Key bytes
  travel through a symbol that is not exported from the package. Anything that
  can `import "safejsoncontext/dist/keystore.js"` or enumerate symbols can get
  them. The guarantee is "no supported API returns the key", nothing stronger.

#### Locking

- **Alive-but-stalled holders get broken.** A holder that stays alive but
  holds the lock longer than `stale` (10 s) is treated as wedged and its lock
  is removed. If it then wakes up and finishes its write, it and the breaker
  overlap for one write. Set `stale` above your longest plausible critical
  section. The defaults assume milliseconds.
- **pid reuse.** A dead holder's pid can be reused by an unrelated process, in
  which case the lock is judged live and waited on until it goes stale. That is
  the safe direction, but it costs up to `stale` of waiting.
- **The link-support flag is global.** The first `link` failure that is not
  `EEXIST` switches the whole process to the `O_EXCL` path for every file
  thereafter, including files on filesystems that do support links.
- **Not tested on network filesystems.** NFS, SMB and their friends have their
  own opinions about `link`, `rename`, `O_EXCL` and mtime. Nothing here has
  been run on one.
- **Reads are not locked, by design.** A read during a write sees old or new,
  never torn. It can still see *stale* — a value that a lock holder is about
  to replace. If you need read-your-own-writes across processes, do the read
  inside `update`.
- **`lock: false` means it.** No lock, no directory creation before write, and
  the sharing-violation retry is your only protection on Windows.
- **In-process, sync and async do not mix.** A sync mutation while an async
  one is in flight fails immediately with a result. This is deliberate — the
  alternative is a deadlock — but it means code that mixes the two APIs on one
  file needs to expect that error.
- **Windows retries are bounded.** Under heavy contention with lock-free
  readers, a rename can exhaust its ~12 attempts and fail. It fails as a
  result, not a throw, and the file is left intact; the write is simply lost
  and reported.

#### Session contexts

- "Never written to disk" means the library never writes it. The operating
  system can still page the process's memory to swap, and a crash dump
  contains the heap.
- The document is held as a JSON string and re-parsed on every read. That is
  what makes the semantics identical to a file; it also means every read
  allocates a fresh copy and every encrypted value has its ciphertext (not its
  plaintext) sitting in the string.
- Sessions are per process. Two processes with the same session name have two
  unrelated sessions. There is no cross-process anything.
- `dropSession` forgets the document; it does not scrub it.

#### Schema

- The schema describes plaintext, so a censored `read()` containing envelopes
  is **not** validated. Only decrypted reads and writes are.
- Schema output is what gets written. A schema that transforms (defaults,
  coercion, stripping unknown keys) silently rewrites your document on every
  mutation. That is usually what you want; it is worth knowing.
- Whole-object schemas mean every mutation with a schema decrypts every secret
  field to validate, which touches the key store on the first one even when
  you only changed `turns`.

#### Performance

"Fastest possible" is a design goal, not a measurement against anything else.
On this machine, with Defender scanning every file it sees:

```
read                   ~3 300 ops/s
write (locked)         ~1 400 ops/s
set / update(key)      ~  900 ops/s
set on a secret        ~  830 ops/s
```

A lock costs roughly one `write`. A mutation is a read plus a locked write.
Numbers on a Linux tmpfs would look nothing like these.

### Semantics that may surprise

- `has(key)` reports the stored document. `get(key)` falls back to `defaults`.
  So `get` can return a value for which `has` is `false`.
- A mutation on a missing document starts from the *whole* `defaults`, not an
  empty object. `set("a", 1)` on a fresh context with `defaults: { b: 2 }`
  stores `{ b: 2, a: 1 }`.
- `get` of an encrypted field is an **error**, not an envelope. `read()` is the
  way to see envelopes.
- `update(fn)` on the whole document decrypts everything for `fn`, which needs
  the key. `update(key, fn)` decrypts only that key. `set` decrypts nothing.
- JSON semantics apply in memory too: functions and `undefined` fields vanish,
  `Date` becomes a string, `Map` becomes `{}`.

### Housekeeping

- Version `0.1.0`. The API has already changed shape twice. Nothing is stable
  until a `1.0.0` says so.
- No `CHANGELOG`.
- The `_setLinkSupport` / `_linkSupported` exports in `dist/lock.js` are test
  hooks and are not part of the package's public surface.

If any of the above is a problem for your use, the honest recommendation is to
fix it before depending on the library, not after.

## License

MIT
