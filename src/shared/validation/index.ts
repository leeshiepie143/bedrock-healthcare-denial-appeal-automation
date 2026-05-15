/**
 * Shared validation utilities for the Denial Appeal Agent.
 * Provides validators for ISO 8601 dates, decimal amounts, and enum values.
 */

// ─── ISO 8601 Date Validation ───────────────────────────────────────────────

/**
 * ISO 8601 date/datetime regex pattern.
 * Matches: YYYY-MM-DD, YYYY-MM-DDTHH:mm:ssZ, YYYY-MM-DDTHH:mm:ss.sssZ,
 * YYYY-MM-DDTHH:mm:ss±HH:MM
 */
const ISO_8601_PATTERN =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/;

/**
 * Validates that a string is a valid ISO 8601 date or datetime.
 * Accepts date-only (YYYY-MM-DD) and full datetime with timezone.
 */
export function isValidISO8601(value: string): boolean {
  if (!ISO_8601_PATTERN.test(value)) {
    return false;
  }
  // Extract year, month, day and validate the date components
  const year = parseInt(value.substring(0, 4), 10);
  const month = parseInt(value.substring(5, 7), 10);
  const day = parseInt(value.substring(8, 10), 10);

  // Construct a date from components and verify it matches
  const testDate = new Date(Date.UTC(year, month - 1, day));
  return (
    testDate.getUTCFullYear() === year &&
    testDate.getUTCMonth() === month - 1 &&
    testDate.getUTCDate() === day
  );
}

/**
 * ISO 8601 datetime with millisecond precision in UTC.
 * Matches: YYYY-MM-DDTHH:mm:ss.sssZ
 */
const ISO_8601_MS_UTC_PATTERN =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;

/**
 * Validates that a string is a valid ISO 8601 datetime with millisecond precision in UTC.
 * Required for audit log timestamps.
 */
export function isValidISO8601WithMillisUTC(value: string): boolean {
  if (!ISO_8601_MS_UTC_PATTERN.test(value)) {
    return false;
  }
  const date = new Date(value);
  return !isNaN(date.getTime());
}

// ─── Decimal Amount Validation ──────────────────────────────────────────────

/**
 * Validates that a number is a valid USD amount (non-negative, max 2 decimal places).
 */
export function isValidUSDAmount(value: number): boolean {
  if (typeof value !== 'number' || isNaN(value) || !isFinite(value)) {
    return false;
  }
  if (value < 0) {
    return false;
  }
  // Check max 2 decimal places
  const decimalStr = value.toString();
  const decimalIndex = decimalStr.indexOf('.');
  if (decimalIndex === -1) {
    return true; // whole number is valid
  }
  return decimalStr.length - decimalIndex - 1 <= 2;
}

/**
 * Rounds a number to exactly 2 decimal places (banker's rounding).
 * Use this when storing USD amounts.
 */
