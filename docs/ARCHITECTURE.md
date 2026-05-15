# Architecture

## Overview

The Revenue Cycle Denial Appeal Agent is a serverless, event-driven architecture deployed entirely within the customer's AWS account. It processes denial notifications through a five-step pipeline orchestrated by AWS Step Functions, with each step implemented as an independent Lambda function.

## Design Principles

1. **Customer-owned deployment** — All infrastructure runs in the customer's AWS account under their BAA. No data egress to third-party services.
2. **Transparent pipeline** — Step Functions provides full observability into each workflow step with CloudWatch metrics and execution history.
3. **Multi-tenant from day one** — Tenant isolation via DynamoDB partition keys, S3 prefixes, and per-tenant KMS keys.
4. **Open and configurable** — Payer templates, CARC/RARC mappings, and scoring models are stored as versioned configuration.
5. **Outcome-driven improvement** — Statistical change detection on appeal outcomes feeds back into viability scoring.
6. **Infrastructure cost only** — No per-claim pricing. Customers pay for AWS resource consumption.

## Pipeline Flow

```
S3 Upload → EventBridge → Step Functions
                              │
                              ├─ 1. Ingestion (Textract / EDI Parser)
                              ├─ 2. Classification (Bedrock NLP / Structured)
                              ├─ 3. Evidence Retrieval (HealthLake + Comprehend Medical)
                              ├─ 4. Viability Assessment (Scoring Model)
                              └─ 5. Letter Generation (Bedrock + Guardrails)
```

Each step:
- Has a 120-second timeout
- Retries 3 times with exponential backoff (1s, 2s, 4s)
- Emits CloudWatch metrics (execution count, success/failure, latency percentiles)
- Preserves intermediate state on failure for manual intervention

## Data Model

Single DynamoDB table (`DenialAppeals`) with composite keys:

| Entity | PK | SK |
|--------|----|----|
| Denial Record | `TENANT#<id>` | `DENIAL#<claim_id>#<format>` |
| Classification | `TENANT#<id>` | `CLASSIFICATION#<claim_id>` |
| Evidence | `TENANT#<id>` | `EVIDENCE#<claim_id>` |
| Viability | `TENANT#<id>` | `VIABILITY#<claim_id>` |
| Appeal Letter | `TENANT#<id>` | `LETTER#<claim_id>#<version>` |
| Outcome | `TENANT#<id>` | `OUTCOME#<claim_id>` |
| Workflow | `TENANT#<id>` | `WORKFLOW#<claim_id>` |
| Tenant Config | `TENANT#<id>` | `CONFIG` |
| CARC Mapping | `CARC_MAP` | `CODE#<code>` |
| Metrics | `METRICS` | `AGGREGATE#<date>` or `LATEST` |
| Report | `REPORT` | `MONTHLY#<YYYY-MM>` |
| Regulatory Ref | `REG_REF` | `<type>#<code>` |

**GSIs:**
- GSI1: `claim_id` → `tenant_id` (cross-tenant claim lookup for admins)
- GSI2: `payer_id#denial_reason_code` → `outcome_type` (outcome analytics)
- GSI3: `status` → `started_at` (workflow monitoring)

## Multi-Tenant Isolation

```
Shared Infrastructure          Tenant-Specific Resources
─────────────────────          ─────────────────────────
API Gateway                    KMS Key (per tenant)
Step Functions                 S3 Prefix (tenants/<id>/)
Lambda Functions               DynamoDB PK (TENANT#<id>)
EventBridge                    HealthLake Data Store
CloudWatch                     Webhook Endpoint
```

Isolation is enforced at the data layer (DynamoDB PK prefix), encryption layer (per-tenant KMS), and application layer (auth middleware validates tenant scope on every request).

## Bedrock Guardrails

All Bedrock invocations pass through a guardrail configured with:
- **Content filters**: Hate, violence, sexual, misconduct (HIGH threshold)
- **Denied topics**: Financial advice, legal opinions, treatment recommendations
- **PII handling**: Mask SSN/credit cards, block unrelated patient identifiers
- **Contextual grounding**: Threshold 0.7 (grounding), 0.6 (relevance)

This ensures generated appeal letters contain only facts traceable to source evidence.

## Optional: Agentic Mode

When `ENABLE_AGENTIC_MODE=true`, a Bedrock Agent provides conversational access to the same pipeline functions via 6 action groups. A Knowledge Base (OpenSearch Serverless + Titan Embeddings) provides RAG over payer policies and regulatory documents.

The agent reuses all existing Lambda functions — no code duplication. It's a different orchestration layer (conversational AI) over the same business logic (deterministic pipeline).
