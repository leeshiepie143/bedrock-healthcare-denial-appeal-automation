import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

describe('Property Testing Setup', () => {
  it('should run fast-check property tests', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(typeof s).toBe('string');
      })
    );
  });
});
