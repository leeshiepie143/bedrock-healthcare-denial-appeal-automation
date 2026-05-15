/**
 * Structured EDI Classification Lambda
 *
 * Handles classification of denial records produced from structured EDI inputs
 * (EDI 835/277). Since CARC codes are explicitly present in the parsed data,
 * confidence is always 1.0.
 *
 * Key behaviors:
 * - Parses CARC codes from raw_denial_reason_text (format: "GROUP-CODE: $AMOUNT; ...")
 * - Looks up each CARC code in DynamoDB mapping table for evidence category associations
 * - Ranks denial reasons by dollar contribution (descending) when amounts are available
 * - Falls back to document order ranking when amounts are not itemized
 */

import type { DenialRecord, ClassifiedDenial, CarcCode, RarcCode } from '@shared/models';
import { buildTenantPK, buildClassificationSK, TABLE_DENIAL_APPEALS } from '@shared/dynamodb';

// ─── Constants ──────────────────────────────────────────────────────────────

/** DynamoDB partition key for the CARC mapping table */
export const CARC_MAP_PK = 'CARC_MAP';

/** DynamoDB sort key prefix for CARC code entries */
export const CARC_CODE_SK_PREFIX = 'CODE#';

/** Confidence score for structured EDI classification (always 1.0) */
export const STRUCTURED_EDI_CONFIDENCE = 1.0;

// ─── Types ──────────────────────────────────────────────────────────────────

/** Parsed CARC entry from raw_denial_reason_text */
export interface ParsedCarcEntry {
  group_code: string;
  reason_code: string;
  dollar_amount: number | null;
  original_position: number;
}

/** CARC mapping record from DynamoDB */
export interface CarcMappingRecord {
  code: string;
  description: string;
  required_evidence_categories: string[];
  group_code_description: string;
}

/** Result of the structured classification */
export interface StructuredClassificationResult {
  classifiedDenial: ClassifiedDenial;
  unmappedCodes: string[];
}

/** DynamoDB client interface for dependency injection */
export interface DynamoDBClient {
  send: (command: unknown) => Promise<unknown>;
}

// ─── Parsing Logic ──────────────────────────────────────────────────────────

/**
 * Parses CARC codes from the raw_denial_reason_text field.
 *
 * Expected formats:
 * - With amounts: "CO-45: $100.00; CO-253: $50.00"
 * - Without amounts: "CO-45; CO-253" or "CO-45: ; CO-253: "
 *
 * @param rawText - The raw_denial_reason_text from the DenialRecord
 * @returns Array of parsed CARC entries with position and optional dollar amounts
 */
export function parseCarcCodesFromText(rawText: string): ParsedCarcEntry[] {
  if (!rawText || rawText.trim().length === 0) {
    return [];
  }

  const entries: ParsedCarcEntry[] = [];
  const segments = rawText.split(';').map((s) => s.trim()).filter((s) => s.length > 0);

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const parsed = parseSingleCarcSegment(segment, i);
    if (parsed) {
      entries.push(parsed);
    }
  }

  return entries;
}

/**
 * Parses a single CARC segment like "CO-45: $100.00" or "CO-45".
 *
 * @param segment - A single segment from the semicolon-delimited text
 * @param position - The original position (0-indexed) in the text
 * @returns Parsed entry or null if unparseable
 */
export function parseSingleCarcSegment(segment: string, position: number): ParsedCarcEntry | null {
  // Pattern: GROUP-CODE: $AMOUNT or GROUP-CODE
  // Group codes: CO, PR, OA, PI, CR
  // Reason codes: numeric (1-999)
  const pattern = /^([A-Z]{2})-(\d+)(?:\s*:\s*\$?([\d,]+\.?\d*))?$/;
  const match = segment.match(pattern);

  if (!match) {
    return null;
  }

  const group_code = match[1];
  const reason_code = match[2];
  let dollar_amount: number | null = null;

  if (match[3] && match[3].trim().length > 0) {
    const amountStr = match[3].replace(/,/g, '');
    const parsed = parseFloat(amountStr);
    if (!isNaN(parsed) && isFinite(parsed)) {
      dollar_amount = Math.round(parsed * 100) / 100;
    }
  }

  return {
    group_code,
    reason_code,
    dollar_amount,
    original_position: position,
  };
}

