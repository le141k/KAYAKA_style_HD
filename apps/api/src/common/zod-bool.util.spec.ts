import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { optionalBoolParam, boolParamWithDefault } from './zod-bool.util';

describe('optionalBoolParam', () => {
  const schema = z.object({ flag: optionalBoolParam() });
  const parse = (v: unknown) => schema.parse({ flag: v }).flag;

  it('absent → undefined (filter not applied)', () => {
    expect(schema.parse({}).flag).toBeUndefined();
    expect(parse(undefined)).toBeUndefined();
  });

  it('parses truthy tokens → true', () => {
    for (const v of ['true', 'TRUE', '1', 'yes', 'on']) expect(parse(v)).toBe(true);
    expect(parse(true)).toBe(true);
  });

  it('parses "false"/"0"/"no" → false (the z.coerce.boolean footgun)', () => {
    for (const v of ['false', 'FALSE', '0', 'no', 'off', '']) expect(parse(v)).toBe(false);
    expect(parse(false)).toBe(false);
  });
});

describe('boolParamWithDefault', () => {
  const schema = z.object({ flag: boolParamWithDefault(false) });
  it('absent → the default', () => {
    expect(schema.parse({}).flag).toBe(false);
    expect(z.object({ flag: boolParamWithDefault(true) }).parse({}).flag).toBe(true);
  });
  it('"false" → false (not coerced to true)', () => {
    expect(schema.parse({ flag: 'false' }).flag).toBe(false);
  });
  it('"true" → true', () => {
    expect(schema.parse({ flag: 'true' }).flag).toBe(true);
  });
});
