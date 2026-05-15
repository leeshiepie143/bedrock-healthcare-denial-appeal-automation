# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.0] - 2026-05-15

### Added

- End-to-end denial appeal automation pipeline (ingestion → classification → evidence → viability → generation)
- EDI 835/277 transaction parsing with CARC/RARC code extraction
- Amazon Textract integration for PDF and fax image OCR
- Amazon Bedrock (Claude) integration for free-text denial classification and appeal letter generation
- Amazon Bedrock Guardrails for hallucination prevention, PII masking, and content safety
- Amazon Comprehend Medical for clinical entity extraction and relevance scoring
- AWS HealthLake FHIR R4 integration for clinical evidence retrieval
- Viability scoring with Wilson confidence intervals and monthly recalibration
- Payer-specific appeal letter templates with citation grounding
- User edit preference tracking for continuous letter quality improvement
- Appeal letter parser with round-trip integrity guarantee
- AWS Step Functions orchestration with retry/backoff/timeout
- Outcome tracking with aggregate metrics and chi-squared statistical change detection
- Monthly performance reports with volume and rate change alerts
- Multi-tenant architecture with per-tenant KMS keys, S3 prefixes, and DynamoDB isolation
- Tenant provisioning with compensating transaction rollback
- Immutable audit logging for all PHI access
- RBAC with organizational unit scoping
- Per-tenant API rate limiting (100+ req/min)
- API Gateway REST API with IAM authorization
- Webhook delivery with exponential backoff retries
- Optional Amazon Bedrock Agents mode with Knowledge Base (feature-flagged)
- 6 action groups for conversational agent interaction
- CDK infrastructure-as-code for all AWS resources
- 1,011 tests (unit + property-based + integration)
- LocalStack configuration for local development
- CloudWatch dashboard, alarms, and structured logging
