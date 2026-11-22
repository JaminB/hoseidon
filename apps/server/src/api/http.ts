import type { Context, ErrorHandler } from 'hono';
import type { z } from 'zod';
import { LinkTapError } from '../linktap/client';

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 502,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

export async function body<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  const json: unknown = await c.req.json().catch(() => {
    throw new HttpError(400, 'invalid JSON body');
  });
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new HttpError(400, 'invalid body', parsed.error.issues);
  return parsed.data;
}

export function parseDate(value: string | undefined, fallback: Date): Date {
  if (!value) return fallback;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, `invalid date: ${value}`);
  return d;
}

/** Maps HttpError and LinkTapError to JSON responses; anything else is a 500. */
export const onApiError: ErrorHandler = (err, c) => {
  if (err instanceof HttpError) {
    return c.json({ error: err.message, detail: err.detail }, err.status);
  }
  if (err instanceof LinkTapError) {
    return c.json({ error: err.message }, err.kind === 'invalid' ? 400 : 502);
  }
  throw err;
};
