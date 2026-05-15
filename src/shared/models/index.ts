/**
 * Core data model interfaces for the Denial Appeal Agent.
 * All models align with the DynamoDB single-table design.
 */

// ─── Enum Types (String Literal Unions) ─────────────────────────────────────

export type SourceFormat = 'pdf' | 'tiff' | 'png' | 'jpeg' | 'edi_835' | 'edi_277';

export type DenialStatus =
  | 'ingested'
  | 'classified'
  | 'evidence_retrieved'
  | 'assessed'
  | 'letter_generated'
  | 'appealed'
  | 'resolved';

export type ClassificationMethod = 'structured_edi' | 'bedrock_nlp';

export type ReviewStatus = 'auto_classified' | 'pending_review' | 'unprocessable' | null;

export type FhirResourceType =
  | 'Encounter'
  | 'Procedure'
  | 'Condition'
  | 'DiagnosticReport'
  | 'DocumentReference';

export type EntityCategory = 'DIAGNOSIS' | 'PROCEDURE' | 'MEDICATION' | 'ANATOMY';

export type Recommendation = 'pursue' | 'do_not_pursue';

export type RationaleImpact = 'positive' | 'negative';

export type RegulatoryCitationType = 'lcd' | 'ncd' | 'state_mandate' | 'erisa';

export type OutcomeType = 'overturn' | 'partial_overturn' | 'upheld';

export type WorkflowStatusType = 'queued' | 'in_progress' | 'completed' | 'failed' | 'awaiting_retry';

export type WorkflowStep =
  | 'ingestion'
  | 'classification'
  | 'evidence_retrieval'
  | 'viability_assessment'
  | 'letter_generation';

export type StepStatus = 'completed' | 'failed' | 'skipped';

export type TenantStatus = 'active' | 'provisioning' | 'suspended' | 'deprovisioned';

export type ParseStatus = 'success' | 'partial' | 'failure';

// ─── Nested Types ───────────────────────────────────────────────────────────

export interface CarcCode {
  code: string;
  description: string;
  confidence: number;
  dollar_amount: number | null;
  rank: number;
  required_evidence_categories: string[];
}

export interface RarcCode {
  code: string;
  description: string;
  confidence: number;
}

export interface ExtractedEntity {
  text: string;
  category: EntityCategory;
  icd_code: string | null;
  confidence: number;
}

export interface EvidenceItem {
  fhir_resource_id: string;
  fhir_resource_type: FhirResourceType;
  date: string; // ISO 8601
  authoring_provider: string;
  relevance_score: number;
  extracted_entities: ExtractedEntity[];
  mapped_denial_reasons: string[];
}

export interface ConfidenceInterval {
  lower: number;
  upper: number;
  confidence_level: 0.90;
}

export interface RationaleFactor {
  factor: string;
  impact: RationaleImpact;
  weight: number;
}

export interface ViabilityInputs {
  denial_reason_code: string;
  payer_id: string;
  historical_overturn_rate: number;
  evidence_score: number;
  claim_amount: number;
  days_to_deadline: number;
}

export interface CitedEvidenceReference {
  fhir_resource_id: string;
  date: string;
  provider: string;
}

export interface RegulatoryCitation {
  type: RegulatoryCitationType;
  reference_id: string;
  section: string;
  description: string;
}

export interface AppealLetterMetadata {
  patient_id: string;
  claim_id: string;
  denial_reasons: string[];
  cited_evidence_references: CitedEvidenceReference[];
  regulatory_citations: RegulatoryCitation[];
  appeal_arguments: string[];
}

export interface StepHistoryEntry {
  step: string;
  status: StepStatus;
  started_at: string; // ISO 8601
  completed_at: string; // ISO 8601
  duration_ms: number;
  retry_count: number;
}

export interface ExtractedField<T> {
  value: T | null;
  extracted: boolean;
  reason: string | null;
}

// ─── Primary Data Models ────────────────────────────────────────────────────

/** Represents a denial record ingested from any source format. */
export interface DenialRecord {
  PK: string; // TENANT#<tenant_id>
  SK: string; // DENIAL#<claim_id>#<source_format>
  claim_id: string;
  patient_id: string;
  payer_id: string;
  tenant_id: string;
  denial_date: string; // ISO 8601
  denied_amount: number; // decimal, 2 places, USD
  raw_denial_reason_text: string;
  source_format: SourceFormat;
  source_s3_key: string;
  ingestion_timestamp: string; // ISO 8601
  status: DenialStatus;
  workflow_execution_id: string;
  ttl: number; // epoch seconds

  // GSI1 attributes
  GSI1PK?: string; // claim_id
  GSI1SK?: string; // tenant_id
}

