/**
 * Unit tests for Ingestion Handler
 *
 * Tests routing logic, quarantine flow, deduplication, SNS notifications,
 * and DynamoDB storage of valid Denial_Records.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  handler,
  determineProcessorType,
  getFileExtension,
  extractTenantId,
  isEDIContent,
  setClients,
  resetClients,
} from '@lambdas/ingestion/handler';
import type { S3Event } from 'aws-lambda';

// ─── Mock AWS SDK Clients ───────────────────────────────────────────────────

function createMockS3Client(responses: Record<string, unknown> = {}) {
  return {
    send: vi.fn().mockImplementation((command: { constructor: { name: string }; input?: Record<string, unknown> }) => {
      const commandName = command.constructor.name;
      if (responses[commandName]) {
        return Promise.resolve(responses[commandName]);
      }
      // Default responses
      if (commandName === 'GetObjectCommand') {
        return Promise.resolve({
          Body: {
            transformToString: () => Promise.resolve(responses['content'] || ''),
          },
        });
      }
      return Promise.resolve({});
    }),
  };
}

function createMockDynamoClient(existingItem: Record<string, unknown> | null = null) {
  return {
    send: vi.fn().mockImplementation((command: { constructor: { name: string } }) => {
      const commandName = command.constructor.name;
      if (commandName === 'GetCommand') {
        return Promise.resolve({ Item: existingItem });
      }
      if (commandName === 'PutCommand') {
        return Promise.resolve({});
      }
      return Promise.resolve({});
    }),
  };
}

function createMockSNSClient() {
  return {
    send: vi.fn().mockResolvedValue({ MessageId: 'test-message-id' }),
  };
}

// ─── Test Helpers ───────────────────────────────────────────────────────────

function buildS3Event(key: string, bucket = 'test-bucket', size = 1024): S3Event {
  return {
    Records: [
      {
        eventVersion: '2.1',
        eventSource: 'aws:s3',
        awsRegion: 'us-east-1',
        eventTime: '2024-01-01T00:00:00.000Z',
        eventName: 'ObjectCreated:Put',
        userIdentity: { principalId: 'test' },
        requestParameters: { sourceIPAddress: '127.0.0.1' },
        responseElements: {
          'x-amz-request-id': 'test-request-id',
          'x-amz-id-2': 'test-id-2',
        },
        s3: {
          s3SchemaVersion: '1.0',
          configurationId: 'test-config',
          bucket: {
            name: bucket,
            ownerIdentity: { principalId: 'test' },
            arn: `arn:aws:s3:::${bucket}`,
          },
          object: {
            key: encodeURIComponent(key).replace(/%2F/g, '/'),
            size,
            eTag: 'test-etag',
            sequencer: '0000000000000000',
          },
        },
      },
    ],
  };
}

// ─── Unit Tests: Routing Logic ──────────────────────────────────────────────

describe('determineProcessorType', () => {
  it('routes .edi files to EDI parser', () => {
    expect(determineProcessorType('tenants/t1/incoming/claim.edi')).toBe('edi');
  });

  it('routes .835 files to EDI parser', () => {
    expect(determineProcessorType('tenants/t1/incoming/remit.835')).toBe('edi');
  });

  it('routes .x12 files to EDI parser', () => {
    expect(determineProcessorType('tenants/t1/incoming/transaction.x12')).toBe('edi');
  });

  it('routes .pdf files to Textract', () => {
    expect(determineProcessorType('tenants/t1/incoming/denial.pdf')).toBe('textract');
  });

  it('routes .tiff files to Textract', () => {
    expect(determineProcessorType('tenants/t1/incoming/fax.tiff')).toBe('textract');
  });

  it('routes .tif files to Textract', () => {
    expect(determineProcessorType('tenants/t1/incoming/fax.tif')).toBe('textract');
  });

  it('routes .png files to Textract', () => {
    expect(determineProcessorType('tenants/t1/incoming/scan.png')).toBe('textract');
  });

  it('routes .jpeg files to Textract', () => {
    expect(determineProcessorType('tenants/t1/incoming/scan.jpeg')).toBe('textract');
  });

  it('routes .jpg files to Textract', () => {
    expect(determineProcessorType('tenants/t1/incoming/scan.jpg')).toBe('textract');
  });

  it('returns unsupported for unknown extensions', () => {
    expect(determineProcessorType('tenants/t1/incoming/file.docx')).toBe('unsupported');
  });

  it('returns unsupported for files with no extension', () => {
    expect(determineProcessorType('tenants/t1/incoming/noextension')).toBe('unsupported');
  });

  it('is case-insensitive for extensions', () => {
    expect(determineProcessorType('tenants/t1/incoming/claim.EDI')).toBe('edi');
    expect(determineProcessorType('tenants/t1/incoming/denial.PDF')).toBe('textract');
  });
});

// ─── Unit Tests: File Extension Extraction ──────────────────────────────────

describe('getFileExtension', () => {
  it('extracts extension from simple filename', () => {
    expect(getFileExtension('file.pdf')).toBe('.pdf');
  });

  it('extracts extension from path with directories', () => {
    expect(getFileExtension('tenants/t1/incoming/claim.edi')).toBe('.edi');
  });

  it('returns empty string for files without extension', () => {
    expect(getFileExtension('tenants/t1/incoming/noext')).toBe('');
  });

  it('handles multiple dots in filename', () => {
    expect(getFileExtension('tenants/t1/incoming/file.backup.pdf')).toBe('.pdf');
  });
});

// ─── Unit Tests: Tenant ID Extraction ───────────────────────────────────────

describe('extractTenantId', () => {
  it('extracts tenant_id from valid S3 key', () => {
    expect(extractTenantId('tenants/acme-health/incoming/denial.pdf')).toBe('acme-health');
  });

  it('handles tenant IDs with special characters', () => {
    expect(extractTenantId('tenants/tenant_123/incoming/file.edi')).toBe('tenant_123');
  });

  it('returns null for keys without tenant prefix', () => {
    expect(extractTenantId('uploads/file.pdf')).toBeNull();
  });

  it('returns null for keys with wrong structure', () => {
    expect(extractTenantId('tenants/file.pdf')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractTenantId('')).toBeNull();
  });
});

// ─── Unit Tests: EDI Content Detection ──────────────────────────────────────

describe('isEDIContent', () => {
  it('detects content starting with ISA', () => {
    expect(isEDIContent('ISA*00*          *00*')).toBe(true);
  });

  it('detects content with leading whitespace before ISA', () => {
    expect(isEDIContent('  ISA*00*          *00*')).toBe(true);
  });

  it('returns false for non-EDI content', () => {
    expect(isEDIContent('%PDF-1.4 some pdf content')).toBe(false);
  });

  it('returns false for empty content', () => {
    expect(isEDIContent('')).toBe(false);
  });
});

// ─── Integration Tests: Handler with Mocked Clients ─────────────────────────

describe('handler - quarantine unsupported format', () => {
  let mockS3: ReturnType<typeof createMockS3Client>;
  let mockDynamo: ReturnType<typeof createMockDynamoClient>;
  let mockSNS: ReturnType<typeof createMockSNSClient>;

  beforeEach(() => {
    process.env.TABLE_NAME = 'TestTable';
    process.env.SNS_TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789:test-topic';
    process.env.QUARANTINE_PREFIX = 'quarantine/';

    mockS3 = createMockS3Client({ content: 'not EDI content' });
    mockDynamo = createMockDynamoClient();
    mockSNS = createMockSNSClient();

    setClients({
      s3: mockS3 as unknown as import('@aws-sdk/client-s3').S3Client,
      dynamo: mockDynamo as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient,
      sns: mockSNS as unknown as import('@aws-sdk/client-sns').SNSClient,
    });
  });

  afterEach(() => {
    resetClients();
    delete process.env.TABLE_NAME;
    delete process.env.SNS_TOPIC_ARN;
    delete process.env.QUARANTINE_PREFIX;
  });

  it('quarantines documents with unsupported extensions', async () => {
    const event = buildS3Event('tenants/t1/incoming/file.docx');
    const result = await handler(event);

    expect(result.recordsQuarantined).toBe(1);
    expect(result.recordsStored).toBe(0);
    expect(result.errors[0].quarantined).toBe(true);
    expect(result.errors[0].error).toContain('Unsupported file format');
  });

  it('sends SNS notification when quarantining', async () => {
    const event = buildS3Event('tenants/t1/incoming/file.docx');
    await handler(event);

    // SNS should be called (CopyObject, DeleteObject, then SNS Publish)
    expect(mockSNS.send).toHaveBeenCalled();
  });

  it('quarantines documents when tenant_id cannot be extracted', async () => {
    const event = buildS3Event('uploads/file.pdf');
    const result = await handler(event);

    expect(result.recordsQuarantined).toBe(1);
    expect(result.errors[0].error).toContain('Missing tenant_id');
  });
});

describe('handler - duplicate detection', () => {
  let mockS3: ReturnType<typeof createMockS3Client>;
  let mockDynamo: ReturnType<typeof createMockDynamoClient>;
  let mockSNS: ReturnType<typeof createMockSNSClient>;

  beforeEach(() => {
    process.env.TABLE_NAME = 'TestTable';
    process.env.SNS_TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789:test-topic';
    process.env.QUARANTINE_PREFIX = 'quarantine/';
  });

  afterEach(() => {
    resetClients();
    delete process.env.TABLE_NAME;
    delete process.env.SNS_TOPIC_ARN;
    delete process.env.QUARANTINE_PREFIX;
  });

  it('skips processing when duplicate record exists', async () => {
    // EDI content that will parse successfully
    const ediContent = [
      'ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *230101*1200*^*00501*000000001*0*P*:~',
      'GS*HP*SENDER*RECEIVER*20230101*1200*1*X*005010X221A1~',
      'ST*835*0001~',
      'N1*PR*ACME INSURANCE*XV*PAY001~',
      'CLP*CLM123*1*500.00*350.00*0*12*PAT789~',
      'CAS*CO*45*150.00~',
      'DTM*232*20230101~',
      'SE*7*0001~',
      'GE*1*1~',
      'IEA*1*000000001~',
    ].join('');

    mockS3 = createMockS3Client({ content: ediContent });
    mockDynamo = createMockDynamoClient({ PK: 'TENANT#t1', SK: 'DENIAL#CLM123#edi_835' });
    mockSNS = createMockSNSClient();

    setClients({
      s3: mockS3 as unknown as import('@aws-sdk/client-s3').S3Client,
      dynamo: mockDynamo as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient,
      sns: mockSNS as unknown as import('@aws-sdk/client-sns').SNSClient,
    });

    const event = buildS3Event('tenants/t1/incoming/claim.edi');
    const result = await handler(event);

    expect(result.recordsDuplicate).toBe(1);
    expect(result.recordsStored).toBe(0);
  });
});

describe('handler - successful storage', () => {
  let mockS3: ReturnType<typeof createMockS3Client>;
  let mockDynamo: ReturnType<typeof createMockDynamoClient>;
  let mockSNS: ReturnType<typeof createMockSNSClient>;

  beforeEach(() => {
    process.env.TABLE_NAME = 'TestTable';
    process.env.SNS_TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789:test-topic';
    process.env.QUARANTINE_PREFIX = 'quarantine/';
  });

  afterEach(() => {
    resetClients();
    delete process.env.TABLE_NAME;
    delete process.env.SNS_TOPIC_ARN;
    delete process.env.QUARANTINE_PREFIX;
  });

  it('stores valid EDI 835 record in DynamoDB', async () => {
    const ediContent = [
      'ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *230101*1200*^*00501*000000001*0*P*:~',
      'GS*HP*SENDER*RECEIVER*20230101*1200*1*X*005010X221A1~',
      'ST*835*0001~',
      'N1*PR*ACME INSURANCE*XV*PAY001~',
      'CLP*CLM123*1*500.00*350.00*0*12*PAT789~',
      'CAS*CO*45*150.00~',
      'DTM*232*20230101~',
      'SE*7*0001~',
      'GE*1*1~',
      'IEA*1*000000001~',
    ].join('');

    mockS3 = createMockS3Client({ content: ediContent });
    mockDynamo = createMockDynamoClient(null); // No existing record
    mockSNS = createMockSNSClient();

    setClients({
      s3: mockS3 as unknown as import('@aws-sdk/client-s3').S3Client,
      dynamo: mockDynamo as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient,
      sns: mockSNS as unknown as import('@aws-sdk/client-sns').SNSClient,
    });

    const event = buildS3Event('tenants/t1/incoming/claim.edi');
    const result = await handler(event);

    expect(result.recordsStored).toBe(1);
    expect(result.recordsQuarantined).toBe(0);
    expect(result.success).toBe(true);

    // Verify PutCommand was called
    const putCalls = mockDynamo.send.mock.calls.filter(
      (call: unknown[]) => (call[0] as { constructor: { name: string } }).constructor.name === 'PutCommand'
    );
    expect(putCalls.length).toBe(1);
  });

  it('quarantines EDI with missing mandatory fields', async () => {
    // EDI content missing patient_id (CLP07 not present)
    const ediContent = [
      'ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *230101*1200*^*00501*000000001*0*P*:~',
      'GS*HP*SENDER*RECEIVER*20230101*1200*1*X*005010X221A1~',
      'ST*835*0001~',
      'N1*PR*ACME INSURANCE*XV*PAY001~',
      'CLP*CLM123*1*500.00*350.00~',
      'CAS*CO*45*150.00~',
      'DTM*232*20230101~',
      'SE*7*0001~',
      'GE*1*1~',
      'IEA*1*000000001~',
    ].join('');

    mockS3 = createMockS3Client({ content: ediContent });
    mockDynamo = createMockDynamoClient(null);
    mockSNS = createMockSNSClient();

    setClients({
      s3: mockS3 as unknown as import('@aws-sdk/client-s3').S3Client,
      dynamo: mockDynamo as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient,
      sns: mockSNS as unknown as import('@aws-sdk/client-sns').SNSClient,
    });

    const event = buildS3Event('tenants/t1/incoming/claim.edi');
    const result = await handler(event);

    expect(result.recordsQuarantined).toBe(1);
    expect(result.recordsStored).toBe(0);
    expect(result.errors[0].error).toContain('Missing mandatory fields');
  });
});

describe('handler - content-based EDI detection', () => {
  let mockS3: ReturnType<typeof createMockS3Client>;
  let mockDynamo: ReturnType<typeof createMockDynamoClient>;
  let mockSNS: ReturnType<typeof createMockSNSClient>;

  beforeEach(() => {
    process.env.TABLE_NAME = 'TestTable';
    process.env.SNS_TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789:test-topic';
    process.env.QUARANTINE_PREFIX = 'quarantine/';
  });

  afterEach(() => {
    resetClients();
    delete process.env.TABLE_NAME;
    delete process.env.SNS_TOPIC_ARN;
    delete process.env.QUARANTINE_PREFIX;
  });

  it('detects EDI content from file without recognized extension', async () => {
    const ediContent = [
      'ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *230101*1200*^*00501*000000001*0*P*:~',
      'GS*HP*SENDER*RECEIVER*20230101*1200*1*X*005010X221A1~',
      'ST*835*0001~',
      'N1*PR*ACME INSURANCE*XV*PAY001~',
      'CLP*CLM123*1*500.00*350.00*0*12*PAT789~',
      'CAS*CO*45*150.00~',
      'DTM*232*20230101~',
      'SE*7*0001~',
      'GE*1*1~',
      'IEA*1*000000001~',
    ].join('');

    // Mock S3 to return EDI content for both snippet and full read
    mockS3 = {
      send: vi.fn().mockImplementation(() => {
        return Promise.resolve({
          Body: {
            transformToString: () => Promise.resolve(ediContent),
          },
        });
      }),
    } as unknown as ReturnType<typeof createMockS3Client>;

    mockDynamo = createMockDynamoClient(null);
    mockSNS = createMockSNSClient();

    setClients({
      s3: mockS3 as unknown as import('@aws-sdk/client-s3').S3Client,
      dynamo: mockDynamo as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient,
      sns: mockSNS as unknown as import('@aws-sdk/client-sns').SNSClient,
    });

    const event = buildS3Event('tenants/t1/incoming/claim.dat');
    const result = await handler(event);

    // Should process as EDI, not quarantine as unsupported
    expect(result.recordsStored).toBe(1);
    expect(result.recordsQuarantined).toBe(0);
  });
});

describe('handler - multiple records in event', () => {
  let mockSNS: ReturnType<typeof createMockSNSClient>;

  beforeEach(() => {
    process.env.TABLE_NAME = 'TestTable';
    process.env.SNS_TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789:test-topic';
    process.env.QUARANTINE_PREFIX = 'quarantine/';
  });

  afterEach(() => {
    resetClients();
    delete process.env.TABLE_NAME;
    delete process.env.SNS_TOPIC_ARN;
    delete process.env.QUARANTINE_PREFIX;
  });

  it('processes multiple records and reports correct counts', async () => {
    const mockS3 = createMockS3Client({ content: 'not EDI' });
    const mockDynamo = createMockDynamoClient(null);
    mockSNS = createMockSNSClient();

    setClients({
      s3: mockS3 as unknown as import('@aws-sdk/client-s3').S3Client,
      dynamo: mockDynamo as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient,
      sns: mockSNS as unknown as import('@aws-sdk/client-sns').SNSClient,
    });

    // Build event with 2 unsupported files
    const event = buildS3Event('tenants/t1/incoming/file1.docx');
    event.Records.push({
      ...event.Records[0],
      s3: {
        ...event.Records[0].s3,
        object: {
          ...event.Records[0].s3.object,
          key: 'tenants/t1/incoming/file2.xlsx',
        },
      },
    });

    const result = await handler(event);

    expect(result.recordsProcessed).toBe(2);
    expect(result.recordsQuarantined).toBe(2);
  });
});
