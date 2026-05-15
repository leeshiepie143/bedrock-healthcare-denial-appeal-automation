import { describe, it, expect } from 'vitest';
import {
  TABLE_DENIAL_APPEALS,
  TABLE_AUDIT_LOG,
  KEY_PREFIX,
  GSI,
  buildTenantPK,
  buildDenialSK,
  buildClassificationSK,
  buildEvidenceSK,
  buildViabilitySK,
  buildLetterSK,
  buildOutcomeSK,
  buildWorkflowSK,
  buildAuditPK,
  buildAuditSK,
  buildGSI1Keys,
  buildGSI2Keys,
  buildGSI3Keys,
  TABLE_SCHEMA,
} from '../../../src/shared/dynamodb';

describe('DynamoDB Constants', () => {
  it('defines table names', () => {
    expect(TABLE_DENIAL_APPEALS).toBe('DenialAppeals');
    expect(TABLE_AUDIT_LOG).toBe('AuditLog');
  });

  it('defines GSI names', () => {
    expect(GSI.GSI1).toBe('GSI1-ClaimId-Index');
    expect(GSI.GSI2).toBe('GSI2-PayerReason-Index');
    expect(GSI.GSI3).toBe('GSI3-WorkflowStatus-Index');
  });
});

describe('Key Builders', () => {
  describe('buildTenantPK', () => {
    it('builds tenant partition key', () => {
      expect(buildTenantPK('tenant-123')).toBe('TENANT#tenant-123');
    });
  });

  describe('buildDenialSK', () => {
    it('builds denial sort key with claim ID and format', () => {
      expect(buildDenialSK('CLM-001', 'pdf')).toBe('DENIAL#CLM-001#pdf');
      expect(buildDenialSK('CLM-002', 'edi_835')).toBe('DENIAL#CLM-002#edi_835');
    });
  });

  describe('buildClassificationSK', () => {
    it('builds classification sort key', () => {
      expect(buildClassificationSK('CLM-001')).toBe('CLASSIFICATION#CLM-001');
    });
  });

  describe('buildEvidenceSK', () => {
    it('builds evidence sort key', () => {
      expect(buildEvidenceSK('CLM-001')).toBe('EVIDENCE#CLM-001');
    });
  });

  describe('buildViabilitySK', () => {
    it('builds viability sort key', () => {
      expect(buildViabilitySK('CLM-001')).toBe('VIABILITY#CLM-001');
    });
  });

  describe('buildLetterSK', () => {
    it('builds letter sort key with version', () => {
      expect(buildLetterSK('CLM-001', 1)).toBe('LETTER#CLM-001#1');
      expect(buildLetterSK('CLM-001', 3)).toBe('LETTER#CLM-001#3');
    });
  });

  describe('buildOutcomeSK', () => {
    it('builds outcome sort key', () => {
      expect(buildOutcomeSK('CLM-001')).toBe('OUTCOME#CLM-001');
    });
  });

  describe('buildWorkflowSK', () => {
    it('builds workflow sort key', () => {
      expect(buildWorkflowSK('CLM-001')).toBe('WORKFLOW#CLM-001');
    });
  });

  describe('buildAuditPK', () => {
    it('builds audit partition key with tenant and date', () => {
      expect(buildAuditPK('tenant-123', '2024-01-15')).toBe('AUDIT#tenant-123#2024-01-15');
    });
  });

  describe('buildAuditSK', () => {
    it('builds audit sort key with timestamp and request ID', () => {
      expect(buildAuditSK('2024-01-15T10:30:00.123Z', 'req-abc')).toBe('2024-01-15T10:30:00.123Z#req-abc');
    });
  });
});

describe('GSI Key Builders', () => {
  describe('buildGSI1Keys', () => {
    it('builds GSI1 keys for claim ID lookup', () => {
      const keys = buildGSI1Keys('CLM-001', 'tenant-123');
      expect(keys.GSI1PK).toBe('CLM-001');
      expect(keys.GSI1SK).toBe('tenant-123');
    });
  });

  describe('buildGSI2Keys', () => {
    it('builds GSI2 keys for payer+reason outcome analytics', () => {
      const keys = buildGSI2Keys('PAY-001', 'CO-4', 'overturn');
      expect(keys.GSI2PK).toBe('PAY-001#CO-4');
      expect(keys.GSI2SK).toBe('overturn');
    });
  });

  describe('buildGSI3Keys', () => {
    it('builds GSI3 keys for workflow status monitoring', () => {
      const keys = buildGSI3Keys('in_progress', '2024-01-15T10:30:00Z');
      expect(keys.GSI3PK).toBe('in_progress');
      expect(keys.GSI3SK).toBe('2024-01-15T10:30:00Z');
    });
  });
});

describe('Table Schema', () => {
  it('defines DenialAppeals table with 3 GSIs', () => {
    const schema = TABLE_SCHEMA[TABLE_DENIAL_APPEALS];
    expect(schema.partitionKey.name).toBe('PK');
    expect(schema.sortKey.name).toBe('SK');
    expect(schema.globalSecondaryIndexes).toHaveLength(3);
    expect(schema.timeToLiveAttribute).toBe('ttl');
  });

  it('defines AuditLog table without GSIs', () => {
    const schema = TABLE_SCHEMA[TABLE_AUDIT_LOG];
    expect(schema.partitionKey.name).toBe('PK');
    expect(schema.sortKey.name).toBe('SK');
    expect(schema.globalSecondaryIndexes).toHaveLength(0);
    expect(schema.timeToLiveAttribute).toBeUndefined();
  });

  it('GSI1 uses claim_id as PK and tenant_id as SK', () => {
    const gsi1 = TABLE_SCHEMA[TABLE_DENIAL_APPEALS].globalSecondaryIndexes[0];
    expect(gsi1.indexName).toBe(GSI.GSI1);
    expect(gsi1.partitionKey.name).toBe('GSI1PK');
    expect(gsi1.sortKey.name).toBe('GSI1SK');
  });

  it('GSI2 uses payer+reason as PK and outcome_type as SK', () => {
    const gsi2 = TABLE_SCHEMA[TABLE_DENIAL_APPEALS].globalSecondaryIndexes[1];
    expect(gsi2.indexName).toBe(GSI.GSI2);
    expect(gsi2.partitionKey.name).toBe('GSI2PK');
    expect(gsi2.sortKey.name).toBe('GSI2SK');
  });

  it('GSI3 uses status as PK and started_at as SK', () => {
    const gsi3 = TABLE_SCHEMA[TABLE_DENIAL_APPEALS].globalSecondaryIndexes[2];
    expect(gsi3.indexName).toBe(GSI.GSI3);
    expect(gsi3.partitionKey.name).toBe('GSI3PK');
    expect(gsi3.sortKey.name).toBe('GSI3SK');
  });
});
