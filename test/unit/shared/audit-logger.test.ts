/**
 * Unit tests for the audit logger middleware.
 *
 * Validates:
 * - logAccess writes correct AuditLogEntry to DynamoDB
 * - Timestamp is ISO 8601 with millisecond precision in UTC
 * - PK/SK follow the expected key patterns
 * - Fire-and-forget behavior (errors don't throw)
 * - createAuditMiddleware factory produces correct log entries
 * - Append-only semantics (ConditionExpression prevents overwrites)
 *
 * Requirements: 9.3, 9.5
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  logAccess,
  createAuditMiddleware,
  setAuditDynamoClient,
  resetAuditDynamoClient,
  type LogAccessParams,
} from '@shared/audit-logger';

// ─── Mock Setup ─────────────────────────────────────────────────────────────

function createMockDynamoClient(resolveValue: unknown = {}) {
  return {
    send: vi.fn().mockResolvedValue(resolveValue),
  } as any;
}

function createFailingDynamoClient(error: Error) {
  return {
    send: vi.fn().mockRejectedValue(error),
  } as any;
}

let mockDynamo: ReturnType<typeof createMockDynamoClient>;

beforeEach(() => {
  mockDynamo = createMockDynamoClient();
  setAuditDynamoClient(mockDynamo);
});

afterEach(() => {
  resetAuditDynamoClient();
  vi.restoreAllMocks();
});

// ─── Test Data ──────────────────────────────────────────────────────────────

function createTestParams(overrides?: Partial<LogAccessParams>): LogAccessParams {
  return {
    accessor_identity: 'user:analyst@hospital.org',
    resource_accessed: 'DenialRecord:claim-12345',
    action: 'read',
    permitted: true,
    tenant_id: 'tenant-abc',
    request_id: 'req-001',
    source_ip: '10.0.1.50',
    ...overrides,
  };
}

// ─── logAccess Tests ────────────────────────────────────────────────────────

describe('logAccess', () => {
  it('should write an AuditLogEntry to DynamoDB with correct fields', async () => {
    const params = createTestParams();
    const result = await logAccess(params);

    expect(result.success).toBe(true);
    expect(result.entry).toBeDefined();

    const entry = result.entry!;
    expect(entry.accessor_identity).toBe('user:analyst@hospital.org');
    expect(entry.resource_accessed).toBe('DenialRecord:claim-12345');
    expect(entry.action).toBe('read');
    expect(entry.permitted).toBe(true);
    expect(entry.tenant_id).toBe('tenant-abc');
    expect(entry.request_id).toBe('req-001');
    expect(entry.source_ip).toBe('10.0.1.50');
  });

  it('should generate a timestamp in ISO 8601 format with millisecond precision in UTC', async () => {
    const params = createTestParams();
    const result = await logAccess(params);

    const timestamp = result.entry!.timestamp;
    // ISO 8601 with ms: YYYY-MM-DDTHH:mm:ss.mmmZ
    expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('should use PK format AUDIT#<tenant_id>#<date>', async () => {
    const params = createTestParams({ tenant_id: 'hospital-xyz' });
    const result = await logAccess(params);

    const pk = result.entry!.PK;
    expect(pk).toMatch(/^AUDIT#hospital-xyz#\d{4}-\d{2}-\d{2}$/);
  });

  it('should use SK format <timestamp>#<request_id>', async () => {
    const params = createTestParams({ request_id: 'req-unique-42' });
    const result = await logAccess(params);

    const sk = result.entry!.SK;
    expect(sk).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z#req-unique-42$/);
  });

  it('should use ConditionExpression to prevent overwrites (append-only)', async () => {
    const params = createTestParams();
    await logAccess(params);

    expect(mockDynamo.send).toHaveBeenCalledTimes(1);

    const command = mockDynamo.send.mock.calls[0][0];
    expect(command.input.ConditionExpression).toBe(
      'attribute_not_exists(PK) AND attribute_not_exists(SK)'
    );
  });

  it('should write to the AuditLog table', async () => {
    const params = createTestParams();
    await logAccess(params);

    const command = mockDynamo.send.mock.calls[0][0];
    expect(command.input.TableName).toBe('AuditLog');
  });

  it('should log denied access attempts (permitted=false)', async () => {
    const params = createTestParams({ permitted: false, action: 'write' });
    const result = await logAccess(params);

    expect(result.success).toBe(true);
    expect(result.entry!.permitted).toBe(false);
    expect(result.entry!.action).toBe('write');
  });

  it('should not throw on DynamoDB failure (fire-and-forget)', async () => {
    const failingClient = createFailingDynamoClient(new Error('DynamoDB unavailable'));
    setAuditDynamoClient(failingClient);

    const params = createTestParams();
    const result = await logAccess(params);

    expect(result.success).toBe(false);
    expect(result.error).toBe('DynamoDB unavailable');
  });

  it('should log error to console on failure', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failingClient = createFailingDynamoClient(new Error('Throttled'));
    setAuditDynamoClient(failingClient);

    const params = createTestParams();
    await logAccess(params);

    expect(consoleSpy).toHaveBeenCalledWith(
      '[AUDIT_LOG] Failed to write audit entry:',
      'Throttled'
    );
  });

  it('should handle ConditionalCheckFailedException gracefully', async () => {
    const error = new Error('The conditional request failed');
    error.name = 'ConditionalCheckFailedException';
    const failingClient = createFailingDynamoClient(error);
    setAuditDynamoClient(failingClient);

    const params = createTestParams();
    const result = await logAccess(params);

    expect(result.success).toBe(false);
    expect(result.error).toContain('conditional request failed');
  });

  it('should use AUDIT_TABLE_NAME env var when set', async () => {
    process.env.AUDIT_TABLE_NAME = 'CustomAuditTable';

    const params = createTestParams();
    await logAccess(params);

    const command = mockDynamo.send.mock.calls[0][0];
    expect(command.input.TableName).toBe('CustomAuditTable');

    delete process.env.AUDIT_TABLE_NAME;
  });
});

// ─── createAuditMiddleware Tests ────────────────────────────────────────────

describe('createAuditMiddleware', () => {
  it('should return a function that logs access events', async () => {
    const auditLog = createAuditMiddleware('tenant-1', 'user:admin', 'req-100', '192.168.1.1');

    auditLog('EvidencePackage:claim-999', 'read', true);

    // Allow the fire-and-forget promise to resolve
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockDynamo.send).toHaveBeenCalledTimes(1);

    const command = mockDynamo.send.mock.calls[0][0];
    const item = command.input.Item;
    expect(item.accessor_identity).toBe('user:admin');
    expect(item.resource_accessed).toBe('EvidencePackage:claim-999');
    expect(item.action).toBe('read');
    expect(item.permitted).toBe(true);
    expect(item.tenant_id).toBe('tenant-1');
    expect(item.request_id).toBe('req-100');
    expect(item.source_ip).toBe('192.168.1.1');
  });

  it('should not block the caller (fire-and-forget)', () => {
    const slowClient = {
      send: vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 5000))
      ),
    } as any;
    setAuditDynamoClient(slowClient);

    const auditLog = createAuditMiddleware('tenant-1', 'user:admin', 'req-200', '10.0.0.1');

    // This should return immediately without waiting for DynamoDB
    const start = Date.now();
    auditLog('DenialRecord:claim-1', 'read', true);
    const elapsed = Date.now() - start;

    // Should complete in under 50ms (not waiting for the 5s DynamoDB call)
    expect(elapsed).toBeLessThan(50);
  });

  it('should generate a request_id when not provided', async () => {
    const auditLog = createAuditMiddleware('tenant-2', 'service:classifier');

    auditLog('ClassifiedDenial:claim-500', 'write', true);

    await new Promise((resolve) => setTimeout(resolve, 10));

    const command = mockDynamo.send.mock.calls[0][0];
    const item = command.input.Item;
    expect(item.request_id).toBeDefined();
    expect(item.request_id.length).toBeGreaterThan(0);
  });

  it('should default source_ip to "unknown" when not provided', async () => {
    const auditLog = createAuditMiddleware('tenant-3', 'service:evidence');

    auditLog('EvidencePackage:claim-700', 'read', true);

    await new Promise((resolve) => setTimeout(resolve, 10));

    const command = mockDynamo.send.mock.calls[0][0];
    const item = command.input.Item;
    expect(item.source_ip).toBe('unknown');
  });

  it('should log denied access attempts correctly', async () => {
    const auditLog = createAuditMiddleware('tenant-4', 'user:unauthorized', 'req-403', '10.0.0.99');

    auditLog('DenialRecord:claim-secret', 'read', false);

    await new Promise((resolve) => setTimeout(resolve, 10));

    const command = mockDynamo.send.mock.calls[0][0];
    const item = command.input.Item;
    expect(item.permitted).toBe(false);
    expect(item.resource_accessed).toBe('DenialRecord:claim-secret');
  });

  it('should support multiple log calls with the same middleware instance', async () => {
    const auditLog = createAuditMiddleware('tenant-5', 'user:analyst', 'req-multi', '10.0.0.1');

    auditLog('DenialRecord:claim-1', 'read', true);
    auditLog('EvidencePackage:claim-1', 'read', true);
    auditLog('AppealLetter:claim-1', 'write', true);

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(mockDynamo.send).toHaveBeenCalledTimes(3);

    const resources = mockDynamo.send.mock.calls.map(
      (call: any) => call[0].input.Item.resource_accessed
    );
    expect(resources).toContain('DenialRecord:claim-1');
    expect(resources).toContain('EvidencePackage:claim-1');
    expect(resources).toContain('AppealLetter:claim-1');
  });
});