/** Represents a classified denial with CARC/RARC codes. */
export interface ClassifiedDenial {
  PK: string; // TENANT#<tenant_id>
  SK: string; // CLASSIFICATION#<claim_id>
  claim_id: string;
  carc_codes: CarcCode[];
  rarc_codes: RarcCode[];
  classification_method: ClassificationMethod;
  dollar_ranking_available: boolean;
  review_status: ReviewStatus;
  classified_at: string; // ISO 8601
}

/** Represents a package of clinical evidence retrieved for a denial. */
export interface EvidencePackage {
  PK: string; // TENANT#<tenant_id>
  SK: string; // EVIDENCE#<claim_id>
  claim_id: string;
  patient_id: string;
  evidence_items: EvidenceItem[];
  total_evidence_count: number;
  retrieval_timestamp: string; // ISO 8601
  retrieval_duration_ms: number;
  manual_review_required: boolean;
}

/** Represents a viability assessment for an appeal. */
export interface ViabilityAssessment {
  PK: string; // TENANT#<tenant_id>
  SK: string; // VIABILITY#<claim_id>
  claim_id: string;
  viability_score: number; // 0.0-1.0
  confidence_interval: ConfidenceInterval;
  recommendation: Recommendation;
  rationale: RationaleFactor[];
  top_evidence_items: string[]; // FHIR resource IDs
  inputs: ViabilityInputs;
  limited_historical_data: boolean;
  deadline_expired: boolean;
  assessed_at: string; // ISO 8601
}

/** Represents a generated appeal letter. */
export interface AppealLetter {
  PK: string; // TENANT#<tenant_id>
  SK: string; // LETTER#<claim_id>#<version>
  claim_id: string;
  version: number;
  letter_body: string;
  metadata: AppealLetterMetadata;
  template_used: string;
  payer_template_available: boolean;
  incomplete_sections: string[];
  user_edited: boolean;
  generated_at: string; // ISO 8601
}

/** Represents parsed appeal data from a letter. */
export interface AppealData {
  patient_id: ExtractedField<string>;
  claim_id: ExtractedField<string>;
  denial_reasons: ExtractedField<string[]>;
  cited_evidence_references: ExtractedField<CitedEvidenceReference[]>;
  regulatory_citations: ExtractedField<RegulatoryCitation[]>;
  appeal_arguments: ExtractedField<string[]>;
  parse_status: ParseStatus;
  original_input_preserved: boolean;
}

/** Represents an appeal outcome record. */
export interface AppealOutcome {
  PK: string; // TENANT#<tenant_id>
  SK: string; // OUTCOME#<claim_id>
  claim_id: string;
  outcome_type: OutcomeType;
  denial_reason_code: string;
  payer_id: string;
  evidence_used: string[]; // FHIR resource IDs
  letter_version: number;
  time_to_resolution_days: number;
  recovered_amount: number; // USD, decimal 2 places
  received_at: string; // ISO 8601

  // GSI2 attributes
  GSI2PK?: string; // ${payer_id}#${denial_reason_code}
  GSI2SK?: string; // outcome_type
}

/** Represents the workflow status for a denial appeal pipeline execution. */
export interface WorkflowStatus {
  PK: string; // TENANT#<tenant_id>
  SK: string; // WORKFLOW#<claim_id>
  claim_id: string;
  execution_id: string;
  status: WorkflowStatusType;
  current_step: WorkflowStep;
  step_history: StepHistoryEntry[];
  started_at: string; // ISO 8601
  completed_at: string | null; // ISO 8601
  failure_reason: string | null;
  failed_step: string | null;

  // GSI3 attributes
  GSI3PK?: string; // status
  GSI3SK?: string; // started_at
}

/** Represents tenant-specific configuration. */
export interface TenantConfiguration {
  PK: string; // TENANT#<tenant_id>
  SK: string; // CONFIG
  tenant_id: string;
  tenant_name: string;
  kms_key_arn: string;
  s3_prefix: string;
  healthlake_datastore_id: string;
  webhook_endpoint: string | null;
  webhook_secret: string; // encrypted
  rate_limit_rpm: number; // >= 100
  notification_topic_arn: string;
  onboarded_at: string; // ISO 8601
  status: TenantStatus;
}

/** Represents an immutable audit log entry. */
export interface AuditLogEntry {
  PK: string; // AUDIT#<tenant_id>#<date>
  SK: string; // <timestamp>#<request_id>
  accessor_identity: string;
  timestamp: string; // ISO 8601 with milliseconds, UTC
  resource_accessed: string;
  action: string;
  permitted: boolean;
  tenant_id: string;
  request_id: string;
  source_ip: string;
}
