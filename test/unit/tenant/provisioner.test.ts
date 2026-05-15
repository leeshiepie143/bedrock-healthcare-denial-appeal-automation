/**
 * Unit tests for Tenant Provisioner
 *
 * Tests tenant provisioning flow including KMS key creation, S3 prefix
 * verification, DynamoDB config record creation, rollback on failure,
 * and SNS failure notifications.
 *
 * Requirements: 10.1, 10.2, 10.3
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  provisionTenant,
  setClients,
  resetClients,
} from '@lambdas/tenant/provisioner';

// ─── Mock Helpers ───────────────────────────────────────────────────────────

function createMockDynamoClient() {
  return {
    send: vi.fn().mockResolvedValue({}),
  };
}

function createMockS3Client() {
  return {
    send: vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'GetObjectCommand') {
        return Promise.resolve({ Body: 'test-content' });
      }
      return Promise.resolve({});
    }),
  };
}

function createMockKmsClient() {
  return {
    send: vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'CreateKeyCommand') {
        return Promise.resolve({
          KeyMetadata: {
            Arn: 'arn:aws:kms:us-east-1:123456789:key/test-key-id',
            Enabled: true,
          },
        });
      }
      if (command.constructor.name === 'DescribeKeyCommand') {
        return Promise.resolve({
          KeyMetadata: {
            Arn: 'arn:aws:kms:us-east-1:123456789:key/test-key-id',
            Enabled: true,
          },
        });
      }
      return Promise.resolve({});
    }),
  };
}

function createMockSnsClient() {
  return {
    send: vi.fn().mockResolvedValue({ MessageId: 'test-message-id' }),
  };
}

function setupClients() {
  const mockDynamo = createMockDynamoClient();
  const mockS3 = createMockS3Client();
  const mockKms = createMockKmsClient();
  const mockSns = createMockSnsClient();

  setClients({
    dynamo: mockDynamo as any,
    s3: mockS3 as any,
    kms: mockKms as any,
    sns: mockSns as any,
  });

  return { mockDynamo, mockS3, mockKms, mockSns };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('provisionTenant - successful provisioning', () => {
  let mocks: ReturnType<typeof setupClients>;

  beforeEach(() => {
    process.env.TABLE_NAME = 'TestTable';
    process.env.INGESTION_BUCKET = 'test-bucket';
    process.env.SNS_TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789:test-topic';
    mocks = setupClients();
  });

  afterEach(() => {
    resetClients();
    delete process.env.TABLE_NAME;
    delete process.env.INGESTION_BUCKET;
    delete process.env.SNS_TOPIC_ARN;
  });

  it('returns success with tenant configuration on successful provisioning', async () => {
    const result = await provisionTenant('tenant-abc', 'Acme Health');

    expect(result.success).toBe(true);
    expect(result.tenantConfiguration).toBeDefined();
    expect(result.error).toBeUndefined();
  });

  it('creates a KMS key with correct description and tags', async () => {
    await provisionTenant('tenant-abc', 'Acme Health');

    const kmsCreateCall = mocks.mockKms.send.mock.calls.find(
      (call: any[]) => call[0].constructor.name === 'CreateKeyCommand'
    );
    expect(kmsCreateCall).toBeDefined();
    expect(kmsCreateCall![0].input.Description).toContain('tenant-abc');
    expect(kmsCreateCall![0].input.Tags).toEqual(
      expect.arrayContaining([
        { TagKey: 'TenantId', TagValue: 'tenant-abc' },
        { TagKey: 'ManagedBy', TagValue: 'DenialAppealAgent' },
      ])
    );
  });

  it('creates a KMS alias with correct naming convention', async () => {
    await provisionTenant('tenant-abc', 'Acme Health');

    const kmsAliasCall = mocks.mockKms.send.mock.calls.find(
      (call: any[]) => call[0].constructor.name === 'CreateAliasCommand'
    );
    expect(kmsAliasCall).toBeDefined();
    expect(kmsAliasCall![0].input.AliasName).toBe('alias/denial-appeal/tenant/tenant-abc');
    expect(kmsAliasCall![0].input.TargetKeyId).toBe(
      'arn:aws:kms:us-east-1:123456789:key/test-key-id'
    );
  });

  it('creates and verifies S3 prefix with put/get/delete test', async () => {
    await provisionTenant('tenant-abc', 'Acme Health');

    const s3Calls = mocks.mockS3.send.mock.calls;
    const putCall = s3Calls.find(
      (call: any[]) => call[0].constructor.name === 'PutObjectCommand'
    );
    const getCall = s3Calls.find(
      (call: any[]) => call[0].constructor.name === 'GetObjectCommand'
    );
    const deleteCall = s3Calls.find(
      (call: any[]) => call[0].constructor.name === 'DeleteObjectCommand'
    );

    expect(putCall).toBeDefined();
    expect(putCall![0].input.Bucket).toBe('test-bucket');
    expect(putCall![0].input.Key).toBe('tenants/tenant-abc/.provisioning-test');

    expect(getCall).toBeDefined();
    expect(getCall![0].input.Key).toBe('tenants/tenant-abc/.provisioning-test');

    expect(deleteCall).toBeDefined();
    expect(deleteCall![0].input.Key).toBe('tenants/tenant-abc/.provisioning-test');
  });

  it('stores TenantConfiguration in DynamoDB with correct PK/SK', async () => {
    const result = await provisionTenant('tenant-abc', 'Acme Health');

    const dynamoPutCall = mocks.mockDynamo.send.mock.calls.find(
      (call: any[]) => call[0].constructor.name === 'PutCommand'
    );
    expect(dynamoPutCall).toBeDefined();
    expect(dynamoPutCall![0].input.TableName).toBe('TestTable');
    expect(dynamoPutCall![0].input.Item.PK).toBe('TENANT#tenant-abc');
    expect(dynamoPutCall![0].input.Item.SK).toBe('CONFIG');

    expect(result.tenantConfiguration!.tenant_id).toBe('tenant-abc');
    expect(result.tenantConfiguration!.tenant_name).toBe('Acme Health');
  });

  it('sets tenant status to active on successful provisioning', async () => {
    const result = await provisionTenant('tenant-abc', 'Acme Health');

    expect(result.tenantConfiguration!.status).toBe('active');
  });

  it('stores KMS key ARN in tenant configuration', async () => {
    const result = await provisionTenant('tenant-abc', 'Acme Health');

    expect(result.tenantConfiguration!.kms_key_arn).toBe(
      'arn:aws:kms:us-east-1:123456789:key/test-key-id'
    );
  });

  it('stores S3 prefix in tenant configuration', async () => {
    const result = await provisionTenant('tenant-abc', 'Acme Health');

    expect(result.tenantConfiguration!.s3_prefix).toBe('tenants/tenant-abc/');
  });

  it('sets default rate limit to 100 rpm when not specified', async () => {
    const result = await provisionTenant('tenant-abc', 'Acme Health');

    expect(result.tenantConfiguration!.rate_limit_rpm).toBe(100);
  });

  it('uses custom rate limit when provided in config', async () => {
    const result = await provisionTenant('tenant-abc', 'Acme Health', {
      rateLimitRpm: 500,
    });

    expect(result.tenantConfiguration!.rate_limit_rpm).toBe(500);
  });

  it('sets webhook endpoint from config', async () => {
    const result = await provisionTenant('tenant-abc', 'Acme Health', {
      webhookEndpoint: 'https://acme.example.com/webhook',
    });

    expect(result.tenantConfiguration!.webhook_endpoint).toBe(
      'https://acme.example.com/webhook'
    );
  });

  it('sets onboarded_at to a valid ISO 8601 timestamp', async () => {
    const before = new Date().toISOString();
    const result = await provisionTenant('tenant-abc', 'Acme Health');
    const after = new Date().toISOString();

    expect(result.tenantConfiguration!.onboarded_at >= before).toBe(true);
    expect(result.tenantConfiguration!.onboarded_at <= after).toBe(true);
  });

  it('uses ConditionExpression to prevent overwriting existing tenant', async () => {
    await provisionTenant('tenant-abc', 'Acme Health');

    const dynamoPutCall = mocks.mockDynamo.send.mock.calls.find(
      (call: any[]) => call[0].constructor.name === 'PutCommand'
    );
    expect(dynamoPutCall![0].input.ConditionExpression).toBe('attribute_not_exists(PK)');
  });

  it('verifies KMS key is enabled after creation', async () => {
    await provisionTenant('tenant-abc', 'Acme Health');

    const describeCall = mocks.mockKms.send.mock.calls.find(
      (call: any[]) => call[0].constructor.name === 'DescribeKeyCommand'
    );
    expect(describeCall).toBeDefined();
    expect(describeCall![0].input.KeyId).toBe(
      'arn:aws:kms:us-east-1:123456789:key/test-key-id'
    );
  });

  it('stores notification topic ARN in tenant configuration', async () => {
    const result = await provisionTenant('tenant-abc', 'Acme Health');

    expect(result.tenantConfiguration!.notification_topic_arn).toBe(
      'arn:aws:sns:us-east-1:123456789:test-topic'
    );
  });
});

describe('provisionTenant - rollback on failure', () => {
  let mocks: ReturnType<typeof setupClients>;

  beforeEach(() => {
    process.env.TABLE_NAME = 'TestTable';
    process.env.INGESTION_BUCKET = 'test-bucket';
    process.env.SNS_TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789:test-topic';
    mocks = setupClients();
  });

  afterEach(() => {
    resetClients();
    delete process.env.TABLE_NAME;
    delete process.env.INGESTION_BUCKET;
    delete process.env.SNS_TOPIC_ARN;
  });

  it('rolls back KMS key when S3 prefix creation fails', async () => {
    // Make S3 PutObject fail
    mocks.mockS3.send.mockRejectedValue(new Error('S3 access denied'));

    const result = await provisionTenant('tenant-abc', 'Acme Health');

    expect(result.success).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(result.error).toContain('S3 access denied');

    // Verify KMS alias deletion was attempted
    const deleteAliasCall = mocks.mockKms.send.mock.calls.find(
      (call: any[]) => call[0].constructor.name === 'DeleteAliasCommand'
    );
    expect(deleteAliasCall).toBeDefined();
    expect(deleteAliasCall![0].input.AliasName).toBe('alias/denial-appeal/tenant/tenant-abc');

    // Verify KMS key deletion was scheduled
    const scheduleDeleteCall = mocks.mockKms.send.mock.calls.find(
      (call: any[]) => call[0].constructor.name === 'ScheduleKeyDeletionCommand'
    );
    expect(scheduleDeleteCall).toBeDefined();
    expect(scheduleDeleteCall![0].input.PendingWindowInDays).toBe(7);
  });

  it('rolls back KMS key and S3 when DynamoDB write fails', async () => {
    // Make DynamoDB PutCommand fail
    mocks.mockDynamo.send.mockRejectedValue(
      new Error('ConditionalCheckFailedException: tenant already exists')
    );

    const result = await provisionTenant('tenant-abc', 'Acme Health');

    expect(result.success).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(result.error).toContain('ConditionalCheckFailedException');

    // KMS key should be scheduled for deletion
    const scheduleDeleteCall = mocks.mockKms.send.mock.calls.find(
      (call: any[]) => call[0].constructor.name === 'ScheduleKeyDeletionCommand'
    );
    expect(scheduleDeleteCall).toBeDefined();
  });

  it('rolls back all resources when KMS key verification fails', async () => {
    // Make DescribeKey return disabled key
    mocks.mockKms.send.mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'CreateKeyCommand') {
        return Promise.resolve({
          KeyMetadata: {
            Arn: 'arn:aws:kms:us-east-1:123456789:key/test-key-id',
            Enabled: true,
          },
        });
      }
      if (command.constructor.name === 'DescribeKeyCommand') {
        return Promise.resolve({
          KeyMetadata: {
            Arn: 'arn:aws:kms:us-east-1:123456789:key/test-key-id',
            Enabled: false,
          },
        });
      }
      return Promise.resolve({});
    });

    const result = await provisionTenant('tenant-abc', 'Acme Health');

    expect(result.success).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(result.error).toContain('not enabled');
  });

  it('reports rollback errors when rollback itself fails', async () => {
    // Make S3 fail to trigger rollback
    mocks.mockS3.send.mockRejectedValue(new Error('S3 access denied'));
    // Make KMS rollback also fail
    mocks.mockKms.send.mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'CreateKeyCommand') {
        return Promise.resolve({
          KeyMetadata: {
            Arn: 'arn:aws:kms:us-east-1:123456789:key/test-key-id',
            Enabled: true,
          },
        });
      }
      if (command.constructor.name === 'CreateAliasCommand') {
        return Promise.resolve({});
      }
      if (command.constructor.name === 'DeleteAliasCommand') {
        return Promise.reject(new Error('Alias deletion failed'));
      }
      if (command.constructor.name === 'ScheduleKeyDeletionCommand') {
        return Promise.reject(new Error('Key deletion scheduling failed'));
      }
      return Promise.resolve({});
    });

    const result = await provisionTenant('tenant-abc', 'Acme Health');

    expect(result.success).toBe(false);
    expect(result.rollbackErrors).toBeDefined();
    expect(result.rollbackErrors!.length).toBeGreaterThan(0);
  });

  it('does not attempt DynamoDB rollback if DynamoDB record was never created', async () => {
    // Fail at S3 step (before DynamoDB)
    mocks.mockS3.send.mockRejectedValue(new Error('S3 error'));

    await provisionTenant('tenant-abc', 'Acme Health');

    // No DeleteCommand should have been sent to DynamoDB
    const dynamoDeleteCall = mocks.mockDynamo.send.mock.calls.find(
      (call: any[]) => call[0].constructor.name === 'DeleteCommand'
    );
    expect(dynamoDeleteCall).toBeUndefined();
  });

  it('returns failure when KMS key creation fails (no rollback needed)', async () => {
    mocks.mockKms.send.mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'CreateKeyCommand') {
        return Promise.reject(new Error('KMS service unavailable'));
      }
      return Promise.resolve({});
    });

    const result = await provisionTenant('tenant-abc', 'Acme Health');

    expect(result.success).toBe(false);
    expect(result.error).toContain('KMS service unavailable');
    expect(result.rolledBack).toBe(true);
  });
});

describe('provisionTenant - SNS failure notification', () => {
  let mocks: ReturnType<typeof setupClients>;

  beforeEach(() => {
    process.env.TABLE_NAME = 'TestTable';
    process.env.INGESTION_BUCKET = 'test-bucket';
    process.env.SNS_TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789:test-topic';
    mocks = setupClients();
  });

  afterEach(() => {
    resetClients();
    delete process.env.TABLE_NAME;
    delete process.env.INGESTION_BUCKET;
    delete process.env.SNS_TOPIC_ARN;
  });

  it('sends SNS notification on provisioning failure', async () => {
    mocks.mockS3.send.mockRejectedValue(new Error('S3 bucket not found'));

    await provisionTenant('tenant-abc', 'Acme Health');

    expect(mocks.mockSns.send).toHaveBeenCalledTimes(1);
    const snsCall = mocks.mockSns.send.mock.calls[0][0];
    expect(snsCall.constructor.name).toBe('PublishCommand');

    const message = JSON.parse(snsCall.input.Message);
    expect(message.event).toBe('tenant_provisioning_failed');
    expect(message.tenant_id).toBe('tenant-abc');
    expect(message.tenant_name).toBe('Acme Health');
    expect(message.failure_reason).toContain('S3 bucket not found');
    expect(message.timestamp).toBeDefined();
  });

  it('includes tenant_id in SNS message attributes', async () => {
    mocks.mockS3.send.mockRejectedValue(new Error('Error'));

    await provisionTenant('tenant-abc', 'Acme Health');

    const snsCall = mocks.mockSns.send.mock.calls[0][0];
    expect(snsCall.input.MessageAttributes.tenant_id.StringValue).toBe('tenant-abc');
    expect(snsCall.input.MessageAttributes.event_type.StringValue).toBe(
      'tenant_provisioning_failed'
    );
  });

  it('truncates SNS subject to 100 characters', async () => {
    mocks.mockS3.send.mockRejectedValue(new Error('Error'));

    await provisionTenant(
      'tenant-abc',
      'Very Long Healthcare Organization Name That Exceeds Normal Limits For Testing Purposes'
    );

    const snsCall = mocks.mockSns.send.mock.calls[0][0];
    expect(snsCall.input.Subject.length).toBeLessThanOrEqual(100);
  });

  it('publishes to the configured SNS topic ARN', async () => {
    mocks.mockS3.send.mockRejectedValue(new Error('Error'));

    await provisionTenant('tenant-abc', 'Acme Health');

    const snsCall = mocks.mockSns.send.mock.calls[0][0];
    expect(snsCall.input.TopicArn).toBe('arn:aws:sns:us-east-1:123456789:test-topic');
  });

  it('skips SNS notification when SNS_TOPIC_ARN is not configured', async () => {
    delete process.env.SNS_TOPIC_ARN;
    mocks.mockS3.send.mockRejectedValue(new Error('Error'));

    const result = await provisionTenant('tenant-abc', 'Acme Health');

    expect(result.success).toBe(false);
    expect(mocks.mockSns.send).not.toHaveBeenCalled();
  });

  it('does not send SNS notification on successful provisioning', async () => {
    await provisionTenant('tenant-abc', 'Acme Health');

    expect(mocks.mockSns.send).not.toHaveBeenCalled();
  });
});

describe('provisionTenant - missing environment variables', () => {
  let mocks: ReturnType<typeof setupClients>;

  beforeEach(() => {
    process.env.TABLE_NAME = 'TestTable';
    process.env.SNS_TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789:test-topic';
    mocks = setupClients();
  });

  afterEach(() => {
    resetClients();
    delete process.env.TABLE_NAME;
    delete process.env.INGESTION_BUCKET;
    delete process.env.SNS_TOPIC_ARN;
  });

  it('fails with error when INGESTION_BUCKET is not set', async () => {
    delete process.env.INGESTION_BUCKET;

    const result = await provisionTenant('tenant-abc', 'Acme Health');

    expect(result.success).toBe(false);
    expect(result.error).toContain('INGESTION_BUCKET');
  });
});
