/**
 * Appeal Letter Parser Module
 *
 * Parses appeal letters (both system-generated and external) back into
 * structured Appeal_Data objects. Supports two parsing modes:
 *
 * 1. System-generated letters: Deterministic regex-based extraction of the
 *    ---METADATA--- / ---END_METADATA--- section (same format as letter-generator produces).
 *
 * 2. External letters: Bedrock-based extraction with per-field success/failure
 *    indication, applying Bedrock Guardrails for content filtering.
 *
 * Each field is independently extracted and marked with an ExtractedField<T>
 * indicating success (value + extracted: true) or failure (reason + extracted: false).
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  type InvokeModelCommandInput,
} from '@aws-sdk/client-bedrock-runtime';
import type {
  AppealData,
  ExtractedField,
  CitedEvidenceReference,
  RegulatoryCitation,
  RegulatoryCitationType,
  ParseStatus,
} from '@shared/models';

// ─── Constants ──────────────────────────────────────────────────────────────

const METADATA_START_MARKER = '---METADATA---';
const METADATA_END_MARKER = '---END_METADATA---';

const VALID_REGULATORY_TYPES: RegulatoryCitationType[] = ['lcd', 'ncd', 'state_mandate', 'erisa'];

// ─── Environment Variables ──────────────────────────────────────────────────

function getModelId(): string {
  return process.env.BEDROCK_MODEL_ID || 'anthropic.claude-3-sonnet-20240229-v1:0';
}

function getGuardrailId(): string {
  return process.env.GUARDRAIL_ID || '';
}

function getGuardrailVersion(): string {
  return process.env.GUARDRAIL_VERSION || 'DRAFT';
}

// ─── AWS SDK Client ─────────────────────────────────────────────────────────

let bedrockClient: BedrockRuntimeClient | null = null;

function getBedrockClient(): BedrockRuntimeClient {
  if (!bedrockClient) {
    bedrockClient = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1' });
  }
  return bedrockClient;
}

/** Allows injecting a mock Bedrock client for testing. */
export function setBedrockClient(client: BedrockRuntimeClient): void {
  bedrockClient = client;
}

/** Resets the Bedrock client (useful for testing cleanup). */
export function resetBedrockClient(): void {
  bedrockClient = null;
}

// ─── Helper Functions ───────────────────────────────────────────────────────

/**
 * Creates a successful ExtractedField.
 */
function extractedSuccess<T>(value: T): ExtractedField<T> {
  return { value, extracted: true, reason: null };
}

/**
 * Creates a failed ExtractedField with a reason.
 */
function extractedFailure<T>(reason: string): ExtractedField<T> {
  return { value: null, extracted: false, reason };
}

/**
 * Determines the parse status based on extraction results.
 */
function determineParseStatus(fields: ExtractedField<unknown>[]): ParseStatus {
  const allExtracted = fields.every((f) => f.extracted);
  const noneExtracted = fields.every((f) => !f.extracted);

  if (allExtracted) return 'success';
  if (noneExtracted) return 'failure';
  return 'partial';
}

// ─── System-Generated Letter Parsing ────────────────────────────────────────

/**
 * Checks whether the input contains system-generated metadata markers.
 */
export function isSystemGeneratedLetter(input: string): boolean {
  return input.includes(METADATA_START_MARKER) && input.includes(METADATA_END_MARKER);
}

/**
 * Extracts the JSON metadata section from a system-generated letter.
 * Returns null if the metadata section cannot be found or parsed.
 */
export function extractMetadataSection(input: string): string | null {
  const startIdx = input.indexOf(METADATA_START_MARKER);
  const endIdx = input.indexOf(METADATA_END_MARKER);

  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return null;
  }

  const metadataStr = input.substring(
    startIdx + METADATA_START_MARKER.length,
    endIdx
  ).trim();

  return metadataStr || null;
}

/**
 * Validates a CitedEvidenceReference object.
 */
