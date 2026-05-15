/**
 * User Edit Preference Tracking Module
 *
 * Tracks user edits to generated appeal letters and stores preference patterns
 * keyed by (payer_id, denial_reason_code) in DynamoDB. When generating future
 * letters for the same combination, stored preferences are applied to the
 * system prompt to produce letters that align with user preferences.
 *
 * DynamoDB key pattern:
 * - PK: TENANT#<tenant_id>
 * - SK: PREF#<payer_id>#<denial_reason_code>
 *
 * Requirements: 5.7
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { TABLE_DENIAL_APPEALS, buildTenantPK } from '@shared/dynamodb';

// ─── Types ──────────────────────────────────────────────────────────────────

/** A single edit example showing what the user changed */
export interface SampleEdit {
  original_snippet: string;
  edited_snippet: string;
}

/** Stored preference record for a (payer, denial_reason) combination */
export interface UserPreferenceRecord {
  PK: string;
  SK: string;
  payer_id: string;
  denial_reason_code: string;
  preferred_phrases: string[];
  preferred_structure: string[];
  edit_count: number;
  last_edited_at: string;
  sample_edits: SampleEdit[];
}

/** Extracted patterns from comparing original and edited letters */
export interface EditPatterns {
  added_phrases: string[];
  removed_phrases: string[];
  structure_changes: string[];
}

// ─── Constants ──────────────────────────────────────────────────────────────

const PREF_SK_PREFIX = 'PREF#';
const MAX_SAMPLE_EDITS = 5;
const MIN_PHRASE_LENGTH = 10;
const MAX_PHRASE_LENGTH = 200;

// ─── Key Builders ───────────────────────────────────────────────────────────

/**
 * Builds the sort key for a preference record.
 * Format: PREF#<payer_id>#<denial_reason_code>
 */
export function buildPreferenceSK(payerId: string, denialReasonCode: string): string {
  return `${PREF_SK_PREFIX}${payerId}#${denialReasonCode}`;
}

// ─── Edit Pattern Extraction ────────────────────────────────────────────────

/**
 * Splits a letter into meaningful sentences/phrases for comparison.
 * Filters out very short fragments and normalizes whitespace.
 */
function splitIntoSentences(text: string): string[] {
  return text
    .split(/[.!?]\s+|\n+/)
    .map(s => s.trim())
    .filter(s => s.length >= MIN_PHRASE_LENGTH);
}

/**
 * Extracts sections from a letter based on common structural markers.
 * Returns section headings/labels found in the text.
 */
function extractSections(text: string): string[] {
  const sectionPatterns = [
    /^(RE:|Re:|Subject:|SUBJECT:)\s*.+/gm,
    /^(Dear|To Whom|Attention:)\s*.+/gm,
    /^(Sincerely|Respectfully|Thank you)\s*.*/gm,
    /^#{1,3}\s+.+/gm,
    /^[A-Z][A-Z\s]{3,}:?\s*$/gm,
  ];

  const sections: string[] = [];
  for (const pattern of sectionPatterns) {
    const matches = text.match(pattern);
    if (matches) {
      sections.push(...matches.map(m => m.trim()));
    }
  }
  return sections;
}

/**
 * Identifies what the user changed between the original and edited letter.
 * Extracts added phrases, removed phrases, and structural changes.
 *
 * @param originalLetter - The system-generated letter
 * @param editedLetter - The user-edited version
 * @returns EditPatterns describing the differences
 */
