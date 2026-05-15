import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  extractEditPatterns,
  getPreferences,
  recordUserEdit,
  applyPreferences,
  buildPreferenceSK,
  type UserPreferenceRecord,
  type SampleEdit,
} from '@lambdas/generator/preference-tracker';

// ─── Test Helpers ───────────────────────────────────────────────────────────

function makeMockDynamoClient(getItem: unknown = null) {
  return {
    send: vi.fn().mockImplementation((command: any) => {
      if (command.constructor.name === 'GetCommand') {
        return Promise.resolve({ Item: getItem });
      }
      if (command.constructor.name === 'PutCommand') {
        return Promise.resolve({});
      }
      return Promise.resolve({});
    }),
  } as any;
}

function makePreferenceRecord(overrides: Partial<UserPreferenceRecord> = {}): UserPreferenceRecord {
  return {
    PK: 'TENANT#test-tenant',
    SK: 'PREF#payer-001#CO-50',
    payer_id: overrides.payer_id ?? 'payer-001',
    denial_reason_code: overrides.denial_reason_code ?? 'CO-50',
    preferred_phrases: overrides.preferred_phrases ?? ['Medical necessity is clearly documented'],
    preferred_structure: overrides.preferred_structure ?? ['added: RE: Appeal for Claim'],
    edit_count: overrides.edit_count ?? 3,
    last_edited_at: overrides.last_edited_at ?? '2024-06-15T10:00:00.000Z',
    sample_edits: overrides.sample_edits ?? [
      {
        original_snippet: 'We are writing to appeal the denial of claim 12345.',
        edited_snippet: 'We respectfully request reconsideration of the denial for claim 12345.',
      },
    ],
  };
}

// ─── Tests: buildPreferenceSK ───────────────────────────────────────────────

describe('buildPreferenceSK', () => {
  it('should build correct sort key format', () => {
    expect(buildPreferenceSK('payer-001', 'CO-50')).toBe('PREF#payer-001#CO-50');
  });

  it('should handle payer IDs with special characters', () => {
    expect(buildPreferenceSK('payer_abc-123', 'CO-97')).toBe('PREF#payer_abc-123#CO-97');
  });
});

// ─── Tests: extractEditPatterns ─────────────────────────────────────────────

describe('extractEditPatterns', () => {
  it('should identify added phrases', () => {
    const original = 'We are writing to appeal the denial. The claim was denied on January 15.';
    const edited = 'We are writing to appeal the denial. The claim was denied on January 15. Medical necessity is clearly supported by the clinical documentation.';

    const patterns = extractEditPatterns(original, edited);

    expect(patterns.added_phrases.length).toBeGreaterThan(0);
    expect(patterns.added_phrases.some(p => p.includes('Medical necessity'))).toBe(true);
  });

  it('should identify removed phrases', () => {
    const original = 'We are writing to appeal the denial. This is a routine request for reconsideration.';
    const edited = 'We are writing to appeal the denial.';

    const patterns = extractEditPatterns(original, edited);

    expect(patterns.removed_phrases.length).toBeGreaterThan(0);
    expect(patterns.removed_phrases.some(p => p.includes('routine request'))).toBe(true);
  });

  it('should detect structural changes when sections are added', () => {
    const original = 'Dear Appeals Department,\nWe are writing to appeal.';
    const edited = 'RE: Appeal for Claim 12345\nDear Appeals Department,\nWe are writing to appeal.';

    const patterns = extractEditPatterns(original, edited);

    expect(patterns.structure_changes.some(s => s.startsWith('added:'))).toBe(true);
  });

  it('should return empty patterns when letters are identical', () => {
    const letter = 'We are writing to appeal the denial of claim 12345. The patient was treated on January 15.';

    const patterns = extractEditPatterns(letter, letter);

    expect(patterns.added_phrases).toEqual([]);
    expect(patterns.removed_phrases).toEqual([]);
    expect(patterns.structure_changes).toEqual([]);
  });

  it('should filter out very short phrases', () => {
    const original = 'Hi. We appeal.';
    const edited = 'Hi. We appeal. OK.';

    const patterns = extractEditPatterns(original, edited);

    // Short phrases (< 10 chars) should be filtered out
    expect(patterns.added_phrases.every(p => p.length >= 10)).toBe(true);
  });

  it('should filter out very long phrases', () => {
    const longPhrase = 'A'.repeat(250);
    const original = 'We are writing to appeal the denial of this claim.';
    const edited = `We are writing to appeal the denial of this claim. ${longPhrase}`;

    const patterns = extractEditPatterns(original, edited);

    expect(patterns.added_phrases.every(p => p.length <= 200)).toBe(true);
  });

  it('should handle empty original letter', () => {
    const original = '';
    const edited = 'We are writing to appeal the denial of claim 12345.';

    const patterns = extractEditPatterns(original, edited);

    expect(patterns.added_phrases.length).toBeGreaterThanOrEqual(0);
    expect(patterns.removed_phrases).toEqual([]);
  });

  it('should handle empty edited letter', () => {
    const original = 'We are writing to appeal the denial of claim 12345.';
    const edited = '';

    const patterns = extractEditPatterns(original, edited);

    expect(patterns.removed_phrases.length).toBeGreaterThanOrEqual(0);
    expect(patterns.added_phrases).toEqual([]);
  });
});