// ─── Ranking Logic ──────────────────────────────────────────────────────────

/**
 * Determines whether dollar-based ranking is available.
 * Dollar ranking is available only when ALL entries have non-null dollar amounts.
 *
 * @param entries - Parsed CARC entries
 * @returns true if all entries have dollar amounts
 */
export function isDollarRankingAvailable(entries: ParsedCarcEntry[]): boolean {
  if (entries.length === 0) {
    return false;
  }
  return entries.every((entry) => entry.dollar_amount !== null && entry.dollar_amount > 0);
}

/**
 * Ranks parsed CARC entries.
 * - If dollar amounts are available: rank by dollar contribution descending
 * - If dollar amounts are not itemized: rank by document order (original position)
 *
 * @param entries - Parsed CARC entries
 * @param dollarRankingAvailable - Whether dollar-based ranking should be used
 * @returns Entries sorted in rank order (index 0 = rank 1)
 */
export function rankCarcEntries(
  entries: ParsedCarcEntry[],
  dollarRankingAvailable: boolean
): ParsedCarcEntry[] {
  if (entries.length === 0) {
    return [];
  }

  const sorted = [...entries];

  if (dollarRankingAvailable) {
    // Sort by dollar amount descending
    sorted.sort((a, b) => (b.dollar_amount ?? 0) - (a.dollar_amount ?? 0));
  } else {
    // Sort by original document order (ascending position)
    sorted.sort((a, b) => a.original_position - b.original_position);
  }

  return sorted;
}

// ─── DynamoDB Mapping Lookup ────────────────────────────────────────────────

/**
 * Builds the DynamoDB key for a CARC mapping lookup.
 *
 * @param code - The CARC reason code (e.g., "45")
 * @returns The PK and SK for the mapping table query
 */
export function buildCarcMappingKey(code: string): { PK: string; SK: string } {
  return {
    PK: CARC_MAP_PK,
    SK: `${CARC_CODE_SK_PREFIX}${code}`,
  };
}

/**
 * Looks up CARC code mappings from DynamoDB.
 * Performs a BatchGetItem for all codes to minimize round trips.
 *
 * @param dynamoClient - DynamoDB Document Client
 * @param codes - Array of CARC reason codes to look up
 * @param tableName - DynamoDB table name
 * @returns Map of code -> CarcMappingRecord (only found codes)
 */
export async function lookupCarcMappings(
  dynamoClient: DynamoDBClient,
  codes: string[],
  tableName: string = TABLE_DENIAL_APPEALS
): Promise<Map<string, CarcMappingRecord>> {
  const mappings = new Map<string, CarcMappingRecord>();

  if (codes.length === 0) {
    return mappings;
  }

  // Deduplicate codes
  const uniqueCodes = [...new Set(codes)];

  try {
    const { BatchGetCommand } = await import('@aws-sdk/lib-dynamodb');

    // DynamoDB BatchGetItem supports max 100 keys per request
    const batchSize = 100;
    for (let i = 0; i < uniqueCodes.length; i += batchSize) {
      const batch = uniqueCodes.slice(i, i + batchSize);
      const keys = batch.map((code) => buildCarcMappingKey(code));

      const command = new BatchGetCommand({
        RequestItems: {
          [tableName]: {
            Keys: keys,
          },
        },
      });

      const response = (await dynamoClient.send(command)) as {
        Responses?: Record<string, CarcMappingRecord[]>;
        UnprocessedKeys?: Record<string, unknown>;
      };

      if (response.Responses && response.Responses[tableName]) {
        for (const item of response.Responses[tableName]) {
          mappings.set(item.code, item);
        }
      }
    }
  } catch (error) {
    console.error('Failed to lookup CARC mappings from DynamoDB:', error);
    // Return whatever we have so far — partial results are better than none
  }

  return mappings;
}

// ─── Classification Logic ───────────────────────────────────────────────────

