# Deployment Guide

## Prerequisites

| Requirement | Version |
|-------------|---------|
| AWS CDK | v2.170+ |
| Node.js | 20+ |
| Docker | Latest (for LocalStack) |
| AWS CLI | v2 |
| AWS Account | With Bedrock model access enabled |

### Bedrock Model Access

Enable access to the following models in your AWS account via the Bedrock console:
- `anthropic.claude-3-sonnet-20240229-v1:0` (classification + generation)
- `amazon.titan-embed-text-v2:0` (knowledge base embeddings, if using agentic mode)

### HealthLake Data Store

Create a HealthLake FHIR R4 data store in your account. Note the endpoint URL and data store ID for configuration.

## Deployment Steps

### 1. Clone and Install

```bash
git clone https://github.com/aws-samples/bedrock-healthcare-denial-appeal-automation.git
cd bedrock-healthcare-denial-appeal-automation
npm install
```

### 2. Configure Environment

```bash
export CDK_DEFAULT_ACCOUNT=<your-aws-account-id>
export CDK_DEFAULT_REGION=us-east-1
```

### 3. Bootstrap CDK (first time only)

```bash
cdk bootstrap aws://$CDK_DEFAULT_ACCOUNT/$CDK_DEFAULT_REGION
```

### 4. Deploy Core Infrastructure

```bash
cdk deploy DenialAppealAgentStack
```

This creates: DynamoDB tables, S3 buckets, KMS key, SNS topics, EventBridge bus, VPC with endpoints.

### 5. Deploy Guardrails

```bash
cdk deploy GuardrailsStack
```

Note the `GuardrailId` and `GuardrailVersion` outputs.

### 6. Deploy Orchestration Pipeline

```bash
cdk deploy OrchestrationStack
```

This creates: Step Functions state machine, Lambda functions, S3 event trigger, CloudWatch alarms.

### 7. Deploy API

```bash
cdk deploy ApiStack
```

This creates: API Gateway REST API, webhook delivery Lambda, EventBridge rules.

### 8. (Optional) Deploy Agentic Mode

```bash
cdk deploy AgentStack --context ENABLE_AGENTIC_MODE=true
```

### 9. Seed CARC/RARC Mapping Data

Load the CARC/RARC code reference into DynamoDB:

```bash
# Use the provided seed script (or load your own mappings)
npx ts-node scripts/seed-carc-mappings.ts
```

### 10. Configure HealthLake

Set the HealthLake environment variables on the Evidence Lambda:

```bash
aws lambda update-function-configuration \
  --function-name denial-appeal-evidence \
  --environment "Variables={HEALTHLAKE_ENDPOINT=<your-endpoint>,HEALTHLAKE_DATASTORE_ID=<your-id>}"
```

## Verification

```bash
# Upload a test denial document
aws s3 cp test-data/sample-denial.pdf s3://<ingestion-bucket>/tenants/test-tenant/incoming/

# Check Step Functions execution
aws stepfunctions list-executions --state-machine-arn <state-machine-arn>

# Query workflow status via API
curl -H "x-tenant-id: test-tenant" https://<api-url>/v1/workflows/<claim-id>/status
```

## Tear Down

```bash
cdk destroy --all
```

Note: Resources with `RemovalPolicy.RETAIN` (DynamoDB tables, S3 buckets, KMS keys) must be manually deleted.
