/**
 * OpenAPI-style schema definitions for Bedrock Agent action groups.
 *
 * Each action group maps to an existing Lambda function in the denial appeal
 * pipeline. These schemas define the API contract that the Bedrock Agent uses
 * to understand how to invoke each action.
 *
 * Requirements: 10.1, 10.6
 */

// ─── Schema Types ───────────────────────────────────────────────────────────

/** OpenAPI parameter definition */
export interface ActionParameter {
  name: string;
  description: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  required: boolean;
  enum?: string[];
  items?: { type: string };
}

/** OpenAPI response schema definition */
export interface ResponseSchema {
  description: string;
  properties: Record<string, {
    type: string;
    description?: string;
    enum?: string[];
    items?: { type: string };
    format?: string;
  }>;
}

/** Action group schema definition */
export interface ActionGroupSchema {
  operationId: string;
  description: string;
  parameters: ActionParameter[];
  responseSchema: ResponseSchema;
}

// ─── Action Group Schemas ───────────────────────────────────────────────────

/**
 * Schema for the `ingest_denial` action group.
 * Accepts an S3 key and returns a DenialRecord.
 */
export const ingestDenialSchema: ActionGroupSchema = {
  operationId: 'ingestDenial',
  description: 'Ingest a denial document from S3, extract fields using Textract or EDI parsing, and create a DenialRecord in the system.',
  parameters: [
    {
      name: 's3_key',
      description: 'The S3 object key of the denial document to ingest (e.g., tenants/tenant-1/denials/doc.pdf)',
      type: 'string',
      required: true,
    },
    {
      name: 'tenant_id',
      description: 'The tenant identifier for multi-tenant isolation',
      type: 'string',
      required: true,
    },
  ],
  responseSchema: {
    description: 'The ingested DenialRecord with extracted fields',
    properties: {
      claim_id: { type: 'string', description: 'Unique claim identifier extracted from the document' },
      patient_id: { type: 'string', description: 'Patient identifier' },
      payer_id: { type: 'string', description: 'Payer/insurance company identifier' },
      denial_date: { type: 'string', format: 'date-time', description: 'Date the denial was issued (ISO 8601)' },
      denied_amount: { type: 'number', description: 'Amount denied in USD' },
      source_format: { type: 'string', description: 'Format of the source document', enum: ['pdf', 'tiff', 'png', 'jpeg', 'edi_835', 'edi_277'] },
      status: { type: 'string', description: 'Current processing status', enum: ['ingested', 'classified', 'evidence_retrieved', 'assessed', 'letter_generated', 'appealed', 'resolved'] },
      raw_denial_reason_text: { type: 'string', description: 'Raw denial reason text extracted from the document' },
      ingestion_timestamp: { type: 'string', format: 'date-time', description: 'Timestamp when the document was ingested' },
    },
  },
};

/**
 * Schema for the `classify_denial` action group.
 * Accepts a claim_id and returns a ClassifiedDenial.
 */
export const classifyDenialSchema: ActionGroupSchema = {
  operationId: 'classifyDenial',
  description: 'Classify a denial into CARC/RARC codes using structured EDI parsing or Bedrock NLP classification. Returns ranked denial reasons with confidence scores.',
  parameters: [
    {
      name: 'claim_id',
      description: 'The claim identifier to classify',
      type: 'string',
      required: true,
    },
    {
      name: 'tenant_id',
      description: 'The tenant identifier for multi-tenant isolation',
      type: 'string',
      required: true,
    },
  ],
  responseSchema: {
    description: 'The classified denial with CARC/RARC codes and confidence scores',
    properties: {
      claim_id: { type: 'string', description: 'Claim identifier' },
      carc_codes: { type: 'array', description: 'Ranked CARC codes with confidence scores and dollar amounts', items: { type: 'object' } },
      rarc_codes: { type: 'array', description: 'Associated RARC codes', items: { type: 'object' } },
      classification_method: { type: 'string', description: 'Method used for classification', enum: ['structured_edi', 'bedrock_nlp'] },
      dollar_ranking_available: { type: 'boolean', description: 'Whether dollar-based ranking was possible' },
      review_status: { type: 'string', description: 'Review status for low-confidence classifications', enum: ['auto_classified', 'pending_review', 'unprocessable'] },
      classified_at: { type: 'string', format: 'date-time', description: 'Timestamp of classification' },
    },
  },
};

