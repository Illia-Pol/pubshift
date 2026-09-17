import { describe, expect, it } from 'vitest';

import { IRReadError, readIR } from '../src/ir/read';
import { extract, NOT_A_PUB } from './helpers';

describe('readIR', () => {
  it('reads a success envelope', () => {
    const ir = readIR('{"ok":true,"events":[{"t":"startDocument"},{"t":"text","s":"hi"}],"assets":{"a1":"QUJD"}}');
    expect(ir.events).toHaveLength(2);
    expect(ir.events[1]).toEqual({ t: 'text', s: 'hi' });
    expect(ir.assets).toEqual({ a1: 'QUJD' });
  });

  it('defaults assets to an empty map', () => {
    expect(readIR('{"ok":true,"events":[]}').assets).toEqual({});
  });

  it('throws the extractor’s own user-facing message for ok:false', () => {
    const raw = '{"ok":false,"error":{"code":"PARSE_FAILED","message":"The document could not be read."}}';
    expect(() => readIR(raw)).toThrowError(IRReadError);
    try {
      readIR(raw);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(IRReadError);
      expect((err as IRReadError).code).toBe('PARSE_FAILED');
      expect((err as IRReadError).message).toBe('The document could not be read.');
    }
  });

  it('reports malformed output as BAD_IR rather than crashing', () => {
    for (const raw of ['', '   ', 'not json', '[]', '{"ok":true}', '{"ok":true,"events":[{}]}', '{"ok":false}']) {
      let code: string | undefined;
      try { readIR(raw); } catch (err) { code = (err as IRReadError).code; }
      expect(code, JSON.stringify(raw)).toBe('BAD_IR');
    }
  });

  it('surfaces the real extractor’s rejection of a non-Publisher file', () => {
    try {
      readIR(extract(NOT_A_PUB));
      expect.unreachable('EDB-29664-1.pub is not a Publisher file and must be rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(IRReadError);
      expect((err as IRReadError).code).toBe('UNSUPPORTED');
      expect((err as IRReadError).message).toMatch(/Microsoft Publisher/);
    }
  });
});