function isValidCitedEvidenceReference(ref: unknown): ref is CitedEvidenceReference {
  if (!ref || typeof ref !== 'object') return false;
  const r = ref as Record<string, unknown>;
  return (
    typeof r.fhir_resource_id === 'string' &&
    typeof r.date === 'string' &&
    typeof r.provider === 'string'
  );
}

/**
 * Validates a RegulatoryCitation object.
 */
function isValidRegulatoryCitation(cit: unknown): cit is RegulatoryCitation {
  if (!cit || typeof cit !== 'object') return false;
  const c = cit as Record<string, unknown>;
  return (
    typeof c.type === 'string' &&
    VALID_REGULATORY_TYPES.includes(c.type as RegulatoryCitationType) &&
    typeof c.reference_id === 'string' &&
    typeof c.section === 'string' &&
    typeof c.description === 'string'
  );
}

/**
 * Parses a system-generated letter using deterministic regex-based metadata extraction.
 * Each field is independently extracted from the JSON metadata section.
 */
export function parseSystemGeneratedLetter(input: string): AppealData {
  const metadataStr = extractMetadataSection(input);

  if (!metadataStr) {
    return buildFailureResult();
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(metadataStr);
  } catch {
    return buildFailureResult();
  }

  if (!parsed || typeof parsed !== 'object') {
    return buildFailureResult();
  }

  // Extract each field independently
  const patientId = extractPatientIdFromMetadata(parsed);
  const claimId = extractClaimIdFromMetadata(parsed);
  const denialReasons = extractDenialReasonsFromMetadata(parsed);
  const citedEvidenceReferences = extractCitedEvidenceFromMetadata(parsed);
  const regulatoryCitations = extractRegulatoryCitationsFromMetadata(parsed);
  const appealArguments = extractAppealArgumentsFromMetadata(parsed);

  const allFields: ExtractedField<unknown>[] = [
    patientId,
    claimId,
    denialReasons,
    citedEvidenceReferences,
    regulatoryCitations,
    appealArguments,
  ];

  const parseStatus = determineParseStatus(allFields);

  return {
    patient_id: patientId,
    claim_id: claimId,
    denial_reasons: denialReasons,
    cited_evidence_references: citedEvidenceReferences,
    regulatory_citations: regulatoryCitations,
    appeal_arguments: appealArguments,
    parse_status: parseStatus,
    original_input_preserved: false,
  };
}

function extractPatientIdFromMetadata(parsed: Record<string, unknown>): ExtractedField<string> {
  if (typeof parsed.patient_id === 'string' && parsed.patient_id.length > 0) {
    return extractedSuccess(parsed.patient_id);
  }
  return extractedFailure('patient_id field missing or not a valid string in metadata');
}

function extractClaimIdFromMetadata(parsed: Record<string, unknown>): ExtractedField<string> {
  if (typeof parsed.claim_id === 'string' && parsed.claim_id.length > 0) {
    return extractedSuccess(parsed.claim_id);
  }
  return extractedFailure('claim_id field missing or not a valid string in metadata');
}

function extractDenialReasonsFromMetadata(parsed: Record<string, unknown>): ExtractedField<string[]> {
  if (Array.isArray(parsed.denial_reasons)) {
    const reasons = parsed.denial_reasons.filter(
      (r): r is string => typeof r === 'string' && r.length > 0
    );
    if (reasons.length > 0) {
      return extractedSuccess(reasons);
    }
  }
  return extractedFailure('denial_reasons field missing or empty array in metadata');
}

function extractCitedEvidenceFromMetadata(
  parsed: Record<string, unknown>
): ExtractedField<CitedEvidenceReference[]> {
  if (Array.isArray(parsed.cited_evidence_references)) {
    const refs = parsed.cited_evidence_references.filter(isValidCitedEvidenceReference);
    // Allow empty arrays as valid (letter may have no evidence citations)
    return extractedSuccess(refs);
  }
  return extractedFailure('cited_evidence_references field missing or not an array in metadata');
}