export function extractEditPatterns(originalLetter: string, editedLetter: string): EditPatterns {
  const originalSentences = splitIntoSentences(originalLetter);
  const editedSentences = splitIntoSentences(editedLetter);

  const originalSet = new Set(originalSentences);
  const editedSet = new Set(editedSentences);

  // Phrases added by the user (in edited but not in original)
  const added_phrases = editedSentences
    .filter(s => !originalSet.has(s))
    .filter(s => s.length <= MAX_PHRASE_LENGTH);

  // Phrases removed by the user (in original but not in edited)
  const removed_phrases = originalSentences
    .filter(s => !editedSet.has(s))
    .filter(s => s.length <= MAX_PHRASE_LENGTH);

  // Detect structural changes by comparing section ordering
  const originalSections = extractSections(originalLetter);
  const editedSections = extractSections(editedLetter);

  const structure_changes: string[] = [];

  // Sections added by user
  for (const section of editedSections) {
    if (!originalSections.includes(section)) {
      structure_changes.push(`added: ${section}`);
    }
  }

  // Sections removed by user
  for (const section of originalSections) {
    if (!editedSections.includes(section)) {
      structure_changes.push(`removed: ${section}`);
    }
  }

  return { added_phrases, removed_phrases, structure_changes };
}

// ─── DynamoDB Operations ────────────────────────────────────────────────────

/**
 * Retrieves stored preferences for a (payer, denial_reason) combination.
 *
 * @param dynamoClient - DynamoDB Document Client
 * @param tenantId - The tenant identifier
 * @param payerId - The payer identifier
 * @param denialReasonCode - The denial reason code (e.g., CARC code)
 * @param tableName - Optional table name override (defaults to DenialAppeals)
 * @returns The preference record if found, or null
 */
export async function getPreferences(
  dynamoClient: DynamoDBDocumentClient,
  tenantId: string,
  payerId: string,
  denialReasonCode: string,
  tableName: string = TABLE_DENIAL_APPEALS
): Promise<UserPreferenceRecord | null> {
  const pk = buildTenantPK(tenantId);
  const sk = buildPreferenceSK(payerId, denialReasonCode);

  const command = new GetCommand({
    TableName: tableName,
    Key: { PK: pk, SK: sk },
  });

  const response = await dynamoClient.send(command);

  if (!response.Item) {
    return null;
  }

  return response.Item as UserPreferenceRecord;
}

/**
 * Records a user edit by extracting patterns and storing/updating preferences
 * in DynamoDB. Maintains the last 5 sample edits and accumulates preferred phrases.
 *
 * @param dynamoClient - DynamoDB Document Client
 * @param tenantId - The tenant identifier
 * @param payerId - The payer identifier
 * @param denialReasonCode - The denial reason code
 * @param originalLetter - The system-generated letter
 * @param editedLetter - The user-edited version
 * @param tableName - Optional table name override (defaults to DenialAppeals)
 * @returns The updated preference record
 */
export async function recordUserEdit(
  dynamoClient: DynamoDBDocumentClient,
  tenantId: string,
  payerId: string,
  denialReasonCode: string,
  originalLetter: string,
  editedLetter: string,
  tableName: string = TABLE_DENIAL_APPEALS
): Promise<UserPreferenceRecord> {
  // Extract patterns from this edit
  const patterns = extractEditPatterns(originalLetter, editedLetter);

  // Get existing preferences (if any)
  const existing = await getPreferences(dynamoClient, tenantId, payerId, denialReasonCode, tableName);

  const pk = buildTenantPK(tenantId);
  const sk = buildPreferenceSK(payerId, denialReasonCode);
  const now = new Date().toISOString();

  // Build the new sample edit (truncate snippets for storage)
  const newSampleEdit: SampleEdit = {
    original_snippet: originalLetter.substring(0, 500),
    edited_snippet: editedLetter.substring(0, 500),
  };

  let updatedRecord: UserPreferenceRecord;

  if (existing) {
    // Merge new patterns with existing preferences
    const mergedPhrases = mergePreferredPhrases(
      existing.preferred_phrases,
      patterns.added_phrases
    );

    const mergedStructure = mergeStructurePreferences(
      existing.preferred_structure,
      patterns.structure_changes
    );

    // Keep only the last MAX_SAMPLE_EDITS edits
    const updatedSampleEdits = [...existing.sample_edits, newSampleEdit].slice(-MAX_SAMPLE_EDITS);

    updatedRecord = {
      PK: pk,
      SK: sk,
      payer_id: payerId,
      denial_reason_code: denialReasonCode,
      preferred_phrases: mergedPhrases,
      preferred_structure: mergedStructure,
      edit_count: existing.edit_count + 1,
      last_edited_at: now,
      sample_edits: updatedSampleEdits,
    };
  } else {
    // Create new preference record
    updatedRecord = {
      PK: pk,
      SK: sk,
      payer_id: payerId,
      denial_reason_code: denialReasonCode,
      preferred_phrases: patterns.added_phrases.slice(0, 10),
      preferred_structure: patterns.structure_changes.slice(0, 10),
      edit_count: 1,
      last_edited_at: now,
      sample_edits: [newSampleEdit],
    };
  }

  // Store in DynamoDB
  const putCommand = new PutCommand({
    TableName: tableName,
    Item: updatedRecord,
  });

  await dynamoClient.send(putCommand);

  return updatedRecord;
}

