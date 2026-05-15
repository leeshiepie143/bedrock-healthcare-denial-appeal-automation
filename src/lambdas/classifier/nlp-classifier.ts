/**
 * NLP Classifier Lambda
 *
 * Uses Amazon Bedrock (Claude) to classify free-text denial reasons from
 * unstructured documents (PDF/fax) into standardized CARC/RARC codes.
 * Applies Bedrock Guardrails for grounding checks against the CARC code reference.
 *
 * Confidence routing:
 * - >= 0.8: auto-classified
 * - < 0.8: pending_review with top 3 candidates
 * - empty/null text: unprocessable
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  type InvokeModelCommandInput,
} from '@aws-sdk/client-bedrock-runtime';
import type { CarcCode, RarcCode, ClassifiedDenial, DenialRecord, ReviewStatus } from '@shared/models';

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

/** Allows injecting a mock client for testing. */
export function setBedrockClient(client: BedrockRuntimeClient): void {
  bedrockClient = client;
}

/** Resets the client (useful for testing cleanup). */
export function resetBedrockClient(): void {
  bedrockClient = null;
}

// ─── Types ──────────────────────────────────────────────────────────────────

/** Result of the NLP classification */
export interface NlpClassificationResult {
  carc_codes: CarcCode[];
  rarc_codes: RarcCode[];
  review_status: ReviewStatus;
  classification_method: 'bedrock_nlp';
  guardrail_intervened: boolean;
}

/** Raw response structure expected from Bedrock */
export interface BedrockClassificationResponse {
  carc_codes: Array<{
    code: string;
    description: string;
    confidence: number;
    required_evidence_categories: string[];
  }>;
  rarc_codes: Array<{
    code: string;
    description: string;
    confidence: number;
  }>;
}

// ─── CARC/RARC Reference Data ───────────────────────────────────────────────

/**
 * Common CARC codes with descriptions for the Bedrock prompt.
 * This reference list helps the model map free-text denial reasons to codes.
 */
export const CARC_REFERENCE: Array<{ code: string; description: string; evidence_categories: string[] }> = [
  { code: 'CO-4', description: 'The procedure code is inconsistent with the modifier used or a required modifier is missing.', evidence_categories: ['PROCEDURE', 'DOCUMENTATION'] },
  { code: 'CO-11', description: 'The diagnosis is inconsistent with the procedure.', evidence_categories: ['DIAGNOSIS', 'PROCEDURE'] },
  { code: 'CO-16', description: 'Claim/service lacks information or has submission/billing error(s).', evidence_categories: ['DOCUMENTATION'] },
  { code: 'CO-18', description: 'Exact duplicate claim/service.', evidence_categories: ['DOCUMENTATION'] },
  { code: 'CO-22', description: 'This care may be covered by another payer per coordination of benefits.', evidence_categories: ['DOCUMENTATION'] },
  { code: 'CO-27', description: 'Expenses incurred after coverage terminated.', evidence_categories: ['DOCUMENTATION'] },
  { code: 'CO-29', description: 'The time limit for filing has expired.', evidence_categories: ['DOCUMENTATION'] },
  { code: 'CO-45', description: 'Charge exceeds fee schedule/maximum allowable or contracted/legislated fee arrangement.', evidence_categories: ['DOCUMENTATION'] },
  { code: 'CO-50', description: 'These are non-covered services because this is not deemed a medical necessity by the payer.', evidence_categories: ['DIAGNOSIS', 'PROCEDURE', 'MEDICAL_RECORDS'] },
  { code: 'CO-96', description: 'Non-covered charge(s). At least one Remark Code must be provided.', evidence_categories: ['DOCUMENTATION'] },
  { code: 'CO-97', description: 'The benefit for this service is included in the payment/allowance for another service/procedure that has already been adjudicated.', evidence_categories: ['PROCEDURE'] },
  { code: 'CO-109', description: 'Claim/service not covered by this payer/contractor. You must send the claim/service to the correct payer/contractor.', evidence_categories: ['DOCUMENTATION'] },
  { code: 'CO-119', description: 'Benefit maximum for this time period or occurrence has been reached.', evidence_categories: ['DOCUMENTATION', 'MEDICAL_RECORDS'] },
  { code: 'CO-167', description: 'This (these) diagnosis(es) is (are) not covered.', evidence_categories: ['DIAGNOSIS'] },
  { code: 'CO-197', description: 'Precertification/authorization/notification absent.', evidence_categories: ['AUTHORIZATION'] },
  { code: 'CO-198', description: 'Precertification/authorization exceeded.', evidence_categories: ['AUTHORIZATION'] },
  { code: 'CO-204', description: 'This service/equipment/drug is not covered under the patient\'s current benefit plan.', evidence_categories: ['DOCUMENTATION'] },
  { code: 'CO-236', description: 'This procedure or procedure/modifier combination is not compatible with another procedure or procedure/modifier combination provided on the same day.', evidence_categories: ['PROCEDURE'] },
  { code: 'PR-1', description: 'Deductible amount.', evidence_categories: ['DOCUMENTATION'] },
  { code: 'PR-2', description: 'Coinsurance amount.', evidence_categories: ['DOCUMENTATION'] },
  { code: 'PR-3', description: 'Co-payment amount.', evidence_categories: ['DOCUMENTATION'] },
];

