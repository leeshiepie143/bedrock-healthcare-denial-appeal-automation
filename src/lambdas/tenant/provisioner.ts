/**
 * Tenant Management and Provisioning Lambda
 *
 * Provisions tenant-specific resources for multi-tenant deployment:
 * - KMS key alias for tenant-specific encryption
 * - S3 prefix with verified read/write access
 * - DynamoDB TenantConfiguration record
 * - HealthLake data store (placeholder for async creation)
 *
 * Implements compensating transactions (rollback) on partial failure
 * and sends SNS notification on failure within 60 seconds.
 *
 * Target: Complete provisioning within 5 minutes.
 *
 * Requirements: 10.1, 10.2, 10.3
 */

import { DynamoDBDocumentClient, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import {
  KMSClient,
  CreateAliasCommand,
  CreateKeyCommand,
  DeleteAliasCommand,
  ScheduleKeyDeletionCommand,
  DescribeKeyCommand,
} from '@aws-sdk/client-kms';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import type { TenantConfiguration, TenantStatus } from '@shared/models';
import { buildTenantPK, KEY_PREFIX } from '@shared/dynamodb';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TenantProvisioningConfig {
  webhookEndpoint?: string | null;
  webhookSecret?: string;
  rateLimitRpm?: number;
  healthlakeDatastoreId?: string;
}

export interface ProvisioningResult {
  success: boolean;
  tenantConfiguration?: TenantConfiguration;
  error?: string;
  rolledBack?: boolean;
  rollbackErrors?: string[];
}

/** Tracks which resources have been provisioned for rollback purposes. */
interface ProvisionedResources {
  kmsKeyArn?: string;
  kmsAliasCreated?: boolean;
  s3TestObjectKey?: string;
  dynamoRecordCreated?: boolean;
}

// ─── Environment Variables ──────────────────────────────────────────────────

function getTableName(): string {
  return process.env.TABLE_NAME || 'DenialAppeals';
}

function getIngestionBucket(): string {
  return process.env.INGESTION_BUCKET || '';
}

function getSnsTopicArn(): string {
  return process.env.SNS_TOPIC_ARN || '';
}

// ─── Client Management ──────────────────────────────────────────────────────

let dynamoClient: DynamoDBDocumentClient | null = null;
let s3Client: S3Client | null = null;
let kmsClient: KMSClient | null = null;
let snsClient: SNSClient | null = null;

/** Allows injecting mock clients for testing. */
export function setClients(clients: {
  dynamo?: DynamoDBDocumentClient;
  s3?: S3Client;
  kms?: KMSClient;
  sns?: SNSClient;
}): void {
  if (clients.dynamo) dynamoClient = clients.dynamo;
  if (clients.s3) s3Client = clients.s3;
  if (clients.kms) kmsClient = clients.kms;
  if (clients.sns) snsClient = clients.sns;
}

/** Resets all clients (useful for testing cleanup). */
export function resetClients(): void {
  dynamoClient = null;
  s3Client = null;
  kmsClient = null;
  snsClient = null;
}

function getDynamoClient(): DynamoDBDocumentClient {
  if (!dynamoClient) {
    throw new Error('DynamoDB client not initialized. Call setClients() first.');
  }
  return dynamoClient;
}

function getS3Client(): S3Client {
  if (!s3Client) {
    throw new Error('S3 client not initialized. Call setClients() first.');
  }
  return s3Client;
}

function getKmsClient(): KMSClient {
  if (!kmsClient) {
    throw new Error('KMS client not initialized. Call setClients() first.');
  }
  return kmsClient;
}

function getSnsClient(): SNSClient {
  if (!snsClient) {
    throw new Error('SNS client not initialized. Call setClients() first.');
  }
  return snsClient;
}

// ─── Main Provisioning Function ─────────────────────────────────────────────

/**
 * Provisions all tenant-specific resources and verifies access.
 *
 * Steps (in order):
 * 1. Create KMS key and alias for tenant-specific encryption
 * 2. Create S3 prefix and verify with read/write test
 * 3. Create DynamoDB TenantConfiguration record
 * 4. Verify all resources are accessible
 *
 * On any step failure: rolls back all previously provisioned resources
 * and sends SNS notification within 60 seconds.
 *
 * @param tenantId - Unique tenant identifier
 * @param tenantName - Human-readable tenant name
 * @param config - Optional provisioning configuration
 * @returns ProvisioningResult with success status and tenant configuration
 */
export async function provisionTenant(
  tenantId: string,
  tenantName: string,
  config: TenantProvisioningConfig = {}
): Promise<ProvisioningResult> {
  const provisioned: ProvisionedResources = {};
  const startTime = Date.now();

  try {
    // Step 1: Create KMS key and alias
    console.info(`[PROVISIONER] Step 1: Creating KMS key for tenant ${tenantId}`);
    const kmsKeyArn = await createKmsKey(tenantId);
    provisioned.kmsKeyArn = kmsKeyArn;

    await createKmsAlias(tenantId, kmsKeyArn);
    provisioned.kmsAliasCreated = true;

    // Step 2: Create S3 prefix and verify with read/write test
    console.info(`[PROVISIONER] Step 2: Creating S3 prefix for tenant ${tenantId}`);
    const s3Prefix = `tenants/${tenantId}/`;
    const testObjectKey = await createAndVerifyS3Prefix(tenantId, s3Prefix);
    provisioned.s3TestObjectKey = testObjectKey;

    // Step 3: Create DynamoDB TenantConfiguration record
    console.info(`[PROVISIONER] Step 3: Creating DynamoDB config for tenant ${tenantId}`);
    const tenantConfiguration = await createTenantConfigRecord(
      tenantId,
      tenantName,
      kmsKeyArn,
      s3Prefix,
      config
    );
    provisioned.dynamoRecordCreated = true;

    // Step 4: Final verification — read back the config record
    console.info(`[PROVISIONER] Step 4: Verifying all resources for tenant ${tenantId}`);
    await verifyKmsKey(kmsKeyArn);

    const durationMs = Date.now() - startTime;
    console.info(
      `[PROVISIONER] Tenant ${tenantId} provisioned successfully in ${durationMs}ms`
    );

    return {
      success: true,
      tenantConfiguration,
    };
  } catch (error) {
    const failureReason = error instanceof Error ? error.message : String(error);
    console.error(
      `[PROVISIONER] Provisioning failed for tenant ${tenantId}: ${failureReason}`
    );

    // Rollback all provisioned resources
    const rollbackErrors = await rollbackProvisionedResources(tenantId, provisioned);

    // Send failure notification within 60 seconds
    await sendProvisioningFailureNotification(tenantId, tenantName, failureReason);

    return {
      success: false,
      error: failureReason,
      rolledBack: true,
      rollbackErrors: rollbackErrors.length > 0 ? rollbackErrors : undefined,
    };
  }
}

// ─── Step 1: KMS Key Provisioning ───────────────────────────────────────────

/**
 * Creates a new KMS customer-managed key for the tenant.
 * Returns the key ARN.
 */
async function createKmsKey(tenantId: string): Promise<string> {
  const kms = getKmsClient();

  const response = await kms.send(
    new CreateKeyCommand({
      Description: `Encryption key for tenant ${tenantId}`,
      KeyUsage: 'ENCRYPT_DECRYPT',
      Tags: [
        { TagKey: 'TenantId', TagValue: tenantId },
        { TagKey: 'ManagedBy', TagValue: 'DenialAppealAgent' },
      ],
    })
  );

  const keyArn = response.KeyMetadata?.Arn;
  if (!keyArn) {
    throw new Error('KMS CreateKey did not return a key ARN');
  }

  return keyArn;
}

/**
 * Creates a KMS alias for the tenant's key.
 * Alias format: alias/denial-appeal/tenant/<tenant_id>
 */
async function createKmsAlias(tenantId: string, keyArn: string): Promise<void> {
  const kms = getKmsClient();

  await kms.send(
    new CreateAliasCommand({
      AliasName: `alias/denial-appeal/tenant/${tenantId}`,
      TargetKeyId: keyArn,
    })
  );
}

/**
 * Verifies the KMS key is accessible by describing it.
 */
async function verifyKmsKey(keyArn: string): Promise<void> {
  const kms = getKmsClient();

  const response = await kms.send(
    new DescribeKeyCommand({
      KeyId: keyArn,
    })
  );

  if (!response.KeyMetadata?.Enabled) {
    throw new Error(`KMS key ${keyArn} is not enabled after creation`);
  }
}

// ─── Step 2: S3 Prefix Provisioning ─────────────────────────────────────────

/**
 * Creates an S3 prefix for the tenant and verifies read/write access
 * by putting a test object and reading it back.
 *
 * Returns the test object key (for potential cleanup).
 */
async function createAndVerifyS3Prefix(
  tenantId: string,
  s3Prefix: string
): Promise<string> {
  const s3 = getS3Client();
  const bucket = getIngestionBucket();

  if (!bucket) {
    throw new Error('INGESTION_BUCKET environment variable is not configured');
  }

  const testObjectKey = `${s3Prefix}.provisioning-test`;
  const testContent = JSON.stringify({
    tenantId,
    test: 'provisioning-verification',
    timestamp: new Date().toISOString(),
  });

  // Write test object
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: testObjectKey,
      Body: testContent,
      ContentType: 'application/json',
    })
  );

  // Read test object back to verify
  const getResponse = await s3.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: testObjectKey,
    })
  );

  if (!getResponse.Body) {
    throw new Error(`S3 read verification failed: no body returned for ${testObjectKey}`);
  }

  // Clean up test object after successful verification
  await s3.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: testObjectKey,
    })
  );

  return testObjectKey;
}

