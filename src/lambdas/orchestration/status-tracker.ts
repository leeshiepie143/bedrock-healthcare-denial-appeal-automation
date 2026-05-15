/**
 * Workflow Status Tracker
 *
 * Manages workflow status transitions in DynamoDB for the Step Functions
 * orchestration pipeline. Called at each step transition to update the
 * WorkflowStatus record, preserve intermediate state on failure, and
 * send SNS notifications on final failure.
 *
 * Requirements: 7.3, 7.5
 */

import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import type {
  WorkflowStatus,
  WorkflowStep,
  StepStatus,
  StepHistoryEntry,
  WorkflowStatusType,
} from '@shared/models';
import { buildTenantPK, buildWorkflowSK, buildGSI3Keys } from '@shared/dynamodb';

// ─── Environment Variables ──────────────────────────────────────────────────

function getTableName(): string {
  return process.env.TABLE_NAME || 'DenialAppeals';
}

function getSnsTopicArn(): string {
  return process.env.SNS_TOPIC_ARN || '';
}

// ─── Client Management ──────────────────────────────────────────────────────

let dynamoClient: DynamoDBDocumentClient | null = null;
let snsClient: SNSClient | null = null;

function getDynamoClient(): DynamoDBDocumentClient {
  if (!dynamoClient) {
    throw new Error('DynamoDB client not initialized. Call setClients() first or provide client directly.');
  }
  return dynamoClient;
}

function getSnsClient(): SNSClient {
  if (!snsClient) {
    throw new Error('SNS client not initialized. Call setClients() first or provide client directly.');
  }
  return snsClient;
}

/** Allows injecting mock clients for testing. */
export function setClients(clients: {
  dynamo?: DynamoDBDocumentClient;
  sns?: SNSClient;
}): void {
  if (clients.dynamo) dynamoClient = clients.dynamo;
  if (clients.sns) snsClient = clients.sns;
}

/** Resets all clients (useful for testing cleanup). */
export function resetClients(): void {
  dynamoClient = null;
  snsClient = null;
}

// ─── Public Functions ───────────────────────────────────────────────────────

/**
 * Initializes a new WorkflowStatus record when a workflow execution begins.
 * Creates the record with status 'in_progress' and the first step set to 'ingestion'.
 *
 * @param dynamo - DynamoDB Document client
 * @param tenantId - Tenant identifier
 * @param claimId - Claim identifier
 * @param executionId - Step Functions execution ID
 * @returns The created WorkflowStatus record
 */
export async function initializeWorkflow(
  dynamo: DynamoDBDocumentClient,
  tenantId: string,
  claimId: string,
  executionId: string
): Promise<WorkflowStatus> {
  const now = new Date().toISOString();
  const status: WorkflowStatusType = 'in_progress';
  const currentStep: WorkflowStep = 'ingestion';

  const gsi3Keys = buildGSI3Keys(status, now);

  const workflowStatus: WorkflowStatus = {
    PK: buildTenantPK(tenantId),
    SK: buildWorkflowSK(claimId),
    claim_id: claimId,
    execution_id: executionId,
    status,
    current_step: currentStep,
    step_history: [],
    started_at: now,
    completed_at: null,
    failure_reason: null,
    failed_step: null,
    GSI3PK: gsi3Keys.GSI3PK,
    GSI3SK: gsi3Keys.GSI3SK,
  };

  await dynamo.send(
    new PutCommand({
      TableName: getTableName(),
      Item: workflowStatus,
    })
  );

  console.info(
    `[STATUS-TRACKER] Initialized workflow: claim_id=${claimId}, execution_id=${executionId}`
  );

  return workflowStatus;
}

/**
 * Updates the workflow status when a step completes or fails.
 * Adds the step to step_history and updates current_step.
 *
 * @param dynamo - DynamoDB Document client
 * @param tenantId - Tenant identifier
 * @param claimId - Claim identifier
 * @param step - The step that completed
 * @param stepStatus - Whether the step completed or failed
 * @param durationMs - Duration of the step in milliseconds
 * @returns The step history entry that was added
 */
export async function updateStepStatus(
  dynamo: DynamoDBDocumentClient,
  tenantId: string,
  claimId: string,
  step: WorkflowStep,
  stepStatus: StepStatus,
  durationMs: number
): Promise<StepHistoryEntry> {
  const now = new Date().toISOString();
  const startedAt = new Date(Date.now() - durationMs).toISOString();

  const stepEntry: StepHistoryEntry = {
    step,
    status: stepStatus,
    started_at: startedAt,
    completed_at: now,
    duration_ms: durationMs,
    retry_count: 0,
  };

  await dynamo.send(
    new UpdateCommand({
      TableName: getTableName(),
      Key: {
        PK: buildTenantPK(tenantId),
        SK: buildWorkflowSK(claimId),
      },
      UpdateExpression:
        'SET current_step = :step, step_history = list_append(if_not_exists(step_history, :emptyList), :entry)',
      ExpressionAttributeValues: {
        ':step': step,
        ':entry': [stepEntry],
        ':emptyList': [],
      },
    })
  );

  console.info(
    `[STATUS-TRACKER] Step updated: claim_id=${claimId}, step=${step}, status=${stepStatus}, duration_ms=${durationMs}`
  );

  return stepEntry;
}

