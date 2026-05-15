/**
 * Citation Grounding and Regulatory Reference Lookup
 *
 * Validates generated appeal letters for:
 * 1. Citation grounding — ensures all FHIR resource IDs exist in the Evidence_Package
 * 2. Cross-patient data detection — ensures no patient IDs from unrelated records appear
 * 3. Regulatory reference lookup — queries DynamoDB for matching LCD/NCD, state mandates, ERISA references
 * 4. Post-generation validation — strips hallucinated citations and logs interventions
 *
 * Requirements: 5.5, 5.6, 5.8
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { EvidencePackage, RegulatoryCitation, RegulatoryCitationType } from '@shared/models';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CitationValidationResult {
  /** FHIR resource IDs that are valid (exist in Evidence_Package) */
  validCitations: string[];
  /** FHIR resource IDs that were removed (not found in Evidence_Package) */
  removedCitations: string[];
  /** Whether any citations were stripped from the letter */
  hadStrippedCitations: boolean;
  /** Patient IDs found that don't belong to this denial record */
  crossPatientIds: string[];
}

export interface GuardrailIntervention {
  timestamp: string;
  type: 'hallucinated_citation' | 'cross_patient_data';
  detail: string;
  resourceId: string;
}

export interface RegulatoryReferenceRecord {
  PK: string;
  SK: string;
  reference_id: string;
  type: RegulatoryCitationType;
  section: string;
  description: string;
  applicable_carc_codes: string[];
  payer_types: string[];
}

// ─── FHIR Resource ID Patterns ──────────────────────────────────────────────

/**
 * Regex patterns for FHIR resource IDs used in the system.
 * Matches patterns like: fhir-xxx, cond-xxx, proc-xxx, enc-xxx, dr-xxx, doc-xxx
 */
const FHIR_RESOURCE_ID_PATTERN = /\b(fhir-[a-zA-Z0-9_-]+|cond-[a-zA-Z0-9_-]+|proc-[a-zA-Z0-9_-]+|enc-[a-zA-Z0-9_-]+|dr-[a-zA-Z0-9_-]+|doc-[a-zA-Z0-9_-]+)\b/g;

/**
 * Regex pattern for patient IDs in the letter body.
 * Matches patterns like: patient-xxx, pat-xxx
 */
const PATIENT_ID_PATTERN = /\b(patient-[a-zA-Z0-9_-]+|pat-[a-zA-Z0-9_-]+)\b/g;

// ─── Citation Validation ────────────────────────────────────────────────────

/**
 * Parses all FHIR resource IDs mentioned in the letter body.
 */
export function parseFhirResourceIds(letterBody: string): string[] {
  const matches = letterBody.match(FHIR_RESOURCE_ID_PATTERN);
  if (!matches) {
    return [];
  }
  // Deduplicate
  return [...new Set(matches)];
}

/**
 * Parses all patient IDs mentioned in the letter body.
 */
export function parsePatientIds(letterBody: string): string[] {
  const matches = letterBody.match(PATIENT_ID_PATTERN);
  if (!matches) {
    return [];
  }
  return [...new Set(matches)];
}

/**
 * Validates all FHIR resource IDs cited in the generated letter against the Evidence_Package.
 * Returns a validation result indicating which citations are valid and which were hallucinated.
 *
 * @param letterBody - The generated appeal letter text
 * @param evidencePackage - The Evidence_Package containing valid evidence items
 * @returns CitationValidationResult with valid/removed citations and cross-patient detection
 */
export function validateCitations(
  letterBody: string,
  evidencePackage: EvidencePackage
): CitationValidationResult {
  // Build set of valid FHIR resource IDs from Evidence_Package
  const validResourceIds = new Set(
    evidencePackage.evidence_items.map(item => item.fhir_resource_id)
  );

  // Parse all FHIR resource IDs from the letter
  const citedIds = parseFhirResourceIds(letterBody);

  const validCitations: string[] = [];
  const removedCitations: string[] = [];

  for (const id of citedIds) {
    if (validResourceIds.has(id)) {
      validCitations.push(id);
    } else {
      removedCitations.push(id);
    }
  }

  // Detect cross-patient data
  const citedPatientIds = parsePatientIds(letterBody);
  const expectedPatientId = evidencePackage.patient_id;
  const crossPatientIds = citedPatientIds.filter(id => id !== expectedPatientId);

  return {
    validCitations,
    removedCitations,
    hadStrippedCitations: removedCitations.length > 0 || crossPatientIds.length > 0,
    crossPatientIds,
  };
}