// ─── Tests: getPreferences ──────────────────────────────────────────────────

describe('getPreferences', () => {
  it('should return preference record when it exists', async () => {
    const record = makePreferenceRecord();
    const client = makeMockDynamoClient(record);

    const result = await getPreferences(client, 'test-tenant', 'payer-001', 'CO-50');

    expect(result).toEqual(record);
    expect(client.send).toHaveBeenCalledTimes(1);
  });

  it('should return null when no preference exists', async () => {
    const client = makeMockDynamoClient(null);

    const result = await getPreferences(client, 'test-tenant', 'payer-001', 'CO-50');

    expect(result).toBeNull();
  });

  it('should use correct PK and SK for the query', async () => {
    const client = makeMockDynamoClient(null);

    await getPreferences(client, 'tenant-abc', 'payer-xyz', 'CO-97');

    const sentCommand = client.send.mock.calls[0][0];
    expect(sentCommand.input.Key).toEqual({
      PK: 'TENANT#tenant-abc',
      SK: 'PREF#payer-xyz#CO-97',
    });
  });

  it('should use the provided table name', async () => {
    const client = makeMockDynamoClient(null);

    await getPreferences(client, 'test-tenant', 'payer-001', 'CO-50', 'CustomTable');

    const sentCommand = client.send.mock.calls[0][0];
    expect(sentCommand.input.TableName).toBe('CustomTable');
  });
});

// ─── Tests: recordUserEdit ──────────────────────────────────────────────────