/**
 * Common RARC codes for supplemental explanation.
 */
export const RARC_REFERENCE: Array<{ code: string; description: string }> = [
  { code: 'N30', description: 'Patient ineligible for this service.' },
  { code: 'N115', description: 'This decision was based on a Local Coverage Determination (LCD).' },
  { code: 'N386', description: 'This decision was based on a National Coverage Determination (NCD).' },
  { code: 'N479', description: 'Missing/Incomplete/Invalid documentation.' },
  { code: 'N522', description: 'Duplicate of a claim processed, or to be processed, as a crossover claim.' },
  { code: 'N657', description: 'This claim/service was processed based on the payer\'s internal clinical criteria/guidelines.' },
  { code: 'M76', description: 'Missing/incomplete/invalid diagnosis or condition.' },
  { code: 'MA130', description: 'Your claim contains incomplete and/or invalid information.' },
  { code: 'N362', description: 'The number of days or units of service exceeds our acceptable maximum.' },
  { code: 'N432', description: 'Alert: Adjustment based on a Recovery Audit.' },
];

// ─── Prompt Construction ────────────────────────────────────────────────────

/**
 * Constructs the Bedrock prompt for classifying free-text denial reasons
 * into CARC/RARC codes.
 */
export function buildClassificationPrompt(denialText: string): string {
  const carcList = CARC_REFERENCE.map(
    (c) => `  - ${c.code}: ${c.description} [Evidence: ${c.evidence_categories.join(', ')}]`
  ).join('\n');

  const rarcList = RARC_REFERENCE.map(
    (c) => `  - ${c.code}: ${c.description}`
  ).join('\n');

  return `You are a healthcare claims denial classification expert. Your task is to analyze the following denial reason text and map it to the most applicable CARC (Claim Adjustment Reason Code) and RARC (Remittance Advice Remark Code) codes.

## CARC Code Reference:
${carcList}

## RARC Code Reference:
${rarcList}

## Denial Reason Text:
"${denialText}"

## Instructions:
1. Identify the most applicable CARC code(s) from the reference list above that match the denial reason text.
2. Identify any applicable RARC code(s) that provide supplemental explanation.
3. For each code, provide a confidence score between 0.0 and 1.0 indicating how well the code matches the denial text.
4. For each CARC code, list the required evidence categories needed to support an appeal.
5. Return your analysis as a JSON object.

## Response Format:
Respond ONLY with a valid JSON object in the following format (no additional text):
{
  "carc_codes": [
    {
      "code": "CO-XX",
      "description": "Description of the code",
      "confidence": 0.95,
      "required_evidence_categories": ["CATEGORY1", "CATEGORY2"]
    }
  ],
  "rarc_codes": [
    {
      "code": "NXXX",
      "description": "Description of the code",
      "confidence": 0.90
    }
  ]
}`;
}

// ─── Bedrock Invocation ─────────────────────────────────────────────────────

/**
 * Invokes Amazon Bedrock with the classification prompt and guardrails.
 * Returns the raw response body as a string.
 */
