/**
 * Appeal Letter Generator Module
 *
 * Generates appeal letters using Amazon Bedrock with payer-specific templates,
 * clinical evidence citations, and regulatory references. Applies Bedrock Guardrails
 * for content safety, PII filtering, and contextual grounding.
 *
 * Template selection:
 * - Payer-specific templates stored in S3 at `templates/<payer_id>.json`
 * - Falls back to a default template when no payer-specific template exists
 *
 * Output format:
 * - letter_body: Human-readable prose (the actual appeal letter)
 * - metadata: Machine-readable JSON section with structured data
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  type InvokeModelCommandInput,
} from '@aws-sdk/client-bedrock-runtime';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import type {
  ViabilityAssessment,
  EvidencePackage,
  ClassifiedDenial,
  DenialRecord,
  AppealLetterMetadata,
  CitedEvidenceReference,
  RegulatoryCitation,
  EvidenceItem,
} from '@shared/models';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Payer-specific template loaded from S3 */
export interface PayerTemplate {
  payer_id: string;
  payer_name: string;
  letter_structure: string[];
  required_sections: string[];
  formatting_rules: {
    salutation: string;
    closing: string;
    address_format: string;
  };
  address_info: {
    appeals_department: string;
    street: string;
    city: string;
    state: string;
    zip: string;
  };
}

/** Default template used when no payer-specific template exists */
export const DEFAULT_TEMPLATE: PayerTemplate = {
  payer_id: 'default',
  payer_name: 'Insurance Company',
  letter_structure: [
    'header',
    'patient_identification',
    'claim_identification',
    'denial_reason_statement',
    'clinical_justification',
    'regulatory_references',
    'request_for_reconsideration',
    'closing',
  ],
  required_sections: [
    'patient_identification',
    'claim_identification',
    'denial_reason_statement',
    'clinical_justification',
    'request_for_reconsideration',
  ],
  formatting_rules: {
    salutation: 'Dear Appeals Department',
    closing: 'Sincerely',
    address_format: 'standard',
  },
  address_info: {
    appeals_department: 'Appeals Department',
    street: '',
    city: '',
    state: '',
    zip: '',
  },
};

/** Input for the letter generation function */
export interface LetterGenerationInput {
  viabilityAssessment: ViabilityAssessment;
  evidencePackage: EvidencePackage;
  classifiedDenial: ClassifiedDenial;
  denialRecord: DenialRecord;
  regulatoryCitations?: RegulatoryCitation[];
}

/** Result of the letter generation */
export interface LetterGenerationResult {
  letter_body: string;
  metadata: AppealLetterMetadata;
  template_used: string;
  payer_template_available: boolean;
  incomplete_sections: string[];
  guardrail_intervened: boolean;
}

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

function getTemplateBucket(): string {
  return process.env.TEMPLATE_BUCKET || '';
}

// ─── AWS SDK Clients ────────────────────────────────────────────────────────

let bedrockClient: BedrockRuntimeClient | null = null;
let s3Client: S3Client | null = null;

function getBedrockClient(): BedrockRuntimeClient {
  if (!bedrockClient) {
    bedrockClient = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1' });
  }
  return bedrockClient;
}

function getS3Client(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
  }
  return s3Client;
}

/** Allows injecting a mock Bedrock client for testing. */
export function setBedrockClient(client: BedrockRuntimeClient): void {
  bedrockClient = client;
}

/** Resets the Bedrock client (useful for testing cleanup). */
export function resetBedrockClient(): void {
  bedrockClient = null;
}

/** Allows injecting a mock S3 client for testing. */
export function setS3Client(client: S3Client): void {
  s3Client = client;
}

/** Resets the S3 client (useful for testing cleanup). */
export function resetS3Client(): void {
  s3Client = null;
}

// ─── Template Selection ─────────────────────────────────────────────────────

/**
 * Loads a payer-specific template from S3.
 * Returns null if the template does not exist or cannot be loaded.
 *
 * Templates are stored at: s3://<TEMPLATE_BUCKET>/templates/<payer_id>.json
 */
export async function loadPayerTemplate(payerId: string): Promise<PayerTemplate | null> {
  const bucket = getTemplateBucket();
  if (!bucket) {
    return null;
  }

  const key = `templates/${payerId}.json`;

  try {
    const client = getS3Client();
    const response = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key })
    );

    const body = await response.Body?.transformToString();
    if (!body) {
      return null;
    }

    const template = JSON.parse(body) as PayerTemplate;

    // Validate template structure
    if (!template.payer_id || !template.letter_structure || !template.required_sections) {
      console.warn(
        `[LETTER_GENERATOR] Invalid template structure for payer_id=${payerId}. Using default.`
      );
      return null;
    }

    return template;
  } catch (error: unknown) {
    const errorCode = (error as { name?: string })?.name;
    if (errorCode === 'NoSuchKey' || errorCode === 'AccessDenied') {
      // Template doesn't exist — expected for payers without custom templates
      return null;
    }
    console.warn(
      `[LETTER_GENERATOR] Failed to load template for payer_id=${payerId}:`,
      error
    );
    return null;
  }
}

