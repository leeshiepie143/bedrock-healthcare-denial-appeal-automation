import { describe, it, expect } from 'vitest';

describe('Project Setup', () => {
  it('should have TypeScript configured correctly', () => {
    const value: string = 'denial-appeal-agent';
    expect(value).toBe('denial-appeal-agent');
  });

  it('should resolve @shared path alias', async () => {
    const shared = await import('@shared/index');
    expect(shared).toBeDefined();
  });
});
