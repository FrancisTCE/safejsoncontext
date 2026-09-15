/**
 * Every public operation returns a result instead of throwing, so callers can
 * branch on `ok` without a try/catch around each call.
 */
export type SafeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: Error };

/** Shared successes: reused so the hot paths allocate nothing. */
export const OK_VOID = Object.freeze({
  ok: true,
  value: undefined,
}) as SafeResult<void>;

export const OK_MISSING = Object.freeze({
  ok: true,
  value: undefined,
}) as SafeResult<undefined>;

export function ok<T>(value: T): SafeResult<T> {
  return { ok: true, value };
}

export function fail<T = never>(error: unknown): SafeResult<T> {
  return {
    ok: false,
    error: error instanceof Error ? error : new Error(String(error)),
  };
}

/** True for the "file or directory is not there" errno. */
export function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/**
 * Windows reports a file that another process has open, or has started
 * deleting, as EPERM / EBUSY / EACCES. Those clear within milliseconds, so a
 * bounded retry is the correct response rather than a failure.
 */
export function isTransient(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

/** Parse JSON without throwing. */
export function safeParse<T = unknown>(input: string): SafeResult<T> {
  try {
    return { ok: true, value: JSON.parse(input) as T };
  } catch (error) {
    return fail(error);
  }
}

/**
 * Stringify without throwing. Values JSON cannot represent at the top level
 * (`undefined`, a function, a symbol) are reported as an error rather than
 * silently producing an empty file.
 */
export function safeStringify(
  value: unknown,
  space?: string | number,
): SafeResult<string> {
  let json: string | undefined;
  try {
    json = JSON.stringify(value, undefined, space);
  } catch (error) {
    return fail(error);
  }
  return json === undefined
    ? fail(new TypeError(`Value of type ${typeof value} is not JSON-serializable`))
    : { ok: true, value: json };
}