// ─── Preference Merging ─────────────────────────────────────────────────────

/**
 * Merges new phrases into existing preferred phrases, deduplicating and
 * keeping the most recent/relevant ones (max 20 phrases).
 */
function mergePreferredPhrases(existing: string[], newPhrases: string[]): string[] {
  const combined = new Set([...existing, ...newPhrases]);
  return [...combined].slice(0, 20);
}

/**
 * Merges new structure preferences with existing ones, deduplicating.
 */
function mergeStructurePreferences(existing: string[], newChanges: string[]): string[] {
  const combined = new Set([...existing, ...newChanges]);
  return [...combined].slice(0, 10);
}

// ─── Prompt Augmentation ────────────────────────────────────────────────────

/**
 * Augments the system prompt with user preferences for future letter generation.
 * Adds preferred phrases and structural preferences as additional instructions.
 *
 * @param systemPrompt - The base system prompt for letter generation
 * @param preferences - The stored user preferences (or null if none exist)
 * @returns The augmented system prompt incorporating user preferences
 */
export function applyPreferences(
  systemPrompt: string,
  preferences: UserPreferenceRecord | null
): string {
  if (!preferences) {
    return systemPrompt;
  }

  const preferenceInstructions: string[] = [];

  // Add preferred phrases guidance
  if (preferences.preferred_phrases.length > 0) {
    preferenceInstructions.push(
      `\n\nUSER PREFERENCES (based on ${preferences.edit_count} previous edits for this payer/denial reason combination):`
    );
    preferenceInstructions.push(
      '\nPreferred phrases and language the user has consistently used:'
    );
    for (const phrase of preferences.preferred_phrases.slice(0, 10)) {
      preferenceInstructions.push(`- "${phrase}"`);
    }
  }

  // Add structural preferences
  if (preferences.preferred_structure.length > 0) {
    preferenceInstructions.push('\nStructural preferences:');
    for (const structure of preferences.preferred_structure.slice(0, 5)) {
      preferenceInstructions.push(`- ${structure}`);
    }
  }

  // Add sample edit context for the model to learn from
  if (preferences.sample_edits.length > 0) {
    preferenceInstructions.push(
      '\nRecent edit examples showing how the user prefers letters to be written:'
    );
    const recentEdits = preferences.sample_edits.slice(-3);
    for (let i = 0; i < recentEdits.length; i++) {
      preferenceInstructions.push(
        `\nEdit ${i + 1}:`
      );
      preferenceInstructions.push(
        `  Original: "${recentEdits[i].original_snippet.substring(0, 200)}..."`
      );
      preferenceInstructions.push(
        `  User's version: "${recentEdits[i].edited_snippet.substring(0, 200)}..."`
      );
    }
  }

  if (preferenceInstructions.length > 0) {
    preferenceInstructions.push(
      '\nIncorporate these preferences into the generated letter while maintaining clinical accuracy and factual grounding.'
    );
  }

  return systemPrompt + preferenceInstructions.join('\n');
}
