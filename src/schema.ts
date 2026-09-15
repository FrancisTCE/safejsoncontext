import { type SafeResult, fail, ok } from "./result.js";

/**
 * The Standard Schema interface (standardschema.dev), which zod, valibot,
 * arktype and others implement. Declaring it here means any of them plugs in
 * without this package depending on any of them.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => StandardResult<Output> | Promise<StandardResult<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output };
  };
}

export interface StandardIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
}

export type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<StandardIssue> };

/** Output type of a schema, for inferring the context's `T` from it. */
export type InferOutput<S> = S extends StandardSchemaV1<unknown, infer O> ? O : never;

export class SchemaError extends Error {
  readonly issues: ReadonlyArray<StandardIssue>;

  constructor(issues: ReadonlyArray<StandardIssue>) {
    super(
      issues
        .map((issue) => {
          const path = issue.path
            ?.map((p) => (typeof p === "object" ? String(p.key) : String(p)))
            .join(".");
          return path ? `${path}: ${issue.message}` : issue.message;
        })
        .join("; ") || "Schema validation failed",
    );
    this.name = "SchemaError";
    this.issues = issues;
  }
}

function settle<T>(result: StandardResult<T>): SafeResult<T> {
  return result.issues ? fail(new SchemaError(result.issues)) : ok(result.value);
}

/** Validate synchronously; a schema that insists on being async is an error here. */
export function validateSync<T>(
  schema: StandardSchemaV1<unknown, T>,
  value: unknown,
): SafeResult<T> {
  let result: StandardResult<T> | Promise<StandardResult<T>>;
  try {
    result = schema["~standard"].validate(value);
  } catch (error) {
    return fail(error);
  }
  if (result instanceof Promise) {
    return fail(
      new Error(
        `Schema from ${schema["~standard"].vendor} validates asynchronously; use the async API`,
      ),
    );
  }
  return settle(result);
}

export async function validateAsync<T>(
  schema: StandardSchemaV1<unknown, T>,
  value: unknown,
): Promise<SafeResult<T>> {
  try {
    return settle(await schema["~standard"].validate(value));
  } catch (error) {
    return fail(error);
  }
}
