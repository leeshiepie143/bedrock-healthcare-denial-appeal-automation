import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as events from 'aws-cdk-lib/aws-events';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

/**
 * Main CDK stack for the Revenue Cycle Denial Appeal Agent.
 * Defines shared infrastructure: DynamoDB tables, S3 buckets, KMS CMK,
 * SNS topics, EventBridge event bus, and VPC with endpoints.
 */
export class DenialAppealAgentStack extends cdk.Stack {
  /** KMS Customer Managed Key for all encryption */
  public readonly encryptionKey: kms.Key;

  /** DynamoDB DenialAppeals table (single-table design) */
  public readonly denialAppealsTable: dynamodb.Table;

  /** DynamoDB AuditLog table */
  public readonly auditLogTable: dynamodb.Table;

  /** S3 bucket for incoming denial documents */
  public readonly ingestionBucket: s3.Bucket;

  /** S3 bucket for processed documents */
  public readonly documentsBucket: s3.Bucket;

  /** S3 bucket for generated appeal letters */
  public readonly appealLettersBucket: s3.Bucket;

  /** SNS topic for denial notifications */
  public readonly denialNotificationsTopic: sns.Topic;

  /** SNS topic for appeal alerts */
  public readonly appealAlertsTopic: sns.Topic;

  /** EventBridge custom event bus */
  public readonly eventBus: events.EventBus;

  /** VPC for private networking */
  public readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Tags applied to all resources in this stack
    cdk.Tags.of(this).add('Project', 'DenialAppealAgent');
    cdk.Tags.of(this).add('ManagedBy', 'CDK');

    // ─── KMS Customer Managed Key ───────────────────────────────────────
    this.encryptionKey = new kms.Key(this, 'EncryptionKey', {
      alias: 'denial-appeal-agent',
      description: 'CMK for Revenue Cycle Denial Appeal Agent encryption',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ─── DynamoDB Tables ────────────────────────────────────────────────

    // DenialAppeals table — single-table design
    this.denialAppealsTable = new dynamodb.Table(this, 'DenialAppealsTable', {
      tableName: 'DenialAppeals',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.encryptionKey,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // GSI1: claim_id (PK), tenant_id (SK) — for claim lookup
    this.denialAppealsTable.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'claim_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'tenant_id', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI2: payer_reason (PK: `${payer_id}#${denial_reason_code}`), outcome_type (SK) — for analytics
    this.denialAppealsTable.addGlobalSecondaryIndex({
      indexName: 'GSI2',
      partitionKey: { name: 'payer_reason', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'outcome_type', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI3: status (PK), started_at (SK) — for workflow monitoring
    this.denialAppealsTable.addGlobalSecondaryIndex({
      indexName: 'GSI3',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'started_at', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // AuditLog table — immutable audit trail
    this.auditLogTable = new dynamodb.Table(this, 'AuditLogTable', {
      tableName: 'AuditLog',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.encryptionKey,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      // No TTL — 7-year retention requirement
    });

    // ─── S3 Buckets ─────────────────────────────────────────────────────

    const lifecycleRules: s3.LifecycleRule[] = [
      {
        id: 'GlacierTiering',
        enabled: true,
        transitions: [
          {
            storageClass: s3.StorageClass.GLACIER,
            transitionAfter: cdk.Duration.days(365), // 1 year
          },
          {
            storageClass: s3.StorageClass.DEEP_ARCHIVE,
            transitionAfter: cdk.Duration.days(1095), // 3 years
          },
        ],
        expiration: cdk.Duration.days(2555), // 7 years
      },
    ];

    // Ingestion bucket — incoming denial documents
    this.ingestionBucket = new s3.Bucket(this, 'IngestionBucket', {
      bucketName: cdk.Fn.sub('denial-ingestion-${AWS::AccountId}-${AWS::Region}'),
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.encryptionKey,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      enforceSSL: true,
    });

    // Documents bucket — processed documents
    this.documentsBucket = new s3.Bucket(this, 'DocumentsBucket', {
      bucketName: cdk.Fn.sub('denial-documents-${AWS::AccountId}-${AWS::Region}'),
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.encryptionKey,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      enforceSSL: true,
    });

    // Appeal letters bucket — generated appeal letters
    this.appealLettersBucket = new s3.Bucket(this, 'AppealLettersBucket', {
      bucketName: cdk.Fn.sub('appeal-letters-${AWS::AccountId}-${AWS::Region}'),
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.encryptionKey,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      enforceSSL: true,
    });

    // ─── SNS Topics ─────────────────────────────────────────────────────

    this.denialNotificationsTopic = new sns.Topic(this, 'DenialNotificationsTopic', {
      topicName: 'denial-notifications',
      masterKey: this.encryptionKey,
    });

    this.appealAlertsTopic = new sns.Topic(this, 'AppealAlertsTopic', {
      topicName: 'appeal-alerts',
      masterKey: this.encryptionKey,
    });

    // ─── EventBridge Custom Event Bus ───────────────────────────────────

    this.eventBus = new events.EventBus(this, 'DenialAppealEventBus', {
      eventBusName: 'denial-appeal-events',
    });

    // ─── VPC and Endpoints ──────────────────────────────────────────────

    this.vpc = new ec2.Vpc(this, 'DenialAppealVpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    });

    // S3 Gateway Endpoint
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    // DynamoDB Gateway Endpoint
    this.vpc.addGatewayEndpoint('DynamoDBEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    });

    // Bedrock Interface Endpoint
    this.vpc.addInterfaceEndpoint('BedrockEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME,
      privateDnsEnabled: true,
    });

    // Comprehend Interface Endpoint
    this.vpc.addInterfaceEndpoint('ComprehendEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.COMPREHEND,
      privateDnsEnabled: true,
    });

    // Textract Interface Endpoint
    this.vpc.addInterfaceEndpoint('TextractEndpoint', {
      service: new ec2.InterfaceVpcEndpointService(
        `com.amazonaws.${this.region}.textract`
      ),
      privateDnsEnabled: true,
    });

    // ─── Stack Outputs ──────────────────────────────────────────────────

    new cdk.CfnOutput(this, 'EncryptionKeyArn', {
      value: this.encryptionKey.keyArn,
      description: 'KMS CMK ARN for encryption',
    });

    new cdk.CfnOutput(this, 'DenialAppealsTableName', {
      value: this.denialAppealsTable.tableName,
      description: 'DenialAppeals DynamoDB table name',
    });

    new cdk.CfnOutput(this, 'AuditLogTableName', {
      value: this.auditLogTable.tableName,
      description: 'AuditLog DynamoDB table name',
    });

    new cdk.CfnOutput(this, 'IngestionBucketName', {
      value: this.ingestionBucket.bucketName,
      description: 'S3 bucket for denial document ingestion',
    });

    new cdk.CfnOutput(this, 'DocumentsBucketName', {
      value: this.documentsBucket.bucketName,
      description: 'S3 bucket for processed documents',
    });

    new cdk.CfnOutput(this, 'AppealLettersBucketName', {
      value: this.appealLettersBucket.bucketName,
      description: 'S3 bucket for generated appeal letters',
    });

    new cdk.CfnOutput(this, 'EventBusName', {
      value: this.eventBus.eventBusName,
      description: 'EventBridge custom event bus name',
    });

    new cdk.CfnOutput(this, 'VpcId', {
      value: this.vpc.vpcId,
      description: 'VPC ID for the denial appeal agent',
    });
  }
}
