/**
 * Unit tests for Outcome Recorder Lambda
 *
 * Tests validation of required fields, rejection of incomplete records
 * with specific missing field indication, and successful storage of
 * Appeal_Outcome records in DynamoDB with GSI2 keys.
 *
 * Requirements: 8.1, 8.2
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler, setClients, resetClients } from '@lambdas/outcomes/recorder';

// ─── Mock Helpers ───────────────────────────────────────────────────────────

function createMockDynamoClient() {
  return {
    send: vi.fn().mockResolvedValue({}),
  };
}

function createApiGatewayEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    path: '/outcomes',
    headers: { 'x-tenant-id': 'tenant-1' },
    multiValueHeaders: {},
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    pathParameters: null,
    stageVariables: null,
    requestContext: {} as APIGatewayProxyEvent['requestContext'],
    resource: '',
    body: JSON.stringify({
      claim_id: 'CLM-001',
      outcome_type: 'overturn',
      denial_reason_code: 'CO-16',
      payer_id: 'PAYER-ABC',
      evidence_used: ['fhir-res-1', 'fhir-res-2'],
      letter_version: 2,
      time_to_resolution_days: 14,
      recovered_amount: 1500.50,
    }),
    isBase64Encoded: false,
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Outcome Recorder Handler', () => {
  let mockDynamo: ReturnType<typeof createMockDynamoClient>;

  beforeEach(() => {
    process.env.TABLE_NAME = 'TestTable';
    mockDynamo = createMockDynamoClient();
    setClients({
      dynamo: mockDynamo as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient,
    });
  });

  afterEach(() => {
    resetClients();
    delete process.env.TABLE_NAME;
  });

  describe('successful outcome recording', () => {
    it('returns 201 with the stored record on valid input', async () => {
      const event = createApiGatewayEvent();
      const result = await handler(event);

      expect(result.statusCode).toBe(201);
      const body = JSON.parse(result.body);
      expect(body.claim_id).toBe('CLM-001');
      expect(body.outcome_type).toBe('overturn');
      expect(body.denial_reason_code).toBe('CO-16');
      expect(body.payer_id).toBe('PAYER-ABC');
    });

    it('stores the record in DynamoDB with correct PK and SK', async () => {
      const event = createApiGatewayEvent();
      await handler(event);

      expect(mockDynamo.send).toHaveBeenCalledTimes(1);
      const call = mockDynamo.send.mock.calls[0][0];
      expect(call.input.TableName).toBe('TestTable');
      expect(call.input.Item.PK).toBe('TENANT#tenant-1');
      expect(call.input.Item.SK).toBe('OUTCOME#CLM-001');
    });

    it('populates GSI2 keys for payer+reason analytics', async () => {
      const event = createApiGatewayEvent();
      await handler(event);

      const call = mockDynamo.send.mock.calls[0][0];
      expect(call.input.Item.GSI2PK).toBe('PAYER-ABC#CO-16');
      expect(call.input.Item.GSI2SK).toBe('overturn');
    });

    it('sets received_at to a valid ISO 8601 timestamp', async () => {
      const before = new Date().toISOString();
      const event = createApiGatewayEvent();
      const result = await handler(event);
      const after = new Date().toISOString();

      const body = JSON.parse(result.body);
      expect(body.received_at >= before).toBe(true);
      expect(body.received_at <= after).toBe(true);
    });

    it('defaults evidence_used to empty array when not provided', async () => {
      const event = createApiGatewayEvent({
        body: JSON.stringify({
          claim_id: 'CLM-002',
          outcome_type: 'upheld',
          denial_reason_code: 'CO-50',
          payer_id: 'PAYER-XYZ',
          time_to_resolution_days: 30,
        }),
      });

      const result = await handler(event);
      const body = JSON.parse(result.body);
      expect(body.evidence_used).toEqual([]);
    });

    it('defaults letter_version to 1 when not provided', async () => {
      const event = createApiGatewayEvent({
        body: JSON.stringify({
          claim_id: 'CLM-002',
          outcome_type: 'upheld',
          denial_reason_code: 'CO-50',
          payer_id: 'PAYER-XYZ',
          time_to_resolution_days: 30,
        }),
      });

      const result = await handler(event);
      const body = JSON.parse(result.body);
      expect(body.letter_version).toBe(1);
    });

    it('defaults recovered_amount to 0 when not provided', async () => {
      const event = createApiGatewayEvent({
        body: JSON.stringify({
          claim_id: 'CLM-002',
          outcome_type: 'upheld',
          denial_reason_code: 'CO-50',
          payer_id: 'PAYER-XYZ',
          time_to_resolution_days: 30,
        }),
      });

      const result = await handler(event);
      const body = JSON.parse(result.body);
      expect(body.recovered_amount).toBe(0);
    });

    it('handles partial_overturn outcome type', async () => {
      const event = createApiGatewayEvent({
        body: JSON.stringify({
          claim_id: 'CLM-003',
          outcome_type: 'partial_overturn',
          denial_reason_code: 'CO-97',
          payer_id: 'PAYER-DEF',
          time_to_resolution_days: 7,
          recovered_amount: 500.00,
        }),
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(201);
      const body = JSON.parse(result.body);
      expect(body.outcome_type).toBe('partial_overturn');
      expect(body.GSI2SK).toBe('partial_overturn');
    });

    it('uses TABLE_NAME environment variable', async () => {
      process.env.TABLE_NAME = 'CustomTable';
      const event = createApiGatewayEvent();
      await handler(event);

      const call = mockDynamo.send.mock.calls[0][0];
      expect(call.input.TableName).toBe('CustomTable');
    });
  });

  describe('validation failures', () => {
    it('returns 400 when x-tenant-id header is missing', async () => {
      const event = createApiGatewayEvent({
        headers: {},
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toContain('x-tenant-id');
    });

    it('returns 400 with invalid JSON body', async () => {
      const event = createApiGatewayEvent({
        body: 'not valid json{{{',
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toContain('Invalid JSON');
    });

    it('returns 400 when denial_reason_code is missing', async () => {
      const event = createApiGatewayEvent({
        body: JSON.stringify({
          claim_id: 'CLM-001',
          outcome_type: 'overturn',
          payer_id: 'PAYER-ABC',
          time_to_resolution_days: 14,
        }),
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.missing_fields).toContain('denial_reason_code is required');
    });

    it('returns 400 when payer_id is missing', async () => {
      const event = createApiGatewayEvent({
        body: JSON.stringify({
          claim_id: 'CLM-001',
          outcome_type: 'overturn',
          denial_reason_code: 'CO-16',
          time_to_resolution_days: 14,
        }),
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.missing_fields).toContain('payer_id is required');
    });

    it('returns 400 when outcome_type is missing', async () => {
      const event = createApiGatewayEvent({
        body: JSON.stringify({
          claim_id: 'CLM-001',
          denial_reason_code: 'CO-16',
          payer_id: 'PAYER-ABC',
          time_to_resolution_days: 14,
        }),
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.missing_fields).toContain('outcome_type must be one of: overturn, partial_overturn, upheld');
    });

    it('returns 400 when outcome_type is invalid enum value', async () => {
      const event = createApiGatewayEvent({
        body: JSON.stringify({
          claim_id: 'CLM-001',
          outcome_type: 'invalid_type',
          denial_reason_code: 'CO-16',
          payer_id: 'PAYER-ABC',
          time_to_resolution_days: 14,
        }),
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.missing_fields).toContain('outcome_type must be one of: overturn, partial_overturn, upheld');
    });

    it('returns 400 when time_to_resolution_days is missing', async () => {
      const event = createApiGatewayEvent({
        body: JSON.stringify({
          claim_id: 'CLM-001',
          outcome_type: 'overturn',
          denial_reason_code: 'CO-16',
          payer_id: 'PAYER-ABC',
        }),
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.missing_fields).toContain('time_to_resolution_days must be a positive integer');
    });

    it('returns 400 when time_to_resolution_days is not a positive integer', async () => {
      const event = createApiGatewayEvent({
        body: JSON.stringify({
          claim_id: 'CLM-001',
          outcome_type: 'overturn',
          denial_reason_code: 'CO-16',
          payer_id: 'PAYER-ABC',
          time_to_resolution_days: 0,
        }),
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.missing_fields).toContain('time_to_resolution_days must be a positive integer');
    });

    it('returns 400 when claim_id is missing', async () => {
      const event = createApiGatewayEvent({
        body: JSON.stringify({
          outcome_type: 'overturn',
          denial_reason_code: 'CO-16',
          payer_id: 'PAYER-ABC',
          time_to_resolution_days: 14,
        }),
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.missing_fields).toContain('claim_id is required');
    });

    it('returns 400 with multiple missing fields listed', async () => {
      const event = createApiGatewayEvent({
        body: JSON.stringify({
          claim_id: 'CLM-001',
        }),
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.missing_fields.length).toBeGreaterThanOrEqual(3);
    });

    it('does not store record in DynamoDB when validation fails', async () => {
      const event = createApiGatewayEvent({
        body: JSON.stringify({
          claim_id: 'CLM-001',
          // Missing required fields
        }),
      });

      await handler(event);
      expect(mockDynamo.send).not.toHaveBeenCalled();
    });

    it('returns 400 when claim_id is empty string', async () => {
      const event = createApiGatewayEvent({
        body: JSON.stringify({
          claim_id: '',
          outcome_type: 'overturn',
          denial_reason_code: 'CO-16',
          payer_id: 'PAYER-ABC',
          time_to_resolution_days: 14,
        }),
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.missing_fields).toContain('claim_id is required');
    });

    it('returns 400 when time_to_resolution_days is a decimal', async () => {
      const event = createApiGatewayEvent({
        body: JSON.stringify({
          claim_id: 'CLM-001',
          outcome_type: 'overturn',
          denial_reason_code: 'CO-16',
          payer_id: 'PAYER-ABC',
          time_to_resolution_days: 14.5,
        }),
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.missing_fields).toContain('time_to_resolution_days must be a positive integer');
    });
  });

  describe('tenant header handling', () => {
    it('accepts X-Tenant-Id header (case variation)', async () => {
      const event = createApiGatewayEvent({
        headers: { 'X-Tenant-Id': 'tenant-upper' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(201);
      const body = JSON.parse(result.body);
      expect(body.PK).toBe('TENANT#tenant-upper');
    });

    it('uses tenant ID from header in DynamoDB PK', async () => {
      const event = createApiGatewayEvent({
        headers: { 'x-tenant-id': 'my-org-123' },
      });

      await handler(event);
      const call = mockDynamo.send.mock.calls[0][0];
      expect(call.input.Item.PK).toBe('TENANT#my-org-123');
    });
  });
});