export async function invokeBedrockClassification(denialText: string): Promise<{
  responseBody: string;
  guardrailIntervened: boolean;
}> {
  const client = getBedrockClient();
  const prompt = buildClassificationPrompt(denialText);

  const requestBody = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 2048,
    temperature: 0.1,
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
  });

  const input: InvokeModelCommandInput = {
    modelId: getModelId(),
    contentType: 'application/json',
    accept: 'application/json',
    body: requestBody,
  };

  // Apply guardrails if configured
  const guardrailId = getGuardrailId();
  if (guardrailId) {
    input.guardrailIdentifier = guardrailId;
    input.guardrailVersion = getGuardrailVersion();
  }

  const command = new InvokeModelCommand(input);
  const response = await client.send(command);

  // Decode response body
  const responseBodyStr = new TextDecoder().decode(response.body);
  const responseJson = JSON.parse(responseBodyStr);

  // Check for guardrail intervention
  let guardrailIntervened = false;
  if (responseJson.stop_reason === 'guardrail_intervened' ||
      responseJson.amazon_bedrock_guardrailAction === 'INTERVENED') {
    guardrailIntervened = true;
    console.warn(
      '[NLP_CLASSIFIER] Bedrock Guardrail intervened.',
      JSON.stringify({
        guardrailId,
        guardrailVersion: getGuardrailVersion(),
        action: responseJson.amazon_bedrock_guardrailAction,
      })
    );
  }

  // Extract text content from Claude response format
  const textContent = responseJson.content?.find(
    (block: { type: string }) => block.type === 'text'
  );
  const responseText = textContent?.text || '';

  return { responseBody: responseText, guardrailIntervened };
}

// ─── Response Parsing ───────────────────────────────────────────────────────

/**
 * Parses the Bedrock response text into structured CARC/RARC codes.
 * Handles JSON extraction from potentially wrapped responses.
 */
export function parseBedrockResponse(responseText: string): BedrockClassificationResponse | null {
  if (!responseText || responseText.trim().length === 0) {
    return null;
  }

  try {
    // Try direct JSON parse first
    const parsed = JSON.parse(responseText);
    if (isValidClassificationResponse(parsed)) {
      return parsed;
    }
  } catch {
    // If direct parse fails, try to extract JSON from the response
  }

  // Try to extract JSON from markdown code blocks or surrounding text
  const jsonMatch = responseText.match(/\{[\s\S]*"carc_codes"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (isValidClassificationResponse(parsed)) {
        return parsed;
      }
    } catch {
      // JSON extraction failed
    }
  }

  return null;
}

/**
 * Validates that a parsed object has the expected classification response structure.
 */
function isValidClassificationResponse(obj: unknown): obj is BedrockClassificationResponse {
  if (!obj || typeof obj !== 'object') return false;
  const response = obj as Record<string, unknown>;

  if (!Array.isArray(response.carc_codes)) return false;
  if (!Array.isArray(response.rarc_codes)) return false;

  // Validate each CARC code entry
  for (const carc of response.carc_codes) {
    if (!carc || typeof carc !== 'object') return false;
    const c = carc as Record<string, unknown>;
    if (typeof c.code !== 'string') return false;
    if (typeof c.description !== 'string') return false;
    if (typeof c.confidence !== 'number' || c.confidence < 0 || c.confidence > 1) return false;
    if (!Array.isArray(c.required_evidence_categories)) return false;
  }

  // Validate each RARC code entry
  for (const rarc of response.rarc_codes) {
    if (!rarc || typeof rarc !== 'object') return false;
    const r = rarc as Record<string, unknown>;
    if (typeof r.code !== 'string') return false;
    if (typeof r.description !== 'string') return false;
    if (typeof r.confidence !== 'number' || r.confidence < 0 || r.confidence > 1) return false;
  }

  return true;
}

// ─── Confidence Routing ─────────────────────────────────────────────────────

/** Confidence threshold for automated classification */
const CONFIDENCE_THRESHOLD = 0.8;

/** Maximum number of candidates to include in human review */
const MAX_REVIEW_CANDIDATES = 3;

/**
 * Determines the review status based on the highest confidence score.
 * - >= 0.8: auto_classified
 * - < 0.8: pending_review (top 3 candidates returned)
 */