// ─── Regulatory Reference Lookup ────────────────────────────────────────────

/**
 * Queries DynamoDB for regulatory references matching the denial reason codes and payer type.
 *
 * DynamoDB table schema for regulatory references:
 * - PK: "REG_REF"
 * - SK: "<type>#<code>" (e.g., "lcd#LCD-12345", "ncd#NCD-100", "state_mandate#CA-001", "erisa#502a")
 * - Each record contains: reference_id, section, description, applicable_carc_codes[], payer_types[]
 *
 * @param dynamoClient - DynamoDB Document Client
 * @param denialReasonCodes - Array of CARC codes from the denial
 * @param payerType - The payer type (e.g., "medicare", "medicaid", "commercial")
 * @param tableName - DynamoDB table name
 * @returns Array of matching RegulatoryCitation objects
 */
export async function lookupRegulatoryReferences(
  dynamoClient: DynamoDBDocumentClient,
  denialReasonCodes: string[],
  payerType: string,
  tableName: string
): Promise<RegulatoryCitation[]> {
  if (denialReasonCodes.length === 0) {
    return [];
  }

  // Query all regulatory references with PK = REG_REF
  const command = new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: {
      ':pk': 'REG_REF',
    },
  });

  const response = await dynamoClient.send(command);
  const items = (response.Items ?? []) as RegulatoryReferenceRecord[];

  // Filter by matching CARC codes and payer type
  const matchingReferences: RegulatoryCitation[] = [];

  for (const item of items) {
    const matchesCarcCode = item.applicable_carc_codes.some(
      code => denialReasonCodes.includes(code)
    );
    const matchesPayerType = item.payer_types.includes(payerType);

    if (matchesCarcCode && matchesPayerType) {
      matchingReferences.push({
        type: item.type,
        reference_id: item.reference_id,
        section: item.section,
        description: item.description,
      });
    }
  }

  return matchingReferences;
}

// ─── Post-Generation Validation (Strip Hallucinated Content) ────────────────

/**
 * Strips hallucinated citations and cross-patient data from the letter body.
 * Replaces invalid references with "[citation removed]" marker.
 * Logs all guardrail interventions.
 *
 * @param letterBody - The generated appeal letter text
 * @param validationResult - The result from validateCitations()
 * @param patientId - The expected patient ID for this denial record
 * @returns Object with cleaned letter body and logged interventions
 */
export function stripHallucinatedContent(
  letterBody: string,
  validationResult: CitationValidationResult,
  patientId: string
): { cleanedBody: string; interventions: GuardrailIntervention[] } {
  const interventions: GuardrailIntervention[] = [];
  let cleanedBody = letterBody;
  const timestamp = new Date().toISOString();

  // Strip hallucinated FHIR resource IDs
  for (const removedId of validationResult.removedCitations) {
    const escapedId = escapeRegExp(removedId);
    const pattern = new RegExp(escapedId, 'g');
    cleanedBody = cleanedBody.replace(pattern, '[citation removed]');

    interventions.push({
      timestamp,
      type: 'hallucinated_citation',
      detail: `FHIR resource ID "${removedId}" not found in Evidence_Package`,
      resourceId: removedId,
    });
  }

  // Strip cross-patient data
  for (const crossPatientId of validationResult.crossPatientIds) {
    const escapedId = escapeRegExp(crossPatientId);
    const pattern = new RegExp(escapedId, 'g');
    cleanedBody = cleanedBody.replace(pattern, '[citation removed]');

    interventions.push({
      timestamp,
      type: 'cross_patient_data',
      detail: `Patient ID "${crossPatientId}" does not match expected patient "${patientId}"`,
      resourceId: crossPatientId,
    });
  }

  return { cleanedBody, interventions };
}

// ─── Utility ────────────────────────────────────────────────────────────────

/**
 * Escapes special regex characters in a string for use in RegExp constructor.
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