function extractRegulatoryCitationsFromMetadata(
  parsed: Record<string, unknown>
): ExtractedField<RegulatoryCitation[]> {
  if (Array.isArray(parsed.regulatory_citations)) {
    const citations = parsed.regulatory_citations.filter(isValidRegulatoryCitation);
    // Allow empty arrays as valid (letter may have no regulatory citations)
    return extractedSuccess(citations);
  }
  return extractedFailure('regulatory_citations field missing or not an array in metadata');
}

function extractAppealArgumentsFromMetadata(parsed: Record<string, unknown>): ExtractedField<string[]> {
  if (Array.isArray(parsed.appeal_arguments)) {
    const args = parsed.appeal_arguments.filter(
      (a): a is string => typeof a === 'string' && a.length > 0
    );
    if (args.length > 0) {
      return extractedSuccess(args);
    }
  }
  return extractedFailure('appeal_arguments field missing or empty array in metadata');
}

// ─── External Letter Parsing (Bedrock-based) ────────────────────────────────

/**
 * Builds the prompt for Bedrock to extract structured fields from an external letter.
 */
export function buildExtractionPrompt(letterText: string): string {
  return `You are a healthcare document parser. Extract structured data from the following appeal letter.

For each field, extract the value if present. If a field cannot be determined from the letter, indicate that it is not extractable.

Return your response as a JSON object with the following structure:
{
  "patient_id": { "value": "<extracted value or null>", "found": true/false, "reason": "<reason if not found>" },
  "claim_id": { "value": "<extracted value or null>", "found": true/false, "reason": "<reason if not found>" },
  "denial_reasons": { "value": ["<reason1>", ...] or null, "found": true/false, "reason": "<reason if not found>" },
  "cited_evidence_references": { "value": [{"fhir_resource_id": "...", "date": "...", "provider": "..."}] or null, "found": true/false, "reason": "<reason if not found>" },
  "regulatory_citations": { "value": [{"type": "lcd|ncd|state_mandate|erisa", "reference_id": "...", "section": "...", "description": "..."}] or null, "found": true/false, "reason": "<reason if not found>" },
  "appeal_arguments": { "value": ["<argument1>", ...] or null, "found": true/false, "reason": "<reason if not found>" }
}

IMPORTANT:
- Only extract information that is explicitly stated in the letter.
- Do NOT infer or fabricate any values.
- For cited_evidence_references, only include references that have explicit FHIR resource IDs, dates, and provider names.
- For regulatory_citations, only include citations with explicit type, reference ID, section, and description.
- If a field is partially present (e.g., some evidence references have all required fields and others don't), include only the complete ones.

---LETTER START---
${letterText}
---LETTER END---

Respond ONLY with the JSON object. No additional text.`;
}

/**
 * Invokes Bedrock to extract fields from an external letter.
 * Applies Bedrock Guardrails for content filtering.
 */
export async function invokeBedrockExtraction(
  letterText: string
): Promise<Record<string, unknown> | null> {
  const client = getBedrockClient();

  const prompt = buildExtractionPrompt(letterText);

  const requestBody = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 4096,
    temperature: 0.0,
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
  });

  const commandInput: InvokeModelCommandInput = {
    modelId: getModelId(),
    contentType: 'application/json',
    accept: 'application/json',
    body: requestBody,
  };

  // Apply guardrails if configured
  const guardrailId = getGuardrailId();
  if (guardrailId) {
    commandInput.guardrailIdentifier = guardrailId;
    commandInput.guardrailVersion = getGuardrailVersion();
  }

  const command = new InvokeModelCommand(commandInput);

  try {
    const response = await client.send(command);
    const responseBodyStr = new TextDecoder().decode(response.body);
    const responseJson = JSON.parse(responseBodyStr);

    // Check for guardrail intervention
    if (
      responseJson.stop_reason === 'guardrail_intervened' ||
      responseJson.amazon_bedrock_guardrailAction === 'INTERVENED'
    ) {
      console.warn(
        '[LETTER_PARSER] Bedrock Guardrail intervened during external letter parsing.',
        JSON.stringify({ guardrailId, guardrailVersion: getGuardrailVersion() })
      );
      return null;
    }

    // Extract text content from Claude response format
    const textContent = responseJson.content?.find(
      (block: { type: string }) => block.type === 'text'
    );
    const responseText = textContent?.text || '';

    if (!responseText) {
      return null;
    }

    // Parse the JSON response
    const extracted = JSON.parse(responseText);
    return extracted as Record<string, unknown>;
  } catch (error) {
    console.error('[LETTER_PARSER] Bedrock extraction failed:', error);
    return null;
  }
}

