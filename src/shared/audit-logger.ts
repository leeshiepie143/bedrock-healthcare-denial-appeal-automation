/**
 * Audit Logger — Immutable PHI access logging middleware.
 *
 * Logs all PHI access events to the AuditLog DynamoDB table.
 * The table is append-only: no updates or deletes are performed.
 *
 * Key schema:
 *   PK: AUDIT#<tenant_id>#<date>
 *   SK: <timestamp>#<request_id>
 *
 * Requirements: 9.3, 9.5
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { AuditLogEntry } from './models';
import { buildAuditPK, buildAuditSK, TABLE_AUDIT_LOG } from './dynamodb';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Parameters for logging a PHI access event. */
export interface LogAccessParams {
  /** Identity of the user or service accessing PHI */
  accessor_identity: string;
  /** Resource being accessed (e.g., "DenialRecord:claim-123") */
  resource_accessed: string;
  /** Action performed (e.g., "read", "write", "delete") */
  action: string;
  /** Whether the access was permitted */
  permitted: boolean;
  /** Tenant ID for partition scoping */
  tenant_id: string;
  /** Unique request identifier */
  request_id: string;
  /** Source IP address of the request */
  source_ip: string;
}

/** Result of an audit log write attempt. */
export interface LogAccessResult {
  success: boolean;
  entry?: AuditLogEntry;
  error?: string;
}

// ─── DynamoDB Client ────────────────────────────────────────────────────────

let dynamoClient: DynamoDBDocumentClient | null = null;

function getDynamoClient(): DynamoDBDocumentClient {
  if (!dynamoClient) {
    const baseClient = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' });
    dynamoClient = DynamoDBDocumentClient.from(baseClient);
  }
  return dynamoClient;
}

/** Allows injecting a mock DynamoDB client for testing. */
export function setAuditDynamoClient(client: DynamoDBDocumentClient): void {
  dynamoClient = client;
}

/** Resets the DynamoDB client (useful for testing cleanup). */
export function resetAuditDynamoClient(): void {
  dynamoClient = null;
}

// ─── Table Name ─────────────────────────────────────────────────────────────

function getAuditTableName(): string {
  return process.env.AUDIT_TABLE_NAME || TABLE_AUDIT_LOG;
}

// ─── Core Logging Function ──────────────────────────────────────────────────

/**
 * Logs a PHI access event to the AuditLog DynamoDB table.
 *
 * This function is fire-and-forget: it does not throw on failure.
 * Errors are logged to console and returned in the result object.
 * The handler should not block on audit log writes.
 */
export async function logAccess(params: LogAccessParams): Promise<LogAccessResult> {
  const timestamp = new Date().toISOString(); // ISO 8601 with ms precision in UTC
  const date = timestamp.slice(0, 10); // YYYY-MM-DD

  const entry: AuditLogEntry = {
    PK: buildAuditPK(params.tenant_id, date),
    SK: buildAuditSK(timestamp, params.request_id),
    accessor_identity: params.accessor_identity,
    timestamp,
    resource_accessed: params.resource_accessed,
    action: params.action,
    permitted: params.permitted,
    tenant_id: params.tenant_id,
    request_id: params.request_id,
    source_ip: params.source_ip,
  };

  try {
    const client = getDynamoClient();
    await client.send(
      new PutCommand({
        TableName: getAuditTableName(),
        Item: entry,
        // Append-only: never overwrite an existing entry
        ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
      })
    );

    return { success: true, entry };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[AUDIT_LOG] Failed to write audit entry:', errorMessage);
    return { success: false, error: errorMessage };
  }
}

// ─── Middleware Factory ─────────────────────────────────────────────────────

/** Function signature for the audit middleware logging function. */
export type AuditLogFn = (
  resource_accessed: string,
  action: string,
  permitted: boolean
) => void;

/**
 * Creates an audit middleware function scoped to a specific tenant and accessor.
 *
 * The returned function is fire-and-forget: it initiates the DynamoDB write
 * but does not await it, so it never blocks the Lambda handler.
 *
 * Usage in a Lambda handler:
 * ```ts
 * const auditLog = createAuditMiddleware(tenantId, userId, requestId, sourceIp);
 * auditLog('DenialRecord:claim-123', 'read', true);
 * ```
 */
export function createAuditMiddleware(
  tenantId: string,
  accessorIdentity: string,
  requestId?: string,
  sourceIp?: string
): AuditLogFn {
  const resolvedRequestId = requestId || generateRequestId();
  const resolvedSourceIp = sourceIp || 'unknown';

  return (resource_accessed: string, action: string, permitted: boolean): void => {
    // Fire-and-forget: intentionally not awaiting
    void logAccess({
      accessor_identity: accessorIdentity,
      resource_accessed,
      action,
      permitted,
      tenant_id: tenantId,
      request_id: resolvedRequestId,
      source_ip: resolvedSourceIp,
    });
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Generates a simple unique request ID when one is not provided.
 */
function generateRequestId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `${timestamp}-${random}`;
}