/**
 * Selects the appropriate template for a given payer.
 * Returns the payer-specific template if available, otherwise the default.
 */
export async function selectTemplate(payerId: string): Promise<{
  template: PayerTemplate;
  payerTemplateAvailable: boolean;
}> {
  const payerTemplate = await loadPayerTemplate(payerId);

  if (payerTemplate) {
    return { template: payerTemplate, payerTemplateAvailable: true };
  }

  return { template: DEFAULT_TEMPLATE, payerTemplateAvailable: false };
}

// ─── Prompt Construction ────────────────────────────────────────────────────

/**
 * Builds the system prompt for the appeal letter generation.
 */
export function buildSystemPrompt(template: PayerTemplate): string {
  return `You are a healthcare revenue cycle specialist writing an appeal letter to an insurance company to request reconsideration of a denied claim. You must:

1. Write a professional, factual appeal letter following the provided template structure.
2. ONLY cite clinical evidence from the provided evidence list. Do NOT fabricate or hallucinate any citations, dates, providers, or clinical facts.
3. Reference specific FHIR resource IDs, dates, and providers exactly as provided.
4. Include regulatory references only if they are provided in the input.
5. Use a formal, professional tone appropriate for payer correspondence.
6. Structure the letter according to the template sections: ${template.letter_structure.join(', ')}.
7. Address the letter to: ${template.formatting_rules.salutation}.
8. End with: ${template.formatting_rules.closing}.

CRITICAL: You must NEVER invent clinical facts, fabricate evidence citations, or reference patient information that is not explicitly provided in the input. Every clinical claim must be traceable to a specific evidence item from the provided list.`;
}

/**
 * Builds the user prompt with all the context needed for letter generation.
 */
export function buildUserPrompt(input: LetterGenerationInput, template: PayerTemplate): string {
  const { viabilityAssessment, evidencePackage, classifiedDenial, denialRecord, regulatoryCitations } = input;

  // Patient demographics section
  const patientSection = `## Patient Information
- Patient ID: ${denialRecord.patient_id}
- Claim ID: ${denialRecord.claim_id}
- Date of Service: ${denialRecord.denial_date}
- Denied Amount: $${denialRecord.denied_amount.toFixed(2)}`;

  // Denial reasons section
  const denialReasons = classifiedDenial.carc_codes.map(
    (c) => `- ${c.code}: ${c.description} (Rank: ${c.rank})`
  ).join('\n');

  const rarcReasons = classifiedDenial.rarc_codes.map(
    (r) => `- ${r.code}: ${r.description}`
  ).join('\n');

  const denialSection = `## Denial Reasons Being Appealed
### CARC Codes:
${denialReasons}
${rarcReasons ? `### RARC Codes:\n${rarcReasons}` : ''}`;

  // Clinical evidence section
  const evidenceCitations = evidencePackage.evidence_items.map((item) => {
    const entities = item.extracted_entities.map(
      (e) => `    - ${e.text} (${e.category}${e.icd_code ? `, ICD: ${e.icd_code}` : ''}, confidence: ${e.confidence})`
    ).join('\n');

    return `- FHIR Resource: ${item.fhir_resource_id}
  - Type: ${item.fhir_resource_type}
  - Date: ${item.date}
  - Provider: ${item.authoring_provider}
  - Relevance Score: ${item.relevance_score}
  - Mapped Denial Reasons: ${item.mapped_denial_reasons.join(', ')}
  - Extracted Entities:
${entities}`;
  }).join('\n\n');

  const evidenceSection = `## Clinical Evidence (ONLY cite from this list)
${evidenceCitations || 'No clinical evidence available.'}`;

  // Regulatory references section
  let regulatorySection = '';
  if (regulatoryCitations && regulatoryCitations.length > 0) {
    const citations = regulatoryCitations.map(
      (r) => `- ${r.type.toUpperCase()}: ${r.reference_id}, Section ${r.section} — ${r.description}`
    ).join('\n');
    regulatorySection = `## Regulatory References
${citations}`;
  }

  // Payer address section
  const addressSection = template.address_info.street
    ? `## Payer Address
${template.address_info.appeals_department}
${template.address_info.street}
${template.address_info.city}, ${template.address_info.state} ${template.address_info.zip}`
    : '';

  // Instructions for output format
  const outputInstructions = `## Output Instructions
Generate the appeal letter with the following structure:
1. A professional appeal letter body that follows the template structure.
2. Include an explicit request for reconsideration stating the desired action (claim reprocessing or peer-to-peer review).
3. Cite specific evidence items by their FHIR resource IDs, dates, and providers.
4. After the letter body, include a metadata section in the following JSON format:

---METADATA---
{
  "patient_id": "${denialRecord.patient_id}",
  "claim_id": "${denialRecord.claim_id}",
  "denial_reasons": [${classifiedDenial.carc_codes.map(c => `"${c.code}"`).join(', ')}],
  "cited_evidence_references": [list of {"fhir_resource_id": "...", "date": "...", "provider": "..."} for each evidence item you cite],
  "regulatory_citations": [${regulatoryCitations ? regulatoryCitations.map(r => JSON.stringify(r)).join(', ') : ''}],
  "appeal_arguments": [list of key arguments made in the letter as strings]
}
---END_METADATA---`;

  return [patientSection, denialSection, evidenceSection, regulatorySection, addressSection, outputInstructions]
    .filter(Boolean)
    .join('\n\n');
}