/**
 * Converts Bedrock extraction response into AppealData with per-field status.
 */
export function convertBedrockResponse(response: Record<string, unknown>): AppealData {
  const patientId = convertStringField(response.patient_id, 'patient_id');
  const claimId = convertStringField(response.claim_id, 'claim_id');
  const denialReasons = convertStringArrayField(response.denial_reasons, 'denial_reasons');
  const citedEvidenceReferences = convertCitedEvidenceField(response.cited_evidence_references);
  const regulatoryCitations = convertRegulatoryCitationsField(response.regulatory_citations);
  const appealArguments = convertStringArrayField(response.appeal_arguments, 'appeal_arguments');

  const allFields: ExtractedField<unknown>[] = [
    patientId,
    claimId,
    denialReasons,
    citedEvidenceReferences,
    regulatoryCitations,
    appealArguments,
  ];

  const parseStatus = determineParseStatus(allFields);

  return {
    patient_id: patientId,
    claim_id: claimId,
    denial_reasons: denialReasons,
    cited_evidence_references: citedEvidenceReferences,
    regulatory_citations: regulatoryCitations,
    appeal_arguments: appealArguments,
    parse_status: parseStatus,
    original_input_preserved: false,
  };
}

function convertStringField(
  field: unknown,
  fieldName: string
): ExtractedField<string> {
  if (!field || typeof field !== 'object') {
    return extractedFailure(`${fieldName} not present in extraction response`);
  }

  const f = field as Record<string, unknown>;

  if (f.found === true && typeof f.value === 'string' && f.value.length > 0) {
    return extractedSuccess(f.value);
  }

  const reason = typeof f.reason === 'string' ? f.reason : `${fieldName} could not be extracted`;
  return extractedFailure(reason);
}

function convertStringArrayField(
  field: unknown,
  fieldName: string
): ExtractedField<string[]> {
  if (!field || typeof field !== 'object') {
    return extractedFailure(`${fieldName} not present in extraction response`);
  }

  const f = field as Record<string, unknown>;

  if (f.found === true && Array.isArray(f.value)) {
    const values = f.value.filter((v): v is string => typeof v === 'string' && v.length > 0);
    if (values.length > 0) {
      return extractedSuccess(values);
    }
  }

  const reason = typeof f.reason === 'string' ? f.reason : `${fieldName} could not be extracted`;
  return extractedFailure(reason);
}

function convertCitedEvidenceField(
  field: unknown
): ExtractedField<CitedEvidenceReference[]> {
  if (!field || typeof field !== 'object') {
    return extractedFailure('cited_evidence_references not present in extraction response');
  }

  const f = field as Record<string, unknown>;

  if (f.found === true && Array.isArray(f.value)) {
    const refs = f.value.filter(isValidCitedEvidenceReference);
    return extractedSuccess(refs);
  }

  const reason = typeof f.reason === 'string'
    ? f.reason
    : 'cited_evidence_references could not be extracted';
  return extractedFailure(reason);
}

function convertRegulatoryCitationsField(
  field: unknown
): ExtractedField<RegulatoryCitation[]> {
  if (!field || typeof field !== 'object') {
    return extractedFailure('regulatory_citations not present in extraction response');
  }

  const f = field as Record<string, unknown>;

  if (f.found === true && Array.isArray(f.value)) {
    const citations = f.value.filter(isValidRegulatoryCitation);
    return extractedSuccess(citations);
  }

  const reason = typeof f.reason === 'string'
    ? f.reason
    : 'regulatory_citations could not be extracted';
  return extractedFailure(reason);
}

