# Bedrock Healthcare Denial Appeal Automation

An AWS-native, open reference architecture that automates the end-to-end healthcare denial appeal workflow using Amazon Bedrock, Textract, Comprehend Medical, HealthLake, and Step Functions.

## The Gap We're Filling

Healthcare providers lose **$19.7 billion annually** fighting denied claims, yet **54% get overturned on appeal**. The appeal process is manual, time-consuming, and requires deep clinical and regulatory knowledge. Existing solutions (Waystar, AKASA, CombineHealth) are all **proprietary SaaS platforms** — closed systems where your PHI leaves your environment, you pay per-claim fees, and you can't customize the logic.

**No one has published an open, deployable-in-your-own-account AWS architecture for denial appeal automation.** Until now.

## What Makes This Different

| Existing Solutions | This Architecture |
|---|---|
| Proprietary SaaS — data leaves your environment | Deploys in **your own AWS account** — PHI never leaves your VPC |
| Black-box AI, can't inspect reasoning | **Transparent pipeline** with Step Functions observability |
| Per-claim pricing ($5-25/claim) | **Infrastructure cost only** — pay for AWS resource consumption |
| Vendor lock-in, no customization | **Open architecture** — payer templates, scoring models, and prompts are all configurable |
| Single-tenant only | **Multi-tenant ISV-ready** from day one with tenant isolation |
| No feedback loop transparency | **Outcome tracking** with statistical change detection built in |
| No hallucination prevention guarantees | **Bedrock Guardrails** with contextual grounding for clinical accuracy |

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Customer AWS Account (VPC)                        │
│                                                                       │
│  ┌──────────┐   ┌──────────────┐   ┌───────────────┐                │
│  │ S3       │──▶│ Step Functions│──▶│ DynamoDB      │                │
│  │ Ingestion│   │ Pipeline     │   │ Single-Table  │                │
│  └──────────┘   └──────┬───────┘   └───────────────┘                │
│                         │                                             │
│         ┌───────────────┼───────────────────────┐                    │
│         ▼               ▼               ▼       ▼                    │
│  ┌────────────┐  ┌────────────┐  ┌──────────┐  ┌──────────────┐    │
│  │ Textract   │  │ Bedrock    │  │HealthLake│  │ Comprehend   │    │
│  │ OCR        │  │ + Guardrails│  │ FHIR R4  │  │ Medical      │    │
│  └────────────┘  └────────────┘  └──────────┘  └──────────────┘    │
│                                                                       │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ Optional: Bedrock Agent (conversational mode)                 │   │
│  │ Knowledge Base: Payer policies, LCD/NCD docs, CARC reference  │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

## Pipeline Steps

1. **Denial Document Ingestion** — Parses PDF, fax images (Textract OCR), and EDI 835/277 transactions into standardized denial records
2. **Denial Reason Classification** — Maps free-text denial reasons to CARC/RARC codes using Bedrock NLP (structured EDI codes extracted directly)
3. **Clinical Evidence Retrieval** — Queries HealthLake FHIR R4 for patient records, extracts medical entities with Comprehend Medical, scores relevance
4. **Appeal Viability Assessment** — Calculates overturn probability using weighted scoring model with Wilson confidence intervals, monthly recalibration
5. **Appeal Letter Generation** — Produces payer-specific appeal letters with Bedrock, grounded citations, regulatory references, and hallucination prevention via Guardrails
6. **Outcome Tracking** — Records results, calculates aggregate metrics, detects statistical changes (chi-squared test), generates monthly reports

## AWS Services Used