/**
 * Schema for the `retrieve_evidence` action group.
 * Accepts a claim_id and returns an EvidencePackage.
 */
export const retrieveEvidenceSchema: ActionGroupSchema = {
  operationId: 'retrieveEvidence',
  description: 'Retrieve clinical evidence from HealthLake for a denial claim. Extracts medical entities using Comprehend Medical and scores relevance to the denial reasons.',
  parameters: [
    {
      name: 'claim_id',
      description: 'The claim identifier to retrieve evidence for',
      type: 'string',
      required: true,
    },
    {
      name: 'tenant_id',
      description: 'The tenant identifier for multi-tenant isolation',
      type: 'string',
      required: true,
    },
  ],
  responseSchema: {
    description: 'The evidence package with scored and ranked clinical evidence items',
    properties: {
      claim_id: { type: 'string', description: 'Claim identifier' },
      patient_id: { type: 'string', description: 'Patient identifier' },
      evidence_items: { type: 'array', description: 'Ranked evidence items with relevance scores (max 50)', items: { type: 'object' } },
      total_evidence_count: { type: 'integer', description: 'Total number of evidence items found' },
      retrieval_duration_ms: { type: 'integer', description: 'Time taken to retrieve evidence in milliseconds' },
      manual_review_required: { type: 'boolean', description: 'Whether manual review is needed (no evidence found or timeout)' },
    },
  },
};

/**
 * Schema for the `assess_viability` action group.
 * Accepts a claim_id and returns a ViabilityAssessment.
 */
export const assessViabilitySchema: ActionGroupSchema = {
  operationId: 'assessViability',
  description: 'Assess the viability of appealing a denial. Calculates a success probability score based on historical outcomes, evidence strength, and deadline proximity.',
  parameters: [
    {
      name: 'claim_id',
      description: 'The claim identifier to assess viability for',
      type: 'string',
      required: true,
    },
    {
      name: 'tenant_id',
      description: 'The tenant identifier for multi-tenant isolation',
      type: 'string',
      required: true,
    },
  ],
  responseSchema: {
    description: 'The viability assessment with score, recommendation, and rationale',
    properties: {
      claim_id: { type: 'string', description: 'Claim identifier' },
      viability_score: { type: 'number', description: 'Viability score from 0.0 to 1.0' },
      recommendation: { type: 'string', description: 'Recommendation based on score threshold (>= 0.3 = pursue)', enum: ['pursue', 'do_not_pursue'] },
      confidence_interval: { type: 'object', description: 'Wilson score confidence interval (90% level)' },
      rationale: { type: 'array', description: 'Factors contributing to the assessment', items: { type: 'object' } },
      top_evidence_items: { type: 'array', description: 'Top 3 evidence FHIR resource IDs for pursue recommendations', items: { type: 'string' } },
      limited_historical_data: { type: 'boolean', description: 'Whether fewer than 30 historical outcomes were available' },
      deadline_expired: { type: 'boolean', description: 'Whether the appeal deadline has passed' },
    },
  },
};

/**
 * Schema for the `generate_appeal` action group.
 * Accepts a claim_id and returns an AppealLetter.
 */
