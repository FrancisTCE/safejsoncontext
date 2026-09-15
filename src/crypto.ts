import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { type SafeResult, fail, ok } from "./result.js";

const ALGORITHM = "aes-256-gcm";
/** 96-bit nonce, the size GCM is defined for. A fresh one per value. */
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * What an encrypted field looks like on disk. The marker is self-describing, so
 * a reader can tell an encrypted value from a plain one without a schema, and a
 * process without the key can still parse and pass the file around.
 */
export interface EncryptedValue {
  __enc: 1;
  alg: typeof ALGORITHM;
  iv: string;
  tag: string;
  data: string;
}

export function isEncrypted(value: unknown): value is EncryptedValue {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as EncryptedValue).__enc === 1 &&
    typeof (value as EncryptedValue).data === "string"
  );
}

/**
 * Encrypt one field. The field name is authenticated as additional data, so a
 * ciphertext cannot be moved to a different key in the file without the
 * authentication tag failing.
 */
export function encryptValue(
  key: Buffer,
  field: string,
  value: unknown,
): SafeResult<EncryptedValue> {
  let plaintext: string | undefined;
  try {
    plaintext = JSON.stringify(value);
  } catch (error) {
    return fail(error);
  }
  if (plaintext === undefined) {
    return fail(
      new TypeError(`Value of field ${field} is not JSON-serializable`),
    );
  }

  try {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    cipher.setAAD(Buffer.from(field, "utf8"));
    const data = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    return ok({
      __enc: 1,
      alg: ALGORITHM,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    });
  } catch (error) {
    return fail(error);
  }
}

/** Decrypt one field. A tampered value fails here rather than being returned. */
export function decryptValue(
  key: Buffer,
  field: string,
  envelope: EncryptedValue,
): SafeResult<unknown> {
  if (envelope.alg !== ALGORITHM) {
    return fail(new Error(`Unsupported algorithm ${String(envelope.alg)}`));
  }

  try {
    const tag = Buffer.from(envelope.tag, "base64");
    if (tag.length !== TAG_BYTES) {
      return fail(new Error(`Field ${field} has a malformed authentication tag`));
    }

    const decipher = createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(envelope.iv, "base64"),
    );
    decipher.setAAD(Buffer.from(field, "utf8"));
    decipher.setAuthTag(tag);

    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, "base64")),
      decipher.final(),
    ]).toString("utf8");

    return ok(JSON.parse(plaintext));
  } catch (error) {
    return fail(error);
  }
}

/** Which top-level fields a request wants encrypted. */
export type FieldSelection = boolean | readonly string[];

function selected(fields: FieldSelection, field: string): boolean {
  return fields === true ? true : fields === false ? false : fields.includes(field);
}

/** Encrypt the selected top-level values, leaving the key names in the clear. */
export function encryptRecord(
  key: Buffer,
  record: Record<string, unknown>,
  fields: FieldSelection,
): SafeResult<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(record)) {
    if (!selected(fields, field) || isEncrypted(value)) {
      out[field] = value;
      continue;
    }
    const encrypted = encryptValue(key, field, value);
    if (!encrypted.ok) return encrypted;
    out[field] = encrypted.value;
  }
  return ok(out);
}

/** Decrypt every encrypted top-level value. Plain values are passed through. */
export function decryptRecord(
  key: Buffer,
  record: Record<string, unknown>,
): SafeResult<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(record)) {
    if (!isEncrypted(value)) {
      out[field] = value;
      continue;
    }
    const decrypted = decryptValue(key, field, value);
    if (!decrypted.ok) return decrypted;
    out[field] = decrypted.value;
  }
  return ok(out);
}

/** The names of the fields that are stored encrypted. */
export function encryptedFields(record: Record<string, unknown>): string[] {
  return Object.entries(record)
    .filter(([, value]) => isEncrypted(value))
    .map(([field]) => field);
}
