/**
 * DynamoDB single-table design constants and helpers.
 * Defines table names, key patterns, and GSI configurations.
 */

// ─── Table Names ────────────────────────────────────────────────────────────

export const TABLE_DENIAL_APPEALS = 'DenialAppeals';
export const TABLE_AUDIT_LOG = 'AuditLog';

// ─── Key Prefixes ───────────────────────────────────────────────────────────

export const KEY_PREFIX = {
  TENANT: 'TENANT#',
  DENIAL: 'DENIAL#',
  CLASSIFICATION: 'CLASSIFICATION#',
  EVIDENCE: 'EVIDENCE#',
  VIABILITY: 'VIABILITY#',
  LETTER: 'LETTER#',
  OUTCOME: 'OUTCOME#',
  WORKFLOW: 'WORKFLOW#',
  CONFIG: 'CONFIG',
  AUDIT: 'AUDIT#',
} as const;

// ─── GSI Names ──────────────────────────────────────────────────────────────

export const GSI = {
  /** GSI1: Claim ID lookup (cross-tenant by admins) */
  GSI1: 'GSI1-ClaimId-Index',
  /** GSI2: Payer + denial reason outcome analytics */
  GSI2: 'GSI2-PayerReason-Index',
  /** GSI3: Workflow status monitoring */
  GSI3: 'GSI3-WorkflowStatus-Index',
} as const;

// ─── GSI Key Definitions ────────────────────────────────────────────────────

export interface GSI1Keys {
  GSI1PK: string; // claim_id
  GSI1SK: string; // tenant_id
}

export interface GSI2Keys {
  GSI2PK: string; // ${payer_id}#${denial_reason_code}
  GSI2SK: string; // outcome_type
}

export interface GSI3Keys {
  GSI3PK: string; // status
  GSI3SK: string; // started_at (ISO 8601)
}

// ─── Key Builders ───────────────────────────────────────────────────────────

/**
 * Builds the partition key for tenant-scoped items.
 * Format: TENANT#<tenant_id>
 */
export function buildTenantPK(tenantId: string): string {
  return `${KEY_PREFIX.TENANT}${tenantId}`;
}

/**
 * Builds the sort key for a denial record.
 * Format: DENIAL#<claim_id>#<source_format>
 */
export function buildDenialSK(claimId: string, sourceFormat: string): string {
  return `${KEY_PREFIX.DENIAL}${claimId}#${sourceFormat}`;
}

/**
 * Builds the sort key for a classification record.
 * Format: CLASSIFICATION#<claim_id>
 */
export function buildClassificationSK(claimId: string): string {
  return `${KEY_PREFIX.CLASSIFICATION}${claimId}`;
}

/**
 * Builds the sort key for an evidence package.
 * Format: EVIDENCE#<claim_id>
 */
export function buildEvidenceSK(claimId: string): string {
  return `${KEY_PREFIX.EVIDENCE}${claimId}`;
}

/**
 * Builds the sort key for a viability assessment.
 * Format: VIABILITY#<claim_id>
 */
export function buildViabilitySK(claimId: string): string {
  return `${KEY_PREFIX.VIABILITY}${claimId}`;
}

/**
 * Builds the sort key for an appeal letter.
 * Format: LETTER#<claim_id>#<version>
 */
export function buildLetterSK(claimId: string, version: number): string {
  return `${KEY_PREFIX.LETTER}${claimId}#${version}`;
}

/**
 * Builds the sort key for an appeal outcome.
 * Format: OUTCOME#<claim_id>
 */
export function buildOutcomeSK(claimId: string): string {
  return `${KEY_PREFIX.OUTCOME}${claimId}`;
}

/**
 * Builds the sort key for a workflow status record.
 * Format: WORKFLOW#<claim_id>
 */
export function buildWorkflowSK(claimId: string): string {
  return `${KEY_PREFIX.WORKFLOW}${claimId}`;
}

/**
 * Builds the partition key for an audit log entry.
 * Format: AUDIT#<tenant_id>#<date>
 */
export function buildAuditPK(tenantId: string, date: string): string {
  return `${KEY_PREFIX.AUDIT}${tenantId}#${date}`;
}

/**
 * Builds the sort key for an audit log entry.
 * Format: <timestamp>#<request_id>
 */
export function buildAuditSK(timestamp: string, requestId: string): string {
  return `${timestamp}#${requestId}`;
}

// ─── GSI Key Builders ───────────────────────────────────────────────────────

/**
 * Builds GSI1 keys for claim ID lookup.
 * GSI1PK: claim_id, GSI1SK: tenant_id
 */
export function buildGSI1Keys(claimId: string, tenantId: string): GSI1Keys {
  return {
    GSI1PK: claimId,
    GSI1SK: tenantId,
  };
}

/**
 * Builds GSI2 keys for payer + denial reason outcome analytics.
 * GSI2PK: ${payer_id}#${denial_reason_code}, GSI2SK: outcome_type
 */
export function buildGSI2Keys(payerId: string, denialReasonCode: string, outcomeType: string): GSI2Keys {
  return {
    GSI2PK: `${payerId}#${denialReasonCode}`,
    GSI2SK: outcomeType,
  };
}

/**
 * Builds GSI3 keys for workflow status monitoring.
 * GSI3PK: status, GSI3SK: started_at
 */
export function buildGSI3Keys(status: string, startedAt: string): GSI3Keys {
  return {
    GSI3PK: status,
    GSI3SK: startedAt,
  };
}

// ─── Table Schema Definition (for CDK/CloudFormation reference) ─────────────

export const TABLE_SCHEMA = {
  [TABLE_DENIAL_APPEALS]: {
    partitionKey: { name: 'PK', type: 'S' },
    sortKey: { name: 'SK', type: 'S' },
    globalSecondaryIndexes: [
      {
        indexName: GSI.GSI1,
        partitionKey: { name: 'GSI1PK', type: 'S' },
        sortKey: { name: 'GSI1SK', type: 'S' },
        projectionType: 'ALL',
      },
      {
        indexName: GSI.GSI2,
        partitionKey: { name: 'GSI2PK', type: 'S' },
        sortKey: { name: 'GSI2SK', type: 'S' },
        projectionType: 'ALL',
      },
      {
        indexName: GSI.GSI3,
        partitionKey: { name: 'GSI3PK', type: 'S' },
        sortKey: { name: 'GSI3SK', type: 'S' },
        projectionType: 'ALL',
      },
    ],
    timeToLiveAttribute: 'ttl',
  },
  [TABLE_AUDIT_LOG]: {
    partitionKey: { name: 'PK', type: 'S' },
    sortKey: { name: 'SK', type: 'S' },
    globalSecondaryIndexes: [],
    timeToLiveAttribute: undefined,
  },
} as const;