/**
 * Marks a workflow as completed successfully.
 * Sets status to 'completed' and records the completion timestamp.
 *
 * @param dynamo - DynamoDB Document client
 * @param tenantId - Tenant identifier
 * @param claimId - Claim identifier
 */
export async function markWorkflowCompleted(
  dynamo: DynamoDBDocumentClient,
  tenantId: string,
  claimId: string
): Promise<void> {
  const now = new Date().toISOString();
  const completedStatus: WorkflowStatusType = 'completed';
  const gsi3Keys = buildGSI3Keys(completedStatus, now);

  await dynamo.send(
    new UpdateCommand({
      TableName: getTableName(),
      Key: {
        PK: buildTenantPK(tenantId),
        SK: buildWorkflowSK(claimId),
      },
      UpdateExpression:
        'SET #status = :status, completed_at = :completedAt, GSI3PK = :gsi3pk, GSI3SK = :gsi3sk',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':status': completedStatus,
        ':completedAt': now,
        ':gsi3pk': gsi3Keys.GSI3PK,
        ':gsi3sk': gsi3Keys.GSI3SK,
      },
    })
  );

  console.info(
    `[STATUS-TRACKER] Workflow completed: claim_id=${claimId}, completed_at=${now}`
  );
}

/**
 * Marks a workflow as failed after all retries are exhausted.
 * Records the failure reason and failed step, preserves intermediate state,
 * and sends an SNS notification within 60 seconds.
 *
 * @param dynamo - DynamoDB Document client
 * @param tenantId - Tenant identifier
 * @param claimId - Claim identifier
 * @param failedStep - The step that failed
 * @param failureReason - Description of why the step failed
 */
export async function markWorkflowFailed(
  dynamo: DynamoDBDocumentClient,
  tenantId: string,
  claimId: string,
  failedStep: string,
  failureReason: string
): Promise<void> {
  const now = new Date().toISOString();
  const failedStatus: WorkflowStatusType = 'failed';
  const gsi3Keys = buildGSI3Keys(failedStatus, now);

  // Update DynamoDB with failure details — preserves all intermediate state
  // (step_history, previous step results) by only updating failure-related fields
  await dynamo.send(
    new UpdateCommand({
      TableName: getTableName(),
      Key: {
        PK: buildTenantPK(tenantId),
        SK: buildWorkflowSK(claimId),
      },
      UpdateExpression:
        'SET #status = :status, failure_reason = :failureReason, failed_step = :failedStep, ' +
        'completed_at = :completedAt, GSI3PK = :gsi3pk, GSI3SK = :gsi3sk',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':status': failedStatus,
        ':failureReason': failureReason,
        ':failedStep': failedStep,
        ':completedAt': now,
        ':gsi3pk': gsi3Keys.GSI3PK,
        ':gsi3sk': gsi3Keys.GSI3SK,
      },
    })
  );

  console.info(
    `[STATUS-TRACKER] Workflow failed: claim_id=${claimId}, failed_step=${failedStep}, reason=${failureReason}`
  );

  // Send SNS notification for the failure (must be within 60 seconds of final failure)
  await sendFailureNotification(tenantId, claimId, failedStep, failureReason);
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

/**
 * Sends an SNS notification about a workflow failure.
 * This must complete within 60 seconds of the final failure per requirement 7.3.
 */
async function sendFailureNotification(
  tenantId: string,
  claimId: string,
  failedStep: string,
  failureReason: string
): Promise<void> {
  const topicArn = getSnsTopicArn();
  if (!topicArn) {
    console.warn('[STATUS-TRACKER] SNS_TOPIC_ARN not configured, skipping failure notification');
    return;
  }

  // Use the module-level SNS client or fall back to the getter
  const sns = snsClient || getSnsClient();

  const message = JSON.stringify({
    event: 'workflow_failed',
    tenant_id: tenantId,
    claim_id: claimId,
    failed_step: failedStep,
    failure_reason: failureReason,
    timestamp: new Date().toISOString(),
  });

  const subject = `Denial Appeal Workflow Failed: ${claimId}`;

  await sns.send(
    new PublishCommand({
      TopicArn: topicArn,
      Message: message,
      Subject: subject.substring(0, 100), // SNS subject max 100 chars
      MessageAttributes: {
        tenant_id: {
          DataType: 'String',
          StringValue: tenantId,
        },
        event_type: {
          DataType: 'String',
          StringValue: 'workflow_failed',
        },
      },
    })
  );

  console.info(
    `[STATUS-TRACKER] Failure notification sent: claim_id=${claimId}, topic=${topicArn}`
  );
}