// ─── Bedrock Invocation ─────────────────────────────────────────────────────

/**
 * Invokes Amazon Bedrock to generate the appeal letter.
 * Applies Bedrock Guardrails for content safety and contextual grounding.
 */
export async function invokeBedrockGeneration(
  systemPrompt: string,
  userPrompt: string
): Promise<{ responseBody: string; guardrailIntervened: boolean }> {
  const client = getBedrockClient();

  const requestBody = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 4096,
    temperature: 0.3,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: userPrompt,
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
  const response = await client.send(command);

  // Decode response body
  const responseBodyStr = new TextDecoder().decode(response.body);
  const responseJson = JSON.parse(responseBodyStr);

  // Check for guardrail intervention
  let guardrailIntervened = false;
  if (
    responseJson.stop_reason === 'guardrail_intervened' ||
    responseJson.amazon_bedrock_guardrailAction === 'INTERVENED'
  ) {
    guardrailIntervened = true;
    console.warn(
      '[LETTER_GENERATOR] Bedrock Guardrail intervened.',
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
 * Parses the Bedrock response into letter body and metadata sections.
 * The response is expected to contain a ---METADATA--- section.
 */
export function parseGeneratedLetter(responseText: string): {
  letterBody: string;
  metadata: AppealLetterMetadata | null;
} {
  if (!responseText || responseText.trim().length === 0) {
    return { letterBody: '', metadata: null };
  }

  // Split on metadata markers
  const metadataStart = responseText.indexOf('---METADATA---');
  const metadataEnd = responseText.indexOf('---END_METADATA---');

  if (metadataStart === -1 || metadataEnd === -1) {
    // No metadata section found — return entire response as letter body
    return { letterBody: responseText.trim(), metadata: null };
  }

  const letterBody = responseText.substring(0, metadataStart).trim();
  const metadataStr = responseText.substring(metadataStart + '---METADATA---'.length, metadataEnd).trim();

  let metadata: AppealLetterMetadata | null = null;
  try {
    const parsed = JSON.parse(metadataStr);
    metadata = validateMetadata(parsed);
  } catch {
    console.warn('[LETTER_GENERATOR] Failed to parse metadata section from generated letter.');
  }

  return { letterBody, metadata };
}

/**
 * Validates and normalizes the parsed metadata object.
 */
function validateMetadata(parsed: unknown): AppealLetterMetadata | null {
  if (!parsed || typeof parsed !== 'object') return null;

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.patient_id !== 'string') return null;
  if (typeof obj.claim_id !== 'string') return null;
  if (!Array.isArray(obj.denial_reasons)) return null;
  if (!Array.isArray(obj.cited_evidence_references)) return null;
  if (!Array.isArray(obj.regulatory_citations)) return null;
  if (!Array.isArray(obj.appeal_arguments)) return null;

  return {
    patient_id: obj.patient_id,
    claim_id: obj.claim_id,
    denial_reasons: obj.denial_reasons.filter((r): r is string => typeof r === 'string'),
    cited_evidence_references: (obj.cited_evidence_references as unknown[])
      .filter((ref): ref is CitedEvidenceReference => {
        if (!ref || typeof ref !== 'object') return false;
        const r = ref as Record<string, unknown>;
        return typeof r.fhir_resource_id === 'string' &&
               typeof r.date === 'string' &&
               typeof r.provider === 'string';
      }),
    regulatory_citations: (obj.regulatory_citations as unknown[])
      .filter((cit): cit is RegulatoryCitation => {
        if (!cit || typeof cit !== 'object') return false;
        const c = cit as Record<string, unknown>;
        return typeof c.type === 'string' &&
               typeof c.reference_id === 'string' &&
               typeof c.section === 'string' &&
               typeof c.description === 'string';
      }),
    appeal_arguments: obj.appeal_arguments.filter((a): a is string => typeof a === 'string'),
  };
}

// ─── Metadata Construction (Fallback) ───────────────────────────────────────

/**
 * Constructs metadata from the input data when Bedrock doesn't produce valid metadata.
 * This ensures the output always has a machine-readable metadata section.
 */
export function buildFallbackMetadata(input: LetterGenerationInput): AppealLetterMetadata {
  const { denialRecord, classifiedDenial, evidencePackage, regulatoryCitations } = input;

  const citedEvidenceReferences: CitedEvidenceReference[] = evidencePackage.evidence_items.map(
    (item: EvidenceItem) => ({
      fhir_resource_id: item.fhir_resource_id,
      date: item.date,
      provider: item.authoring_provider,
    })
  );

  return {
    patient_id: denialRecord.patient_id,
    claim_id: denialRecord.claim_id,
    denial_reasons: classifiedDenial.carc_codes.map((c) => c.code),
    cited_evidence_references: citedEvidenceReferences,
    regulatory_citations: regulatoryCitations || [],
    appeal_arguments: classifiedDenial.carc_codes.map(
      (c) => `Appeal of ${c.code}: ${c.description}`
    ),
  };
}

// ─── Incomplete Section Detection ───────────────────────────────────────────

/**
 * Identifies sections that are incomplete due to insufficient evidence.
 */
export function detectIncompleteSections(
  input: LetterGenerationInput,
  template: PayerTemplate
): string[] {
  const incomplete: string[] = [];

  // Check if clinical evidence is available
  if (
    !input.evidencePackage.evidence_items ||
    input.evidencePackage.evidence_items.length === 0
  ) {
    incomplete.push('clinical_justification');
  }

  // Check if regulatory references are available
  if (
    template.required_sections.includes('regulatory_references') &&
    (!input.regulatoryCitations || input.regulatoryCitations.length === 0)
  ) {
    incomplete.push('regulatory_references');
  }

  return incomplete;
}

// ─── Main Generation Function ───────────────────────────────────────────────

/**
 * Generates an appeal letter using Amazon Bedrock with payer-specific templates.
 *
 * @param input - All inputs needed for letter generation
 * @returns LetterGenerationResult with letter body, metadata, and generation info
 */
export async function generateAppealLetter(
  input: LetterGenerationInput
): Promise<LetterGenerationResult> {
  const { denialRecord, classifiedDenial, evidencePackage } = input;

  console.info(
    `[LETTER_GENERATOR] Generating appeal letter for claim_id=${denialRecord.claim_id}, payer_id=${denialRecord.payer_id}`
  );

  // 1. Select template
  const { template, payerTemplateAvailable } = await selectTemplate(denialRecord.payer_id);
  const templateUsed = payerTemplateAvailable
    ? `payer:${denialRecord.payer_id}`
    : 'default';

  // 2. Detect incomplete sections
  const incompleteSections = detectIncompleteSections(input, template);

  // 3. Build prompts
  const systemPrompt = buildSystemPrompt(template);
  const userPrompt = buildUserPrompt(input, template);

  // 4. Invoke Bedrock
  const { responseBody, guardrailIntervened } = await invokeBedrockGeneration(
    systemPrompt,
    userPrompt
  );

  // 5. Handle guardrail intervention with no response
  if (guardrailIntervened && (!responseBody || responseBody.trim().length === 0)) {
    console.warn(
      `[LETTER_GENERATOR] Guardrail blocked letter generation for claim_id=${denialRecord.claim_id}.`
    );
    const fallbackMetadata = buildFallbackMetadata(input);
    return {
      letter_body: '',
      metadata: fallbackMetadata,
      template_used: templateUsed,
      payer_template_available: payerTemplateAvailable,
      incomplete_sections: [...incompleteSections, 'letter_body'],
      guardrail_intervened: true,
    };
  }

  // 6. Parse the generated letter
  const { letterBody, metadata } = parseGeneratedLetter(responseBody);

  // 7. Use parsed metadata or build fallback
  const finalMetadata = metadata || buildFallbackMetadata(input);

  console.info(
    `[LETTER_GENERATOR] Letter generated for claim_id=${denialRecord.claim_id}:`,
    {
      template_used: templateUsed,
      payer_template_available: payerTemplateAvailable,
      letter_length: letterBody.length,
      cited_evidence_count: finalMetadata.cited_evidence_references.length,
      regulatory_citation_count: finalMetadata.regulatory_citations.length,
      incomplete_sections: incompleteSections,
      guardrail_intervened: guardrailIntervened,
    }
  );

  return {
    letter_body: letterBody,
    metadata: finalMetadata,
    template_used: templateUsed,
    payer_template_available: payerTemplateAvailable,
    incomplete_sections: incompleteSections,
    guardrail_intervened: guardrailIntervened,
  };
}
