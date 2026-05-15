/**
 * Workflow Status API Lambda
 *
 * API Gateway Lambda proxy handler that returns workflow status for a given claim_id.
 * Supports two query approaches:
 *   - Primary: Direct GetItem using PK=TENANT#<tenant_id> and SK=WORKFLOW#<claim_id> (fastest)
 *   - Fallback: Query GSI1 by claim_id when tenantId is not provided (admin use)
 *
 * Requirements: 7.5
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import type { WorkflowStatus } from '@shared/models';
import { buildTenantPK, buildWorkflowSK, GSI } from '@shared/dynamodb';

// ─── Environment Variables ──────────────────────────────────────────────────

function getTableName(): string {
  return process.env.TABLE_NAME || 'DenialAppeals';
}

// ─── AWS SDK Clients ────────────────────────────────────────────────────────

let dynamoClient: DynamoDBDocumentClient | null = null;

function getDynamoClient(): DynamoDBDocumentClient {
  if (!dynamoClient) {
    const baseClient = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' });
    dynamoClient = DynamoDBDocumentClient.from(baseClient);
  }
  return dynamoClient;
}

/** Allows injecting mock clients for testing. */
export function setClients(clients: { dynamo?: DynamoDBDocumentClient }): void {
  if (clients.dynamo) dynamoClient = clients.dynamo;
}

/** Resets all clients (useful for testing cleanup). */
export function resetClients(): void {
  dynamoClient = null;
}

// ─── Response Helpers ───────────────────────────────────────────────────────

function jsonResponse(statusCode: number, body: object): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,X-Tenant-Id,Authorization',
    },
    body: JSON.stringify(body),
  };
}

// ─── Workflow Status Response ───────────────────────────────────────────────

interface WorkflowStatusResponse {
  claim_id: string;
  status: string;
  current_step: string;
  started_at: string;
  completed_at: string | null;
  step_history: Array<{
    step: string;
    status: string;
    started_at: string;
    completed_at: string;
    duration_ms: number;
    retry_count: number;
  }>;
  failure_reason: string | null;
  failed_step: string | null;
}

function toStatusResponse(workflow: WorkflowStatus): WorkflowStatusResponse {
  return {
    claim_id: workflow.claim_id,
    status: workflow.status,
    current_step: workflow.current_step,
    started_at: workflow.started_at,
    completed_at: workflow.completed_at,
    step_history: workflow.step_history,
    failure_reason: workflow.failure_reason,
    failed_step: workflow.failed_step,
  };
}

// ─── Query Functions ────────────────────────────────────────────────────────

/**
 * Primary lookup: Direct GetItem using tenant_id + claim_id.
 * This is the fastest path (< 2 second response time).
 */
async function getWorkflowByTenantAndClaim(
  tenantId: string,
  claimId: string
): Promise<WorkflowStatus | null> {
  const dynamo = getDynamoClient();

  const result = await dynamo.send(
    new GetCommand({
      TableName: getTableName(),
      Key: {
        PK: buildTenantPK(tenantId),
        SK: buildWorkflowSK(claimId),
      },
    })
  );

  return (result.Item as WorkflowStatus) || null;
}

/**
 * Fallback lookup: Query GSI1 by claim_id (for admin use when tenantId is not provided).
 * GSI1PK = claim_id, and we filter for SK beginning with WORKFLOW#.
 */
async function getWorkflowByClaimId(claimId: string): Promise<WorkflowStatus | null> {
  const dynamo = getDynamoClient();

  const result = await dynamo.send(
    new QueryCommand({
      TableName: getTableName(),
      IndexName: GSI.GSI1,
      KeyConditionExpression: 'GSI1PK = :claimId',
      ExpressionAttributeValues: {
        ':claimId': claimId,
      },
      Limit: 10,
    })
  );

  if (!result.Items || result.Items.length === 0) {
    return null;
  }

  // Filter for workflow items (SK starts with WORKFLOW#)
  const workflowItem = result.Items.find(
    (item) => typeof item.SK === 'string' && item.SK.startsWith('WORKFLOW#')
  );

  return (workflowItem as WorkflowStatus) || null;
}

// ─── Main Handler ───────────────────────────────────────────────────────────

/**
 * API Gateway Lambda proxy handler for workflow status queries.
 *
 * Path parameter: claimId (required)
 * Header or query parameter: tenantId (optional, but recommended for performance)
 *
 * Returns:
 *   200 - Workflow found with status details
 *   400 - Missing required parameters
 *   404 - No workflow found for the given claim_id
 *   500 - Internal error
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    // Extract claimId from path parameters
    const claimId = event.pathParameters?.claimId;

    if (!claimId || claimId.trim() === '') {
      return jsonResponse(400, {
        error: 'Missing required path parameter: claimId',
      });
    }

    // Extract tenantId from header or query parameter
    const tenantId =
      event.headers?.['x-tenant-id'] ||
      event.headers?.['X-Tenant-Id'] ||
      event.queryStringParameters?.tenantId;

    let workflow: WorkflowStatus | null = null;

    if (tenantId) {
      // Primary path: direct GetItem (fastest, < 2s)
      workflow = await getWorkflowByTenantAndClaim(tenantId, claimId);
    } else {
      // Fallback path: GSI1 query by claim_id (admin use)
      workflow = await getWorkflowByClaimId(claimId);
    }

    if (!workflow) {
      return jsonResponse(404, {
        error: `No workflow found for claim_id: ${claimId}`,
      });
    }

    return jsonResponse(200, toStatusResponse(workflow));
  } catch (error) {
    console.error('[STATUS-API] Internal error:', error instanceof Error ? error.message : error);

    return jsonResponse(500, {
      error: 'Internal server error',
    });
  }
}