| Service | Role |
|---------|------|
| **Amazon Bedrock** (Claude) | Denial classification, appeal letter generation, external letter parsing |
| **Amazon Bedrock Guardrails** | Hallucination prevention, PII masking, content safety, contextual grounding |
| **Amazon Textract** | OCR and text extraction from PDF/fax denial letters |
| **Amazon Comprehend Medical** | Medical entity extraction (diagnoses, procedures, medications) |
| **AWS HealthLake** | FHIR R4 clinical data repository for evidence retrieval |
| **AWS Step Functions** | Workflow orchestration with retry/backoff/timeout |
| **Amazon DynamoDB** | Single-table design for all data (denial records, outcomes, metrics) |
| **Amazon S3** | Document storage with 7-year lifecycle (Glacier tiering) |
| **Amazon API Gateway** | RESTful API with IAM auth and rate limiting |
| **AWS KMS** | Customer-managed encryption keys (per-tenant) |
| **Amazon EventBridge** | Event routing, scheduled jobs, webhook triggers |
| **Amazon SNS** | Notifications for failures, manual review, and alerts |
| **Amazon Bedrock Agents** *(optional)* | Conversational agentic mode with Knowledge Base |

## Quick Start

### Prerequisites

- AWS CDK v2 installed (`npm install -g aws-cdk`)
- Node.js 20+
- AWS account with Bedrock model access enabled (Claude 3 Sonnet)
- Docker (for LocalStack local development)

### Deploy

```bash
# Clone and install
git clone https://github.com/aws-samples/bedrock-healthcare-denial-appeal-automation.git
cd bedrock-healthcare-denial-appeal-automation
npm install

# Run tests
npm test

# Deploy to your AWS account
cdk deploy DenialAppealAgentStack
cdk deploy OrchestrationStack
cdk deploy ApiStack
cdk deploy GuardrailsStack

# Optional: Deploy Bedrock Agents mode
cdk deploy AgentStack --context ENABLE_AGENTIC_MODE=true
```

### Local Development

```bash
# Start LocalStack
docker-compose up -d

# Run tests with watch mode
npm run test:watch

# Run property-based tests
npm run test:property
```

## Project Structure

```
bedrock-healthcare-denial-appeal-automation/
├── bin/                          # CDK app entry point
├── infra/stacks/                 # CDK infrastructure stacks
│   ├── denial-appeal-agent-stack.ts   # Core infra (DynamoDB, S3, KMS, VPC)
│   ├── orchestration-stack.ts         # Step Functions state machine
│   ├── api-stack.ts                   # API Gateway + webhooks
│   ├── guardrails-stack.ts            # Bedrock Guardrails configuration
│   └── agent-stack.ts                 # Optional Bedrock Agent + Knowledge Base
├── src/
│   ├── lambdas/
│   │   ├── ingestion/           # EDI parser, Textract processor, handler
│   │   ├── classifier/          # Structured + NLP classification
│   │   ├── evidence/            # HealthLake query, entity extraction
│   │   ├── viability/           # Scoring, confidence intervals, recalibration
│   │   ├── generator/           # Letter generation, citation validation, preferences
│   │   ├── parser/              # Appeal letter parser (round-trip integrity)
│   │   ├── orchestration/       # Status tracking, status API
│   │   ├── outcomes/            # Recording, metrics, change detection, reports
│   │   ├── tenant/              # Provisioning with rollback
│   │   ├── webhooks/            # Webhook delivery with retries
│   │   └── agent/               # Bedrock Agent invoke handler, action schemas
│   └── shared/                  # Models, validation, DynamoDB helpers, auth, audit
├── test/
│   ├── unit/                    # 955+ unit tests
│   ├── property/                # Property-based tests (fast-check)
│   └── integration/             # Integration tests (agent mode)
├── docker-compose.yml           # LocalStack for local development
├── vitest.config.ts             # Test configuration
└── cdk.json                     # CDK configuration
```

## Key Design Decisions

**Single DynamoDB Table** — All entities (denial records, classifications, evidence, assessments, letters, outcomes, workflows, tenant configs, audit logs) use a single-table design with composite keys and 3 GSIs for efficient access patterns.

