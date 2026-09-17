/**
 * Parses and validates the extractor's stdout.
 *
 * The extractor's own failure messages are written for a non-technical reader,
 * so they are surfaced verbatim; only `BAD_IR` gets a message from here.
 */

import type { IREnvelope, IREvent, IRErrorCode, IRWire } from './types';

export class IRReadError extends Error {
  readonly code: IRErrorCode;

  constructor(code: IRErrorCode, message: string) {
    super(message);
    this.name = 'IRReadError';
    this.code = code;
    // Keeps `instanceof` working when this package is compiled down to ES5.
    Object.setPrototypeOf(this, IRReadError.prototype);
  }
}

const BAD_IR = 'We could not read the converter output for this file. Please try again, or send us the file so we can look at it.';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function readIR(raw: string): IREnvelope {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new IRReadError('BAD_IR', 'The converter produced no output for this file.');
  }

  let wire: unknown;
  try {
    wire = JSON.parse(raw);
  } catch {
    throw new IRReadError('BAD_IR', BAD_IR);
  }

  if (!isRecord(wire) || typeof wire.ok !== 'boolean') {
    throw new IRReadError('BAD_IR', BAD_IR);
  }

  if (wire.ok === false) {
    const err = (wire as { error?: unknown }).error;
    if (!isRecord(err) || typeof err.message !== 'string' || typeof err.code !== 'string') {
      throw new IRReadError('BAD_IR', BAD_IR);
    }
    throw new IRReadError(err.code as IRErrorCode, err.message);
  }

  const events = (wire as unknown as IRWire & { ok: true }).events;
  if (!Array.isArray(events)) throw new IRReadError('BAD_IR', BAD_IR);

  for (const e of events) {
    if (!isRecord(e) || typeof e.t !== 'string') throw new IRReadError('BAD_IR', BAD_IR);
  }

  const assets: Record<string, string> = {};
  const rawAssets = (wire as { assets?: unknown }).assets;
  if (rawAssets !== undefined) {
    if (!isRecord(rawAssets)) throw new IRReadError('BAD_IR', BAD_IR);
    for (const [k, v] of Object.entries(rawAssets)) {
      if (typeof v !== 'string') throw new IRReadError('BAD_IR', BAD_IR);
      assets[k] = v;
    }
  }

  return { events: events as IREvent[], assets };
}