export function roundToUSD(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

// ─── Score/Probability Validation ───────────────────────────────────────────

/**
 * Validates that a number is a valid score/probability in [0.0, 1.0].
 */
export function isValidScore(value: number): boolean {
  if (typeof value !== 'number' || isNaN(value) || !isFinite(value)) {
    return false;
  }
  return value >= 0.0 && value <= 1.0;
}

// ─── Enum Validation ────────────────────────────────────────────────────────

/**
 * Creates a type-safe enum validator for a set of allowed string values.
 * Returns a function that checks if a value is one of the allowed values.
 *
 * @example
 * const isValidStatus = createEnumValidator(['active', 'inactive']);
 * isValidStatus('active'); // true
 * isValidStatus('unknown'); // false
 */
export function createEnumValidator<T extends string>(allowedValues: readonly T[]): (value: string) => value is T {
  const valueSet = new Set<string>(allowedValues);
  return (value: string): value is T => valueSet.has(value);
}

// ─── Pre-built Enum Validators ──────────────────────────────────────────────

import type {
  SourceFormat,
  DenialStatus,
  ClassificationMethod,
  FhirResourceType,
  EntityCategory,
  Recommendation,
  OutcomeType,
  WorkflowStatusType,
  WorkflowStep,
  StepStatus,
  TenantStatus,
  ParseStatus,
  RegulatoryCitationType,
} from '../models';

const SOURCE_FORMATS: readonly SourceFormat[] = ['pdf', 'tiff', 'png', 'jpeg', 'edi_835', 'edi_277'];
const DENIAL_STATUSES: readonly DenialStatus[] = [
  'ingested', 'classified', 'evidence_retrieved', 'assessed', 'letter_generated', 'appealed', 'resolved',
];
const CLASSIFICATION_METHODS: readonly ClassificationMethod[] = ['structured_edi', 'bedrock_nlp'];
const FHIR_RESOURCE_TYPES: readonly FhirResourceType[] = [
  'Encounter', 'Procedure', 'Condition', 'DiagnosticReport', 'DocumentReference',
];
const ENTITY_CATEGORIES: readonly EntityCategory[] = ['DIAGNOSIS', 'PROCEDURE', 'MEDICATION', 'ANATOMY'];
const RECOMMENDATIONS: readonly Recommendation[] = ['pursue', 'do_not_pursue'];
const OUTCOME_TYPES: readonly OutcomeType[] = ['overturn', 'partial_overturn', 'upheld'];
const WORKFLOW_STATUS_TYPES: readonly WorkflowStatusType[] = [
  'queued', 'in_progress', 'completed', 'failed', 'awaiting_retry',
];
const WORKFLOW_STEPS: readonly WorkflowStep[] = [
  'ingestion', 'classification', 'evidence_retrieval', 'viability_assessment', 'letter_generation',
];
const STEP_STATUSES: readonly StepStatus[] = ['completed', 'failed', 'skipped'];
const TENANT_STATUSES: readonly TenantStatus[] = ['active', 'provisioning', 'suspended', 'deprovisioned'];
const PARSE_STATUSES: readonly ParseStatus[] = ['success', 'partial', 'failure'];
const REGULATORY_CITATION_TYPES: readonly RegulatoryCitationType[] = ['lcd', 'ncd', 'state_mandate', 'erisa'];

export const isValidSourceFormat = createEnumValidator(SOURCE_FORMATS);
export const isValidDenialStatus = createEnumValidator(DENIAL_STATUSES);
export const isValidClassificationMethod = createEnumValidator(CLASSIFICATION_METHODS);
export const isValidFhirResourceType = createEnumValidator(FHIR_RESOURCE_TYPES);
export const isValidEntityCategory = createEnumValidator(ENTITY_CATEGORIES);
export const isValidRecommendation = createEnumValidator(RECOMMENDATIONS);
export const isValidOutcomeType = createEnumValidator(OUTCOME_TYPES);
export const isValidWorkflowStatusType = createEnumValidator(WORKFLOW_STATUS_TYPES);
export const isValidWorkflowStep = createEnumValidator(WORKFLOW_STEPS);
export const isValidStepStatus = createEnumValidator(STEP_STATUSES);
export const isValidTenantStatus = createEnumValidator(TENANT_STATUSES);
export const isValidParseStatus = createEnumValidator(PARSE_STATUSES);
export const isValidRegulatoryCitationType = createEnumValidator(REGULATORY_CITATION_TYPES);

// ─── Composite Validators ───────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates that a string is non-empty after trimming.
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validates that a value is a positive integer.
 */
export function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

/**
 * Validates the mandatory fields of a Denial_Record.
 * Returns a ValidationResult with specific error messages for each invalid field.
 */
export function validateDenialRecordFields(record: {
  claim_id?: unknown;
  patient_id?: unknown;
  payer_id?: unknown;
  denial_date?: unknown;
  denied_amount?: unknown;
  raw_denial_reason_text?: unknown;
}): ValidationResult {
  const errors: string[] = [];

  if (!isNonEmptyString(record.claim_id)) {
    errors.push('claim_id must be a non-empty string');
  }
  if (!isNonEmptyString(record.patient_id)) {
    errors.push('patient_id must be a non-empty string');
  }
  if (!isNonEmptyString(record.payer_id)) {
    errors.push('payer_id must be a non-empty string');
  }
  if (typeof record.denial_date !== 'string' || !isValidISO8601(record.denial_date)) {
    errors.push('denial_date must be a valid ISO 8601 date string');
  }
  if (typeof record.denied_amount !== 'number' || !isValidUSDAmount(record.denied_amount)) {
    errors.push('denied_amount must be a non-negative number with at most 2 decimal places');
  }
  if (!isNonEmptyString(record.raw_denial_reason_text)) {
    errors.push('raw_denial_reason_text must be a non-empty string');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validates the required fields of an Appeal_Outcome record.
 * Returns a ValidationResult indicating which fields are missing.
 */
export function validateOutcomeFields(record: {
  denial_reason_code?: unknown;
  payer_id?: unknown;
  outcome_type?: unknown;
  time_to_resolution_days?: unknown;
}): ValidationResult {
  const errors: string[] = [];

  if (!isNonEmptyString(record.denial_reason_code)) {
    errors.push('denial_reason_code is required');
  }
  if (!isNonEmptyString(record.payer_id)) {
    errors.push('payer_id is required');
  }
  if (typeof record.outcome_type !== 'string' || !isValidOutcomeType(record.outcome_type)) {
    errors.push('outcome_type must be one of: overturn, partial_overturn, upheld');
  }
  if (typeof record.time_to_resolution_days !== 'number' || !isPositiveInteger(record.time_to_resolution_days)) {
    errors.push('time_to_resolution_days must be a positive integer');
  }

  return { valid: errors.length === 0, errors };
}