export function determineReviewStatus(carcCodes: CarcCode[]): ReviewStatus {
  if (carcCodes.length === 0) {
    return 'unprocessable';
  }

  const highestConfidence = Math.max(...carcCodes.map((c) => c.confidence));

  if (highestConfidence >= CONFIDENCE_THRESHOLD) {
    return 'auto_classified';
  }

  return 'pending_review';
}

/**
 * Filters and ranks CARC codes for human review.
 * Returns top 3 candidates sorted by confidence (descending).
 */
export function getTopCandidates(carcCodes: CarcCode[]): CarcCode[] {
  return [...carcCodes]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_REVIEW_CANDIDATES);
}

// ─── Main Classification Function ──────────────────────────────────────────

/**
 * Classifies a denial record's free-text reason using Amazon Bedrock NLP.
 *
 * @param denialRecord - The denial record with raw_denial_reason_text to classify
 * @returns Classification result with CARC/RARC codes and review status
 */
export async function classifyWithNlp(denialRecord: DenialRecord): Promise<NlpClassificationResult> {
  const denialText = denialRecord.raw_denial_reason_text;

  // Handle empty/null denial text → unprocessable
  if (!denialText || denialText.trim().length === 0) {
    console.warn(
      `[NLP_CLASSIFIER] Empty denial text for claim_id=${denialRecord.claim_id}. Marking as unprocessable.`
    );
    return {
      carc_codes: [],
      rarc_codes: [],
      review_status: 'unprocessable',
      classification_method: 'bedrock_nlp',
      guardrail_intervened: false,
    };
  }

  // Invoke Bedrock for classification
  const { responseBody, guardrailIntervened } = await invokeBedrockClassification(denialText);

  // If guardrail intervened completely, mark as unprocessable
  if (guardrailIntervened && (!responseBody || responseBody.trim().length === 0)) {
    console.warn(
      `[NLP_CLASSIFIER] Guardrail blocked classification for claim_id=${denialRecord.claim_id}.`
    );
    return {
      carc_codes: [],
      rarc_codes: [],
      review_status: 'unprocessable',
      classification_method: 'bedrock_nlp',
      guardrail_intervened: true,
    };
  }

  // Parse the Bedrock response
  const parsedResponse = parseBedrockResponse(responseBody);

  // Handle unparseable response
  if (!parsedResponse) {
    console.warn(
      `[NLP_CLASSIFIER] Unparseable Bedrock response for claim_id=${denialRecord.claim_id}.`,
      { responseBody: responseBody.substring(0, 200) }
    );
    return {
      carc_codes: [],
      rarc_codes: [],
      review_status: 'unprocessable',
      classification_method: 'bedrock_nlp',
      guardrail_intervened: guardrailIntervened,
    };
  }

  // Convert parsed response to typed CARC/RARC codes with ranking
  const carcCodes: CarcCode[] = parsedResponse.carc_codes.map((c, index) => ({
    code: c.code,
    description: c.description,
    confidence: c.confidence,
    dollar_amount: null, // NLP classification doesn't have dollar amounts
    rank: index + 1,
    required_evidence_categories: c.required_evidence_categories,
  }));

  const rarcCodes: RarcCode[] = parsedResponse.rarc_codes.map((r) => ({
    code: r.code,
    description: r.description,
    confidence: r.confidence,
  }));

  // Determine review status based on confidence
  const reviewStatus = determineReviewStatus(carcCodes);

  // If pending review, limit to top 3 candidates
  const finalCarcCodes = reviewStatus === 'pending_review'
    ? getTopCandidates(carcCodes)
    : carcCodes;

  console.info(
    `[NLP_CLASSIFIER] Classification complete for claim_id=${denialRecord.claim_id}:`,
    {
      review_status: reviewStatus,
      carc_count: finalCarcCodes.length,
      rarc_count: rarcCodes.length,
      highest_confidence: finalCarcCodes.length > 0
        ? Math.max(...finalCarcCodes.map((c) => c.confidence))
        : 0,
      guardrail_intervened: guardrailIntervened,
    }
  );

  return {
    carc_codes: finalCarcCodes,
    rarc_codes: rarcCodes,
    review_status: reviewStatus,
    classification_method: 'bedrock_nlp',
    guardrail_intervened: guardrailIntervened,
  };
}