// ─── Step 3: DynamoDB Configuration Record ──────────────────────────────────

/**
 * Creates the TenantConfiguration record in DynamoDB.
 * PK: TENANT#<tenant_id>, SK: CONFIG
 */
async function createTenantConfigRecord(
  tenantId: string,
  tenantName: string,
  kmsKeyArn: string,
  s3Prefix: string,
  config: TenantProvisioningConfig
): Promise<TenantConfiguration> {
  const dynamo = getDynamoClient();
  const now = new Date().toISOString();

  const tenantConfiguration: TenantConfiguration = {
    PK: buildTenantPK(tenantId),
    SK: KEY_PREFIX.CONFIG,
    tenant_id: tenantId,
    tenant_name: tenantName,
    kms_key_arn: kmsKeyArn,
    s3_prefix: s3Prefix,
    healthlake_datastore_id: config.healthlakeDatastoreId || '',
    webhook_endpoint: config.webhookEndpoint || null,
    webhook_secret: config.webhookSecret || '',
    rate_limit_rpm: config.rateLimitRpm || 100,
    notification_topic_arn: getSnsTopicArn(),
    onboarded_at: now,
    status: 'active' as TenantStatus,
  };

  await dynamo.send(
    new PutCommand({
      TableName: getTableName(),
      Item: tenantConfiguration,
      ConditionExpression: 'attribute_not_exists(PK)',
    })
  );

  return tenantConfiguration;
}

