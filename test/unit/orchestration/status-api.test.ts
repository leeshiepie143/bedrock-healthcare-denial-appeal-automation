/**
 * Unit tests for Workflow Status API Lambda
 *
 * Tests the API Gateway handler for querying workflow status by claim_id,
 * including primary (tenant + claim) and fallback (GSI1) query paths,
 * error handling, and response formatting.
 *
 * Requirements: 7.5
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  handler,
  setClients,
  resetClients,
} from '@lambdas/orchestration/status-api';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import type { WorkflowStatus } from '@shared/models';

// ─── Mock DynamoDB Client ───────────────────────────────────────────────────

function createMockDynamoClient() {
  return {
    send: vi.fn(),
  };
}

// ─── Test Helpers ───────────────────────────────────────────────────────────

function createMockWorkflowStatus(overrides: Partial<WorkflowStatus> = {}): WorkflowStatus {
  return {
    PK: 'TENANT#tenant-1',
    SK: 'WORKFLOW#CLM001',
    claim_id: 'CLM001',
    execution_id: 'exec-001',
    status: 'in_progress',
    current_step: 'evidence_retrieval',
    step_history: [
      {
        step: 'ingestion',
        status: 'completed',
        started_at: '2024-01-15T10:00:00Z',
        completed_at: '2024-01-15T10:00:15Z',
        duration_ms: 15000,
        retry_count: 0,
      },
      {
        step: 'classification',
        status: 'completed',
        started_at: '2024-01-15T10:00:15Z',
        completed_at: '2024-01-15T10:00:30Z',
        duration_ms: 15000,
        retry_count: 0,
      },
    ],
    started_at: '2024-01-15T10:00:00Z',
    completed_at: null,
    failure_reason: null,
    failed_step: null,
    ...overrides,
  };
}

function createApiEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    httpMethod: 'GET',
    path: '/workflows/CLM001/status',
    pathParameters: { claimId: 'CLM001' },
    queryStringParameters: null,
    headers: {},
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    body: null,
    isBase64Encoded: false,
    stageVariables: null,
    requestContext: {} as APIGatewayProxyEvent['requestContext'],
    resource: '',
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Workflow Status API', () => {
  let mockDynamo: ReturnType<typeof createMockDynamoClient>;

  beforeEach(() => {
    mockDynamo = createMockDynamoClient();
    setClients({ dynamo: mockDynamo as any });
    process.env.TABLE_NAME = 'TestTable';
  });

  afterEach(() => {
    resetClients();
    delete process.env.TABLE_NAME;
  });

  describe('Successful queries', () => {
    it('should return workflow status using primary path (tenant + claim)', async () => {
      const workflow = createMockWorkflowStatus();
      mockDynamo.send.mockResolvedValueOnce({ Item: workflow });

      const event = createApiEvent({
        pathParameters: { claimId: 'CLM001' },
        headers: { 'x-tenant-id': 'tenant-1' },
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.claim_id).toBe('CLM001');
      expect(body.status).toBe('in_progress');
      expect(body.current_step).toBe('evidence_retrieval');
      expect(body.started_at).toBe('2024-01-15T10:00:00Z');
      expect(body.completed_at).toBeNull();
      expect(body.step_history).toHaveLength(2);
      expect(body.failure_reason).toBeNull();
      expect(body.failed_step).toBeNull();
    });

    it('should return workflow status using X-Tenant-Id header (case variation)', async () => {
      const workflow = createMockWorkflowStatus();
      mockDynamo.send.mockResolvedValueOnce({ Item: workflow });

      const event = createApiEvent({
        pathParameters: { claimId: 'CLM001' },
        headers: { 'X-Tenant-Id': 'tenant-1' },
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.claim_id).toBe('CLM001');
    });

    it('should return workflow status using tenantId query parameter', async () => {
      const workflow = createMockWorkflowStatus();
      mockDynamo.send.mockResolvedValueOnce({ Item: workflow });

      const event = createApiEvent({
        pathParameters: { claimId: 'CLM001' },
        queryStringParameters: { tenantId: 'tenant-1' },
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.claim_id).toBe('CLM001');
    });

    it('should use GSI1 fallback when tenantId is not provided', async () => {
      const workflow = createMockWorkflowStatus();
      mockDynamo.send.mockResolvedValueOnce({ Items: [workflow] });

      const event = createApiEvent({
        pathParameters: { claimId: 'CLM001' },
        headers: {},
        queryStringParameters: null,
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.claim_id).toBe('CLM001');

      // Verify GSI1 query was used
      const sendCall = mockDynamo.send.mock.calls[0][0];
      expect(sendCall.input.IndexName).toBe('GSI1-ClaimId-Index');
      expect(sendCall.input.KeyConditionExpression).toBe('GSI1PK = :claimId');
    });

    it('should return completed workflow with all fields populated', async () => {
      const workflow = createMockWorkflowStatus({
        status: 'completed',
        current_step: 'letter_generation',
        completed_at: '2024-01-15T10:05:00Z',
        step_history: [
          {
            step: 'ingestion',
            status: 'completed',
            started_at: '2024-01-15T10:00:00Z',
            completed_at: '2024-01-15T10:00:15Z',
            duration_ms: 15000,
            retry_count: 0,
          },
          {
            step: 'classification',
            status: 'completed',
            started_at: '2024-01-15T10:00:15Z',
            completed_at: '2024-01-15T10:00:30Z',
            duration_ms: 15000,
            retry_count: 0,
          },
          {
            step: 'evidence_retrieval',
            status: 'completed',
            started_at: '2024-01-15T10:00:30Z',
            completed_at: '2024-01-15T10:02:00Z',
            duration_ms: 90000,
            retry_count: 1,
          },
          {
            step: 'viability_assessment',
            status: 'completed',
            started_at: '2024-01-15T10:02:00Z',
            completed_at: '2024-01-15T10:02:10Z',
            duration_ms: 10000,
            retry_count: 0,
          },
          {
            step: 'letter_generation',
            status: 'completed',
            started_at: '2024-01-15T10:02:10Z',
            completed_at: '2024-01-15T10:05:00Z',
            duration_ms: 170000,
            retry_count: 0,
          },
        ],
      });
      mockDynamo.send.mockResolvedValueOnce({ Item: workflow });

      const event = createApiEvent({
        pathParameters: { claimId: 'CLM001' },
        headers: { 'x-tenant-id': 'tenant-1' },
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.status).toBe('completed');
      expect(body.completed_at).toBe('2024-01-15T10:05:00Z');
      expect(body.step_history).toHaveLength(5);
    });

    it('should return failed workflow with failure details', async () => {
      const workflow = createMockWorkflowStatus({
        status: 'failed',
        current_step: 'evidence_retrieval',
        failure_reason: 'HealthLake query timed out after 3 retries',
        failed_step: 'evidence_retrieval',
      });
      mockDynamo.send.mockResolvedValueOnce({ Item: workflow });

      const event = createApiEvent({
        pathParameters: { claimId: 'CLM001' },
        headers: { 'x-tenant-id': 'tenant-1' },
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.status).toBe('failed');
      expect(body.failure_reason).toBe('HealthLake query timed out after 3 retries');
      expect(body.failed_step).toBe('evidence_retrieval');
    });

    it('should filter GSI1 results to only return workflow items', async () => {
      // GSI1 may return multiple item types for the same claim_id
      const denialItem = {
        PK: 'TENANT#tenant-1',
        SK: 'DENIAL#CLM001#edi_835',
        claim_id: 'CLM001',
      };
      const workflowItem = createMockWorkflowStatus();

      mockDynamo.send.mockResolvedValueOnce({ Items: [denialItem, workflowItem] });

      const event = createApiEvent({
        pathParameters: { claimId: 'CLM001' },
        headers: {},
        queryStringParameters: null,
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.claim_id).toBe('CLM001');
      expect(body.status).toBe('in_progress');
    });
  });

  describe('Error responses', () => {
    it('should return 400 when claimId path parameter is missing', async () => {
      const event = createApiEvent({
        pathParameters: null,
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toContain('claimId');
    });

    it('should return 400 when claimId is empty', async () => {
      const event = createApiEvent({
        pathParameters: { claimId: '' },
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toContain('claimId');
    });

    it('should return 404 when no workflow found (primary path)', async () => {
      mockDynamo.send.mockResolvedValueOnce({ Item: undefined });

      const event = createApiEvent({
        pathParameters: { claimId: 'NONEXISTENT' },
        headers: { 'x-tenant-id': 'tenant-1' },
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(404);
      const body = JSON.parse(result.body);
      expect(body.error).toContain('NONEXISTENT');
    });

    it('should return 404 when no workflow found (GSI1 fallback)', async () => {
      mockDynamo.send.mockResolvedValueOnce({ Items: [] });

      const event = createApiEvent({
        pathParameters: { claimId: 'NONEXISTENT' },
        headers: {},
        queryStringParameters: null,
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(404);
      const body = JSON.parse(result.body);
      expect(body.error).toContain('NONEXISTENT');
    });

    it('should return 404 when GSI1 returns items but none are workflow items', async () => {
      const denialItem = {
        PK: 'TENANT#tenant-1',
        SK: 'DENIAL#CLM001#edi_835',
        claim_id: 'CLM001',
      };
      mockDynamo.send.mockResolvedValueOnce({ Items: [denialItem] });

      const event = createApiEvent({
        pathParameters: { claimId: 'CLM001' },
        headers: {},
        queryStringParameters: null,
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(404);
    });

    it('should return 500 when DynamoDB throws an error', async () => {
      mockDynamo.send.mockRejectedValueOnce(new Error('DynamoDB service unavailable'));

      const event = createApiEvent({
        pathParameters: { claimId: 'CLM001' },
        headers: { 'x-tenant-id': 'tenant-1' },
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.error).toBe('Internal server error');
    });
  });

  describe('Response format', () => {
    it('should include CORS headers in response', async () => {
      const workflow = createMockWorkflowStatus();
      mockDynamo.send.mockResolvedValueOnce({ Item: workflow });

      const event = createApiEvent({
        pathParameters: { claimId: 'CLM001' },
        headers: { 'x-tenant-id': 'tenant-1' },
      });

      const result = await handler(event);

      expect(result.headers?.['Content-Type']).toBe('application/json');
      expect(result.headers?.['Access-Control-Allow-Origin']).toBe('*');
      expect(result.headers?.['Access-Control-Allow-Headers']).toContain('X-Tenant-Id');
    });

    it('should not expose internal fields (PK, SK, execution_id, GSI keys) in response', async () => {
      const workflow = createMockWorkflowStatus({
        GSI3PK: 'in_progress',
        GSI3SK: '2024-01-15T10:00:00Z',
      });
      mockDynamo.send.mockResolvedValueOnce({ Item: workflow });

      const event = createApiEvent({
        pathParameters: { claimId: 'CLM001' },
        headers: { 'x-tenant-id': 'tenant-1' },
      });

      const result = await handler(event);

      const body = JSON.parse(result.body);
      expect(body.PK).toBeUndefined();
      expect(body.SK).toBeUndefined();
      expect(body.execution_id).toBeUndefined();
      expect(body.GSI3PK).toBeUndefined();
      expect(body.GSI3SK).toBeUndefined();
    });

    it('should return all expected fields in the response', async () => {
      const workflow = createMockWorkflowStatus();
      mockDynamo.send.mockResolvedValueOnce({ Item: workflow });

      const event = createApiEvent({
        pathParameters: { claimId: 'CLM001' },
        headers: { 'x-tenant-id': 'tenant-1' },
      });

      const result = await handler(event);

      const body = JSON.parse(result.body);
      const expectedFields = [
        'claim_id',
        'status',
        'current_step',
        'started_at',
        'completed_at',
        'step_history',
        'failure_reason',
        'failed_step',
      ];
      for (const field of expectedFields) {
        expect(body).toHaveProperty(field);
      }
    });
  });

  describe('DynamoDB query construction', () => {
    it('should use GetCommand with correct PK/SK for primary path', async () => {
      mockDynamo.send.mockResolvedValueOnce({ Item: createMockWorkflowStatus() });

      const event = createApiEvent({
        pathParameters: { claimId: 'CLM001' },
        headers: { 'x-tenant-id': 'tenant-1' },
      });

      await handler(event);

      const sendCall = mockDynamo.send.mock.calls[0][0];
      expect(sendCall.input.TableName).toBe('TestTable');
      expect(sendCall.input.Key).toEqual({
        PK: 'TENANT#tenant-1',
        SK: 'WORKFLOW#CLM001',
      });
    });

    it('should use QueryCommand with GSI1 for fallback path', async () => {
      mockDynamo.send.mockResolvedValueOnce({ Items: [createMockWorkflowStatus()] });

      const event = createApiEvent({
        pathParameters: { claimId: 'CLM001' },
        headers: {},
        queryStringParameters: null,
      });

      await handler(event);

      const sendCall = mockDynamo.send.mock.calls[0][0];
      expect(sendCall.input.TableName).toBe('TestTable');
      expect(sendCall.input.IndexName).toBe('GSI1-ClaimId-Index');
      expect(sendCall.input.ExpressionAttributeValues).toEqual({
        ':claimId': 'CLM001',
      });
    });
  });
});
