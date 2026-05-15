/**
 * Unit tests for Workflow Status Tracker
 *
 * Tests workflow initialization, step status updates, completion marking,
 * failure handling with SNS notifications, and intermediate state preservation.
 *
 * Requirements: 7.3, 7.5
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  initializeWorkflow,
  updateStepStatus,
  markWorkflowCompleted,
  markWorkflowFailed,
  setClients,
  resetClients,
} from '@lambdas/orchestration/status-tracker';

// ─── Mock Helpers ───────────────────────────────────────────────────────────

function createMockDynamoClient() {
  return {
    send: vi.fn().mockResolvedValue({}),
  };
}

function createMockSNSClient() {
  return {
    send: vi.fn().mockResolvedValue({ MessageId: 'test-message-id' }),
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('initializeWorkflow', () => {
  let mockDynamo: ReturnType<typeof createMockDynamoClient>;

  beforeEach(() => {
    process.env.TABLE_NAME = 'TestTable';
    process.env.SNS_TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789:test-topic';
    mockDynamo = createMockDynamoClient();
  });

  afterEach(() => {
    resetClients();
    delete process.env.TABLE_NAME;
    delete process.env.SNS_TOPIC_ARN;
  });

  it('creates a WorkflowStatus record with status in_progress', async () => {
    const result = await initializeWorkflow(
      mockDynamo as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient,
      'tenant-1',
      'CLM-001',
      'exec-abc-123'
    );

    expect(result.status).toBe('in_progress');
    expect(result.claim_id).toBe('CLM-001');
    expect(result.execution_id).toBe('exec-abc-123');
    expect(result.current_step).toBe('ingestion');
    expect(result.step_history).toEqual([]);
    expect(result.completed_at).toBeNull();
    expect(result.failure_reason).toBeNull();
    expect(result.failed_step).toBeNull();
  });

  it('sets correct PK and SK using key builders', async () => {
    const result = await initializeWorkflow(
      mockDynamo as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient,
      'tenant-1',
      'CLM-001',
      'exec-abc-123'
    );

    expect(result.PK).toBe('TENANT#tenant-1');
    expect(result.SK).toBe('WORKFLOW#CLM-001');
  });

  it('sets GSI3 keys for status monitoring', async () => {
    const result = await initializeWorkflow(
      mockDynamo as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient,
      'tenant-1',
      'CLM-001',
      'exec-abc-123'
    );

    expect(result.GSI3PK).toBe('in_progress');
    expect(result.GSI3SK).toBeDefined();
    // GSI3SK should be a valid ISO 8601 timestamp
    expect(new Date(result.GSI3SK!).toISOString()).toBe(result.GSI3SK);
  });

  it('stores the record in DynamoDB with PutCommand', async () => {
    await initializeWorkflow(
      mockDynamo as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient,
      'tenant-1',
      'CLM-001',
      'exec-abc-123'
    );

    expect(mockDynamo.send).toHaveBeenCalledTimes(1);
    const call = mockDynamo.send.mock.calls[0][0];
    expect(call.constructor.name).toBe('PutCommand');
    expect(call.input.TableName).toBe('TestTable');
    expect(call.input.Item.PK).toBe('TENANT#tenant-1');
    expect(call.input.Item.SK).toBe('WORKFLOW#CLM-001');
  });

  it('sets started_at to a valid ISO 8601 timestamp', async () => {
    const before = new Date().toISOString();
    const result = await initializeWorkflow(
      mockDynamo as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient,
      'tenant-1',
      'CLM-001',
      'exec-abc-123'
    );
    const after = new Date().toISOString();

    expect(result.started_at >= before).toBe(true);
    expect(result.started_at <= after).toBe(true);
  });
});

describe('updateStepStatus', () => {
  let mockDynamo: ReturnType<typeof createMockDynamoClient>;

  beforeEach(() => {
    process.env.TABLE_NAME = 'TestTable';
    mockDynamo = createMockDynamoClient();
  });

  afterEach(() => {
    resetClients();
    delete process.env.TABLE_NAME;
  });

  it('creates a step history entry with correct fields', async () => {
    const entry = await updateStepStatus(
      mockDynamo as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient,
      'tenant-1',
      'CLM-001',
      'classification',
      'completed',
      1500
    );

    expect(entry.step).toBe('classification');
    expect(entry.status).toBe('completed');
    expect(entry.duration_ms).toBe(1500);
    expect(entry.retry_count).toBe(0);
    expect(entry.started_at).toBeDefined();
    expect(entry.completed_at).toBeDefined();
  });

  it('sends UpdateCommand to DynamoDB with correct key', async () => {
    await updateStepStatus(
      mockDynamo as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient,
      'tenant-1',
      'CLM-001',
      'evidence_retrieval',
      'completed',
      3000
    );

    expect(mockDynamo.send).toHaveBeenCalledTimes(1);
    const call = mockDynamo.send.mock.calls[0][0];
    expect(call.constructor.name).toBe('UpdateCommand');
    expect(call.input.Key.PK).toBe('TENANT#tenant-1');
    expect(call.input.Key.SK).toBe('WORKFLOW#CLM-001');
  });

  it('appends step entry to step_history list', async () => {
    await updateStepStatus(
      mockDynamo as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient,
      'tenant-1',
      'CLM-001',
      'ingestion',
      'completed',
      2000
    );

    const call = mockDynamo.send.mock.calls[0][0];
    expect(call.input.UpdateExpression).toContain('list_append');
    expect(call.input.ExpressionAttributeValues[':entry']).toHaveLength(1);
    expect(call.input.ExpressionAttributeValues[':entry'][0].step).toBe('ingestion');
  });

  it('updates current_step to the provided step', async () => {
    await updateStepStatus(
      mockDynamo as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient,
      'tenant-1',
      'CLM-001',
      'viability_assessment',
      'completed',
      5000
    );

    const call = mockDynamo.send.mock.calls[0][0];
    expect(call.input.ExpressionAttributeValues[':step']).toBe('viability_assessment');
  });

  it('handles failed step status', async () => {
    const entry = await updateStepStatus(
      mockDynamo as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient,
      'tenant-1',
      'CLM-001',
      'letter_generation',
      'failed',
      500
    );

    expect(entry.status).toBe('failed');
    expect(entry.step).toBe('letter_generation');
  });

  it('calculates started_at based on duration_ms offset from completed_at', async () => {
    const entry = await updateStepStatus(
      mockDynamo as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient,
      'tenant-1',
      'CLM-001',
      'classification',
      'completed',
      2000
    );

    const startedAt = new Date(entry.started_at).getTime();
    const completedAt = new Date(entry.completed_at).getTime();
    const diff = completedAt - startedAt;

    // Allow small timing variance (within 100ms)
    expect(Math.abs(diff - 2000)).toBeLessThan(100);
  });
});

describe('markWorkflowCompleted', () => {
  let mockDynamo: ReturnType<typeof createMockDynamoClient>;

  beforeEach(() => {
    process.env.TABLE_NAME = 'TestTable';
    mockDynamo = createMockDynamoClient();
  });

  afterEach(() => {
    resetClients();
    delete process.env.TABLE_NAME;
  });

  it('sends UpdateCommand with status completed', async () => {
    await markWorkflowCompleted(
      mockDynamo as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient,
      'tenant-1',
      'CLM-001'
    );

    expect(mockDynamo.send).toHaveBeenCalledTimes(1);
    const call = mockDynamo.send.mock.calls[0][0];
    expect(call.constructor.name).toBe('UpdateCommand');
    expect(call.input.ExpressionAttributeValues[':status']).toBe('completed');
  });

  it('sets completed_at to a valid ISO 8601 timestamp', async () => {
    const before = new Date().toISOString();

    await markWorkflowCompleted(
      mockDynamo as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient,
      'tenant-1',
      'CLM-001'
    );

    const after = new Date().toISOString();
    const call = mockDynamo.send.mock.calls[0][0];
    const completedAt = call.input.ExpressionAttributeValues[':completedAt'];

    expect(completedAt >= before).toBe(true);
    expect(completedAt <= after).toBe(true);
  });

  it('updates GSI3 keys to reflect completed status', async () => {
    await markWorkflowCompleted(
      mockDynamo as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient,
      'tenant-1',
      'CLM-001'
    );

    const call = mockDynamo.send.mock.calls[0][0];
    expect(call.input.ExpressionAttributeValues[':gsi3pk']).toBe('completed');
    expect(call.input.ExpressionAttributeValues[':gsi3sk']).toBeDefined();
  });

  it('uses correct DynamoDB key for the workflow record', async () => {
    await markWorkflowCompleted(
      mockDynamo as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient,
      'tenant-abc',
      'CLM-999'
    );

    const call = mockDynamo.send.mock.calls[0][0];
    expect(call.input.Key.PK).toBe('TENANT#tenant-abc');
    expect(call.input.Key.SK).toBe('WORKFLOW#CLM-999');
  });
});

describe('markWorkflowFailed', () => {
  let mockDynamo: ReturnType<typeof createMockDynamoClient>;
  let mockSNS: ReturnType<typeof createMockSNSClient>;

  beforeEach(() => {
    process.env.TABLE_NAME = 'TestTable';
    process.env.SNS_TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789:test-topic';
    mockDynamo = createMockDynamoClient();
    mockSNS = createMockSNSClient();

    setClients({
      dynamo: mockDynamo as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient,
      sns: mockSNS as unknown as import('@aws-sdk/client-sns').SNSClient,
    });
  });

  afterEach(() => {
    resetClients();
    delete process.env.TABLE_NAME;
    delete process.env.SNS_TOPIC_ARN;
  });

  it('updates DynamoDB with failed status', async () => {
    await markWorkflowFailed(
      mockDynamo as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient,
      'tenant-1',
      'CLM-001',
      'evidence_retrieval',
      'HealthLake timeout after 120 seconds'
    );

    const call = mockDynamo.send.mock.calls[0][0];
    expect(call.constructor.name).toBe('UpdateCommand');
    expect(call.input.ExpressionAttributeValues[':status']).toBe('failed');
  });

  it('records the failure reason', async () => {
    await markWorkflowFailed(
      mockDynamo as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient,
      'tenant-1',
      'CLM-001',
      'classification',
      'Bedrock invocation error: model throttled'
    );

    const call = mockDynamo.send.mock.calls[0][0];
    expect(call.input.ExpressionAttributeValues[':failureReason']).toBe(
      'Bedrock invocation error: model throttled'
    );
  });

  it('records the failed step name', async () => {
    await markWorkflowFailed(
      mockDynamo as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient,
      'tenant-1',
      'CLM-001',
      'viability_assessment',
      'Scoring model not found in S3'
    );

    const call = mockDynamo.send.mock.calls[0][0];
    expect(call.input.ExpressionAttributeValues[':failedStep']).toBe('viability_assessment');
  });

  it('sends SNS notification with failure details', async () => {
    await markWorkflowFailed(
      mockDynamo as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient,
      'tenant-1',
      'CLM-001',
      'ingestion',
      'Textract service unavailable'
    );

    expect(mockSNS.send).toHaveBeenCalledTimes(1);
    const snsCall = mockSNS.send.mock.calls[0][0];
    expect(snsCall.constructor.name).toBe('PublishCommand');

    const message = JSON.parse(snsCall.input.Message);
    expect(message.event).toBe('workflow_failed');
    expect(message.tenant_id).toBe('tenant-1');
    expect(message.claim_id).toBe('CLM-001');
    expect(message.failed_step).toBe('ingestion');
    expect(message.failure_reason).toBe('Textract service unavailable');
    expect(message.timestamp).toBeDefined();
  });

  it('includes tenant_id in SNS message attributes for filtering', async () => {
    await markWorkflowFailed(
      mockDynamo as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient,
      'tenant-abc',
      'CLM-001',
      'classification',
      'Error'
    );

    const snsCall = mockSNS.send.mock.calls[0][0];
    expect(snsCall.input.MessageAttributes.tenant_id.StringValue).toBe('tenant-abc');
    expect(snsCall.input.MessageAttributes.event_type.StringValue).toBe('workflow_failed');
  });

  it('sets SNS subject with claim ID (truncated to 100 chars)', async () => {
    await markWorkflowFailed(
      mockDynamo as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient,
      'tenant-1',
      'CLM-001',
      'ingestion',
      'Error'
    );

    const snsCall = mockSNS.send.mock.calls[0][0];
    expect(snsCall.input.Subject).toContain('CLM-001');
    expect(snsCall.input.Subject.length).toBeLessThanOrEqual(100);
  });

  it('publishes to the configured SNS topic ARN', async () => {
    await markWorkflowFailed(
      mockDynamo as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient,
      'tenant-1',
      'CLM-001',
      'ingestion',
      'Error'
    );

    const snsCall = mockSNS.send.mock.calls[0][0];
    expect(snsCall.input.TopicArn).toBe('arn:aws:sns:us-east-1:123456789:test-topic');
  });

  it('updates GSI3 keys to reflect failed status', async () => {
    await markWorkflowFailed(
      mockDynamo as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient,
      'tenant-1',
      'CLM-001',
      'ingestion',
      'Error'
    );

    const call = mockDynamo.send.mock.calls[0][0];
    expect(call.input.ExpressionAttributeValues[':gsi3pk']).toBe('failed');
  });

  it('preserves intermediate state by only updating failure-related fields', async () => {
    await markWorkflowFailed(
      mockDynamo as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient,
      'tenant-1',
      'CLM-001',
      'evidence_retrieval',
      'Timeout'
    );

    const call = mockDynamo.send.mock.calls[0][0];
    // The UpdateExpression should NOT overwrite step_history or other intermediate data
    expect(call.input.UpdateExpression).not.toContain('step_history');
    expect(call.input.UpdateExpression).toContain('failure_reason');
    expect(call.input.UpdateExpression).toContain('failed_step');
    expect(call.input.UpdateExpression).toContain('#status');
  });

  it('skips SNS notification when SNS_TOPIC_ARN is not configured', async () => {
    delete process.env.SNS_TOPIC_ARN;
    // Reset and re-set clients without SNS topic
    resetClients();
    mockDynamo = createMockDynamoClient();
    mockSNS = createMockSNSClient();
    setClients({
      dynamo: mockDynamo as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient,
      sns: mockSNS as unknown as import('@aws-sdk/client-sns').SNSClient,
    });

    await markWorkflowFailed(
      mockDynamo as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient,
      'tenant-1',
      'CLM-001',
      'ingestion',
      'Error'
    );

    // DynamoDB should still be updated
    expect(mockDynamo.send).toHaveBeenCalledTimes(1);
    // SNS should NOT be called
    expect(mockSNS.send).not.toHaveBeenCalled();
  });

  it('sets completed_at timestamp on failure', async () => {
    const before = new Date().toISOString();

    await markWorkflowFailed(
      mockDynamo as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient,
      'tenant-1',
      'CLM-001',
      'ingestion',
      'Error'
    );

    const after = new Date().toISOString();
    const call = mockDynamo.send.mock.calls[0][0];
    const completedAt = call.input.ExpressionAttributeValues[':completedAt'];

    expect(completedAt >= before).toBe(true);
    expect(completedAt <= after).toBe(true);
  });
});