/**
 * Builds CarcCode objects from parsed entries and mapping data.
 *
 * @param rankedEntries - CARC entries in rank order
 * @param mappings - CARC mapping records from DynamoDB
 * @param dollarRankingAvailable - Whether dollar ranking was used
 * @returns Array of CarcCode objects with rank assignments
 */
export function buildCarcCodes(
  rankedEntries: ParsedCarcEntry[],
  mappings: Map<string, CarcMappingRecord>,
  dollarRankingAvailable: boolean
): { carcCodes: CarcCode[]; unmappedCodes: string[] } {
  const carcCodes: CarcCode[] = [];
  const unmappedCodes: string[] = [];

  for (let i = 0; i < rankedEntries.length; i++) {
    const entry = rankedEntries[i];
    const mapping = mappings.get(entry.reason_code);

    if (mapping) {
      carcCodes.push({
        code: entry.reason_code,
        description: mapping.description,
        confidence: STRUCTURED_EDI_CONFIDENCE,
        dollar_amount: dollarRankingAvailable ? entry.dollar_amount : null,
        rank: i + 1,
        required_evidence_categories: mapping.required_evidence_categories,
      });
    } else {
      // Code not found in mapping table — still include with minimal info
      unmappedCodes.push(entry.reason_code);
      carcCodes.push({
        code: entry.reason_code,
        description: `${entry.group_code} adjustment - code ${entry.reason_code} (unmapped)`,
        confidence: STRUCTURED_EDI_CONFIDENCE,
        dollar_amount: dollarRankingAvailable ? entry.dollar_amount : null,
        rank: i + 1,
        required_evidence_categories: [],
      });
    }
  }

  return { carcCodes, unmappedCodes };
}

// ─── Main Classification Function ───────────────────────────────────────────

/**
 * Classifies a structured EDI denial record.
 *
 * This is the main entry point for the structured classifier. It:
 * 1. Parses CARC codes from raw_denial_reason_text
 * 2. Looks up each code in the DynamoDB mapping table
 * 3. Ranks codes by dollar contribution (or document order if unavailable)
 * 4. Returns a ClassifiedDenial object
 *
 * @param denialRecord - The DenialRecord from ingestion
 * @param dynamoClient - DynamoDB Document Client for mapping lookups
 * @param tableName - DynamoDB table name (defaults to DenialAppeals)
 * @returns StructuredClassificationResult with the classified denial and any unmapped codes
 */
export async function classifyStructuredEDI(
  denialRecord: DenialRecord,
  dynamoClient: DynamoDBClient,
  tableName: string = TABLE_DENIAL_APPEALS
): Promise<StructuredClassificationResult> {
  // Step 1: Parse CARC codes from raw text
  const parsedEntries = parseCarcCodesFromText(denialRecord.raw_denial_reason_text);

  // Step 2: Determine ranking strategy
  const dollarRankingAvailable = isDollarRankingAvailable(parsedEntries);

  // Step 3: Rank entries
  const rankedEntries = rankCarcEntries(parsedEntries, dollarRankingAvailable);

  // Step 4: Look up mappings from DynamoDB
  const codes = rankedEntries.map((entry) => entry.reason_code);
  const mappings = await lookupCarcMappings(dynamoClient, codes, tableName);

  // Step 5: Build CarcCode objects
  const { carcCodes, unmappedCodes } = buildCarcCodes(rankedEntries, mappings, dollarRankingAvailable);

  // Step 6: Build ClassifiedDenial
  const classifiedDenial: ClassifiedDenial = {
    PK: buildTenantPK(denialRecord.tenant_id),
    SK: buildClassificationSK(denialRecord.claim_id),
    claim_id: denialRecord.claim_id,
    carc_codes: carcCodes,
    rarc_codes: [], // RARC codes are not present in structured EDI 835 CAS segments
    classification_method: 'structured_edi',
    dollar_ranking_available: dollarRankingAvailable,
    review_status: 'auto_classified',
    classified_at: new Date().toISOString(),
  };

  return {
    classifiedDenial,
    unmappedCodes,
  };
}