// ─── Failure Result Builder ─────────────────────────────────────────────────

/**
 * Builds a failure result for unparseable input.
 * Preserves the original input by setting original_input_preserved: true.
 */
export function buildFailureResult(): AppealData {
  return {
    patient_id: extractedFailure('Input is unparseable — no recognizable appeal letter structure'),
    claim_id: extractedFailure('Input is unparseable — no recognizable appeal letter structure'),
    denial_reasons: extractedFailure('Input is unparseable — no recognizable appeal letter structure'),
    cited_evidence_references: extractedFailure('Input is unparseable — no recognizable appeal letter structure'),
    regulatory_citations: extractedFailure('Input is unparseable — no recognizable appeal letter structure'),
    appeal_arguments: extractedFailure('Input is unparseable — no recognizable appeal letter structure'),
    parse_status: 'failure',
    original_input_preserved: true,
  };
}

// ─── Main Parse Function ────────────────────────────────────────────────────

/**
 * Parses an appeal letter into a structured Appeal_Data object.
 *
 * Routing logic:
 * - If the input contains ---METADATA--- / ---END_METADATA--- markers,
 *   it is treated as a system-generated letter and parsed deterministically.
 * - Otherwise, it is treated as an external letter and parsed via Bedrock.
 * - If the input is empty or contains no recognizable structure, a failure result is returned.
 *
 * @param letterText - The raw appeal letter text to parse
 * @returns AppealData with extraction status per field
 */
export async function parseAppealLetter(letterText: string): Promise<AppealData> {
  // Handle empty or whitespace-only input
  if (!letterText || letterText.trim().length === 0) {
    console.warn('[LETTER_PARSER] Received empty input.');
    return buildFailureResult();
  }

  // Route based on whether the letter is system-generated
  if (isSystemGeneratedLetter(letterText)) {
    console.info('[LETTER_PARSER] Detected system-generated letter. Using deterministic parsing.');
    return parseSystemGeneratedLetter(letterText);
  }

  // External letter: use Bedrock-based extraction
  console.info('[LETTER_PARSER] Detected external letter. Using Bedrock-based extraction.');
  return parseExternalLetter(letterText);
}

/**
 * Parses an external letter using Bedrock-based extraction.
 * Falls back to failure result if Bedrock extraction fails entirely.
 */
export async function parseExternalLetter(letterText: string): Promise<AppealData> {
  // Basic heuristic: check if the input looks like an appeal letter at all
  const hasAppealIndicators = detectAppealStructure(letterText);

  if (!hasAppealIndicators) {
    console.warn('[LETTER_PARSER] Input does not appear to contain appeal letter structure.');
    return buildFailureResult();
  }

  // Invoke Bedrock for extraction
  const extractionResult = await invokeBedrockExtraction(letterText);

  if (!extractionResult) {
    // Bedrock failed or guardrail intervened — return failure preserving input
    console.warn('[LETTER_PARSER] Bedrock extraction returned no result.');
    return buildFailureResult();
  }

  return convertBedrockResponse(extractionResult);
}

/**
 * Detects whether the input has basic appeal letter structure.
 * Uses simple heuristics to avoid sending random text to Bedrock.
 */
export function detectAppealStructure(input: string): boolean {
  const lowerInput = input.toLowerCase();

  // Look for common appeal letter indicators
  const indicators = [
    'appeal',
    'reconsideration',
    'denied',
    'denial',
    'claim',
    'patient',
    'medical necessity',
    'coverage determination',
    'grievance',
  ];

  const matchCount = indicators.filter((indicator) => lowerInput.includes(indicator)).length;

  // Require at least 2 indicators to consider it an appeal letter
  return matchCount >= 2;
}