export const generateAppealSchema: ActionGroupSchema = {
  operationId: 'generateAppeal',
  description: 'Generate an appeal letter using payer-specific templates, clinical evidence citations, and regulatory references. Applies Bedrock Guardrails for content safety.',
  parameters: [
    {
      name: 'claim_id',
      description: 'The claim identifier to generate an appeal letter for',
      type: 'string',
      required: true,
    },
    {
      name: 'tenant_id',
      description: 'The tenant identifier for multi-tenant isolation',
      type: 'string',
      required: true,
    },
  ],
  responseSchema: {
    description: 'The generated appeal letter with metadata and citations',
    properties: {
      claim_id: { type: 'string', description: 'Claim identifier' },
      version: { type: 'integer', description: 'Letter version number' },
      letter_body: { type: 'string', description: 'Full text of the generated appeal letter' },
      template_used: { type: 'string', description: 'Name of the template used for generation' },
      payer_template_available: { type: 'boolean', description: 'Whether a payer-specific template was available' },
      incomplete_sections: { type: 'array', description: 'Sections flagged as incomplete due to insufficient evidence', items: { type: 'string' } },
      generated_at: { type: 'string', format: 'date-time', description: 'Timestamp of letter generation' },
    },
  },
};

/**
 * Schema for the `record_outcome` action group.
 * Accepts outcome data and returns an AppealOutcome.
 */
export const recordOutcomeSchema: ActionGroupSchema = {
  operationId: 'recordOutcome',
  description: 'Record the outcome of an appeal for analytics, model improvement, and statistical change detection.',
  parameters: [
    {
      name: 'claim_id',
      description: 'The claim identifier for the appeal outcome',
      type: 'string',
      required: true,
    },
    {
      name: 'tenant_id',
      description: 'The tenant identifier for multi-tenant isolation',
      type: 'string',
      required: true,
    },
    {
      name: 'outcome_type',
      description: 'The type of outcome received',
      type: 'string',
      required: true,
      enum: ['overturn', 'partial_overturn', 'upheld'],
    },
    {
      name: 'denial_reason_code',
      description: 'The CARC code for the denial reason',
      type: 'string',
      required: true,
    },
    {
      name: 'payer_id',
      description: 'The payer/insurance company identifier',
      type: 'string',
      required: true,
    },
    {
      name: 'time_to_resolution_days',
      description: 'Number of days from appeal submission to resolution',
      type: 'integer',
      required: true,
    },
    {
      name: 'recovered_amount',
      description: 'Amount recovered in USD (0 if upheld)',
      type: 'number',
      required: false,
    },
    {
      name: 'evidence_used',
      description: 'FHIR resource IDs of evidence items used in the appeal',
      type: 'array',
      required: false,
      items: { type: 'string' },
    },
  ],
  responseSchema: {
    description: 'The recorded appeal outcome',
    properties: {
      claim_id: { type: 'string', description: 'Claim identifier' },
      outcome_type: { type: 'string', description: 'Outcome type', enum: ['overturn', 'partial_overturn', 'upheld'] },
      denial_reason_code: { type: 'string', description: 'CARC denial reason code' },
      payer_id: { type: 'string', description: 'Payer identifier' },
      time_to_resolution_days: { type: 'integer', description: 'Days to resolution' },
      recovered_amount: { type: 'number', description: 'Amount recovered in USD' },
      received_at: { type: 'string', format: 'date-time', description: 'Timestamp when outcome was recorded' },
    },
  },
};

// ─── Exported Schema Collection ─────────────────────────────────────────────

/**
 * Complete collection of all action group schemas.
 * Used by the CDK stack to configure Bedrock Agent action groups.
 */
export const ACTION_GROUP_SCHEMAS = {
  ingest_denial: ingestDenialSchema,
  classify_denial: classifyDenialSchema,
  retrieve_evidence: retrieveEvidenceSchema,
  assess_viability: assessViabilitySchema,
  generate_appeal: generateAppealSchema,
  record_outcome: recordOutcomeSchema,
} as const;

export type ActionGroupName = keyof typeof ACTION_GROUP_SCHEMAS;