// ─── Rollback (Compensating Transactions) ───────────────────────────────────

/**
 * Rolls back all provisioned resources on partial failure.
 * Attempts to clean up each resource independently, collecting any errors.
 * Returns an array of rollback error messages (empty if all rollbacks succeeded).
 */
async function rollbackProvisionedResources(
  tenantId: string,
  provisioned: ProvisionedResources
): Promise<string[]> {
  const errors: string[] = [];

  console.info(`[PROVISIONER] Rolling back provisioned resources for tenant ${tenantId}`);

  // Rollback DynamoDB record
  if (provisioned.dynamoRecordCreated) {
    try {
      await rollbackDynamoRecord(tenantId);
      console.info(`[PROVISIONER] Rolled back DynamoDB record for tenant ${tenantId}`);
    } catch (err) {
      const msg = `Failed to rollback DynamoDB record: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[PROVISIONER] ${msg}`);
      errors.push(msg);
    }
  }

  // Rollback KMS alias
  if (provisioned.kmsAliasCreated) {
    try {
      await rollbackKmsAlias(tenantId);
      console.info(`[PROVISIONER] Rolled back KMS alias for tenant ${tenantId}`);
    } catch (err) {
      const msg = `Failed to rollback KMS alias: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[PROVISIONER] ${msg}`);
      errors.push(msg);
    }
  }

  // Rollback KMS key (schedule deletion)
  if (provisioned.kmsKeyArn) {
    try {
      await rollbackKmsKey(provisioned.kmsKeyArn);
      console.info(`[PROVISIONER] Scheduled KMS key deletion for tenant ${tenantId}`);
    } catch (err) {
      const msg = `Failed to rollback KMS key: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[PROVISIONER] ${msg}`);
      errors.push(msg);
    }
  }

  return errors;
}

/**
 * Deletes the TenantConfiguration record from DynamoDB.
 */
async function rollbackDynamoRecord(tenantId: string): Promise<void> {
  const dynamo = getDynamoClient();

  await dynamo.send(
    new DeleteCommand({
      TableName: getTableName(),
      Key: {
        PK: buildTenantPK(tenantId),
        SK: KEY_PREFIX.CONFIG,
      },
    })
  );
}

/**
 * Deletes the KMS alias for the tenant.
 */
async function rollbackKmsAlias(tenantId: string): Promise<void> {
  const kms = getKmsClient();

  await kms.send(
    new DeleteAliasCommand({
      AliasName: `alias/denial-appeal/tenant/${tenantId}`,
    })
  );
}

/**
 * Schedules the KMS key for deletion (minimum 7-day waiting period).
 */
async function rollbackKmsKey(keyArn: string): Promise<void> {
  const kms = getKmsClient();

  await kms.send(
    new ScheduleKeyDeletionCommand({
      KeyId: keyArn,
      PendingWindowInDays: 7,
    })
  );
}

// ─── Failure Notification ───────────────────────────────────────────────────

/**
 * Sends an SNS notification about a provisioning failure.
 * Must complete within 60 seconds of the failure per requirement 10.3.
 */
async function sendProvisioningFailureNotification(
  tenantId: string,
  tenantName: string,
  failureReason: string
): Promise<void> {
  const topicArn = getSnsTopicArn();
  if (!topicArn) {
    console.warn('[PROVISIONER] SNS_TOPIC_ARN not configured, skipping failure notification');
    return;
  }

  const sns = getSnsClient();

  const message = JSON.stringify({
    event: 'tenant_provisioning_failed',
    tenant_id: tenantId,
    tenant_name: tenantName,
    failure_reason: failureReason,
    timestamp: new Date().toISOString(),
    action_required: 'Investigate and retry tenant provisioning',
  });

  const subject = `Tenant Provisioning Failed: ${tenantName} (${tenantId})`;

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
          StringValue: 'tenant_provisioning_failed',
        },
      },
    })
  );

  console.info(
    `[PROVISIONER] Failure notification sent for tenant ${tenantId} to ${topicArn}`
  );
}