describe('recordUserEdit', () => {
  it('should create a new preference record when none exists', async () => {
    const client = makeMockDynamoClient(null);

    const result = await recordUserEdit(
      client,
      'test-tenant',
      'payer-001',
      'CO-50',
      'We are writing to appeal the denial of claim 12345.',
      'We respectfully request reconsideration of the denial for claim 12345.'
    );

    expect(result.payer_id).toBe('payer-001');
    expect(result.denial_reason_code).toBe('CO-50');
    expect(result.edit_count).toBe(1);
    expect(result.sample_edits).toHaveLength(1);
    expect(result.PK).toBe('TENANT#test-tenant');
    expect(result.SK).toBe('PREF#payer-001#CO-50');
  });

  it('should update existing preference record and increment edit count', async () => {
    const existing = makePreferenceRecord({ edit_count: 2 });
    const client = makeMockDynamoClient(existing);

    const result = await recordUserEdit(
      client,
      'test-tenant',
      'payer-001',
      'CO-50',
      'Original letter content for the appeal of this claim.',
      'Edited letter content with user preferred language for this claim.'
    );

    expect(result.edit_count).toBe(3);
  });

  it('should keep only the last 5 sample edits', async () => {
    const existingEdits: SampleEdit[] = Array.from({ length: 5 }, (_, i) => ({
      original_snippet: `Original ${i}`,
      edited_snippet: `Edited ${i}`,
    }));
    const existing = makePreferenceRecord({
      edit_count: 5,
      sample_edits: existingEdits,
    });
    const client = makeMockDynamoClient(existing);

    const result = await recordUserEdit(
      client,
      'test-tenant',
      'payer-001',
      'CO-50',
      'New original letter for the appeal process.',
      'New edited letter with different language for the appeal.'
    );

    expect(result.sample_edits).toHaveLength(5);
    // The newest edit should be the last one
    expect(result.sample_edits[4].original_snippet).toContain('New original letter');
  });

  it('should store the record in DynamoDB via PutCommand', async () => {
    const client = makeMockDynamoClient(null);

    await recordUserEdit(
      client,
      'test-tenant',
      'payer-001',
      'CO-50',
      'Original letter for the appeal of claim 12345.',
      'Edited letter with preferred phrasing for claim 12345.'
    );

    // Should have called send twice: once for Get, once for Put
    expect(client.send).toHaveBeenCalledTimes(2);
    const putCall = client.send.mock.calls[1][0];
    expect(putCall.input.TableName).toBe('DenialAppeals');
    expect(putCall.input.Item.PK).toBe('TENANT#test-tenant');
    expect(putCall.input.Item.SK).toBe('PREF#payer-001#CO-50');
  });

  it('should truncate letter snippets in sample edits to 500 chars', async () => {
    const client = makeMockDynamoClient(null);
    const longLetter = 'A'.repeat(1000);

    const result = await recordUserEdit(
      client,
      'test-tenant',
      'payer-001',
      'CO-50',
      longLetter,
      longLetter
    );

    expect(result.sample_edits[0].original_snippet.length).toBe(500);
    expect(result.sample_edits[0].edited_snippet.length).toBe(500);
  });

  it('should merge new preferred phrases with existing ones', async () => {
    const existing = makePreferenceRecord({
      preferred_phrases: ['Existing phrase one for the appeal'],
    });
    const client = makeMockDynamoClient(existing);

    const result = await recordUserEdit(
      client,
      'test-tenant',
      'payer-001',
      'CO-50',
      'We are writing to appeal the denial.',
      'We are writing to appeal the denial. The clinical evidence clearly supports medical necessity.'
    );

    // Should contain the existing phrase plus any new ones
    expect(result.preferred_phrases).toContain('Existing phrase one for the appeal');
  });

  it('should set last_edited_at to current ISO timestamp', async () => {
    const client = makeMockDynamoClient(null);

    const result = await recordUserEdit(
      client,
      'test-tenant',
      'payer-001',
      'CO-50',
      'Original letter for the appeal of this claim.',
      'Edited letter with different language for this claim.'
    );

    // Should be a valid ISO 8601 timestamp
    expect(result.last_edited_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

// ─── Tests: applyPreferences ────────────────────────────────────────────────

describe('applyPreferences', () => {
  it('should return original prompt when preferences is null', () => {
    const systemPrompt = 'You are a healthcare specialist.';

    const result = applyPreferences(systemPrompt, null);

    expect(result).toBe(systemPrompt);
  });

  it('should augment prompt with preferred phrases', () => {
    const systemPrompt = 'You are a healthcare specialist.';
    const preferences = makePreferenceRecord({
      preferred_phrases: ['Medical necessity is clearly documented'],
      edit_count: 5,
    });

    const result = applyPreferences(systemPrompt, preferences);

    expect(result).toContain('You are a healthcare specialist.');
    expect(result).toContain('Medical necessity is clearly documented');
    expect(result).toContain('USER PREFERENCES');
    expect(result).toContain('5 previous edits');
  });

  it('should include structural preferences', () => {
    const systemPrompt = 'You are a healthcare specialist.';
    const preferences = makePreferenceRecord({
      preferred_structure: ['added: RE: Appeal for Claim'],
    });

    const result = applyPreferences(systemPrompt, preferences);

    expect(result).toContain('Structural preferences');
    expect(result).toContain('added: RE: Appeal for Claim');
  });

  it('should include sample edit examples', () => {
    const systemPrompt = 'You are a healthcare specialist.';
    const preferences = makePreferenceRecord({
      sample_edits: [
        {
          original_snippet: 'We are writing to appeal.',
          edited_snippet: 'We respectfully request reconsideration.',
        },
      ],
    });

    const result = applyPreferences(systemPrompt, preferences);

    expect(result).toContain('Recent edit examples');
    expect(result).toContain('We are writing to appeal.');
    expect(result).toContain('We respectfully request reconsideration.');
  });

  it('should limit preferred phrases to 10 in the prompt', () => {
    const systemPrompt = 'You are a healthcare specialist.';
    const phrases = Array.from({ length: 15 }, (_, i) => `Preferred phrase number ${i + 1} for testing`);
    const preferences = makePreferenceRecord({ preferred_phrases: phrases });

    const result = applyPreferences(systemPrompt, preferences);

    // Count occurrences of "Preferred phrase" in the output
    const matches = result.match(/Preferred phrase number/g);
    expect(matches?.length).toBeLessThanOrEqual(10);
  });

  it('should limit sample edits to 3 in the prompt', () => {
    const systemPrompt = 'You are a healthcare specialist.';
    const edits: SampleEdit[] = Array.from({ length: 5 }, (_, i) => ({
      original_snippet: `Original snippet ${i}`,
      edited_snippet: `Edited snippet ${i}`,
    }));
    const preferences = makePreferenceRecord({ sample_edits: edits });

    const result = applyPreferences(systemPrompt, preferences);

    // Should only show last 3 edits
    const editMatches = result.match(/Edit \d+:/g);
    expect(editMatches?.length).toBeLessThanOrEqual(3);
  });

  it('should include instruction to maintain clinical accuracy', () => {
    const systemPrompt = 'You are a healthcare specialist.';
    const preferences = makePreferenceRecord();

    const result = applyPreferences(systemPrompt, preferences);

    expect(result).toContain('clinical accuracy');
  });

  it('should handle preferences with empty arrays', () => {
    const systemPrompt = 'You are a healthcare specialist.';
    const preferences = makePreferenceRecord({
      preferred_phrases: [],
      preferred_structure: [],
      sample_edits: [],
    });

    const result = applyPreferences(systemPrompt, preferences);

    // Should return original prompt since there's nothing to add
    expect(result).toBe(systemPrompt);
  });
});