**Bedrock Guardrails for Clinical Grounding** — Every Bedrock invocation passes through guardrails configured with contextual grounding (threshold 0.7), ensuring generated content is traceable to source evidence. No hallucinated citations.

**Wilson Score Confidence Intervals** — Viability scores include 90% confidence intervals using the Wilson score method, with automatic widening when historical data is sparse (< 30 outcomes).

**Chi-Squared Change Detection** — The outcome tracker runs daily statistical tests comparing current overturn rates against 90-day baselines, alerting revenue cycle managers when significant changes occur (p < 0.05).

**Compensating Transactions for Tenant Provisioning** — Multi-tenant onboarding uses a step-by-step provisioning flow with full rollback on partial failure (KMS key → S3 prefix → DynamoDB config).

**Feature-Flagged Agentic Mode** — The optional Bedrock Agent reuses all existing Lambda functions as action groups — no code duplication. It's a different orchestration layer over the same business logic.

## Testing

```bash
# All tests (1,011 tests across 40 files)
npm test

# Unit tests only
npm run test:unit

# Property-based tests (fast-check, 100+ iterations per property)
npm run test:property

# Integration tests (Bedrock Agent mode)
npm run test:integration

# Watch mode
npm run test:watch
```

### Property-Based Tests

The architecture includes 9 formally specified correctness properties validated with [fast-check](https://github.com/dubzzz/fast-check):

1. EDI Parsing Produces Valid Denial Records
2. Denial_Record Schema Invariant
3. Missing Mandatory Field Detection
4. Duplicate Detection Idempotence
5. Denial Reason Ranking Correctness
6. Classification Confidence Routing
7. Evidence Relevance Filtering and Ordering
8. Viability Score Recommendation Consistency
9. Confidence Interval Validity

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `TABLE_NAME` | DynamoDB table name | `DenialAppeals` |
| `BEDROCK_MODEL_ID` | Bedrock model for classification/generation | `anthropic.claude-3-sonnet-20240229-v1:0` |
| `GUARDRAIL_ID` | Bedrock Guardrail identifier | — |
| `GUARDRAIL_VERSION` | Bedrock Guardrail version | `DRAFT` |
| `HEALTHLAKE_ENDPOINT` | HealthLake FHIR endpoint URL | — |
| `HEALTHLAKE_DATASTORE_ID` | HealthLake data store ID | — |
| `MODEL_BUCKET` | S3 bucket for scoring model | — |
| `MODEL_KEY` | S3 key for scoring model JSON | — |
| `DEFAULT_APPEAL_WINDOW_DAYS` | Days from denial to appeal deadline | `60` |
| `ENABLE_AGENTIC_MODE` | Enable Bedrock Agent mode | `false` |

### Payer Templates

Custom payer templates are stored in S3 at `templates/<payer_id>.json`. See `src/lambdas/generator/letter-generator.ts` for the template schema.

### Scoring Model

The viability scoring model is stored as JSON in S3 and recalibrated monthly. See `src/lambdas/viability/scorer.ts` for the model schema and default weights.

## Security & Compliance

- **HIPAA-eligible services only** — All services processing PHI are covered under AWS BAA
- **Encryption at rest** — AWS KMS customer-managed keys (per-tenant)
- **Encryption in transit** — TLS 1.2+ enforced on all connections
- **Immutable audit logs** — All PHI access logged with accessor identity, timestamp, action, and permit/deny status
- **RBAC** — Role-based access control with organizational unit scoping
- **Tenant isolation** — DynamoDB partition keys, S3 prefixes, and per-tenant KMS keys
- **7-year retention** — S3 lifecycle policies with Glacier Deep Archive tiering
- **VPC endpoints** — All AWS service traffic stays within the VPC

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

This project is licensed under the MIT-0 License. See [LICENSE](LICENSE).

## Acknowledgments

Built with [Kiro](https://kiro.dev) — the AI-powered IDE for AWS development.
