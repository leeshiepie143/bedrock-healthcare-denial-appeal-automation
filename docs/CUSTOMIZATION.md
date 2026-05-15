# Customization Guide

## Payer Templates

### Adding a New Payer Template

Create a JSON file in S3 at `templates/<payer_id>.json`:

```json
{
  "payer_id": "BCBS-FL",
  "payer_name": "Blue Cross Blue Shield of Florida",
  "letter_structure": [
    "header",
    "patient_identification",
    "claim_identification",
    "denial_reason_statement",
    "clinical_justification",
    "regulatory_references",
    "request_for_reconsideration",
    "closing"
  ],
  "required_sections": [
    "patient_identification",
    "claim_identification",
    "denial_reason_statement",
    "clinical_justification",
    "request_for_reconsideration"
  ],
  "formatting_rules": {
    "salutation": "Dear BCBS Florida Appeals Committee",
    "closing": "Respectfully submitted",
    "address_format": "standard"
  },
  "address_info": {
    "appeals_department": "BCBS Florida Appeals Department",
    "street": "4800 Deerwood Campus Parkway",
    "city": "Jacksonville",
    "state": "FL",
    "zip": "32246"
  }
}
```

Upload to S3:
```bash
aws s3 cp bcbs-fl-template.json s3://<template-bucket>/templates/BCBS-FL.json
```

The system automatically selects the template when processing denials from that payer.

## Scoring Model

### Adjusting Weights

The viability scoring model is stored in S3 as JSON:

```json
{
  "weights": {
    "historical_overturn_rate": 0.30,
    "evidence_score": 0.25,
    "days_remaining_factor": 0.15,
    "claim_amount_factor": 0.15,
    "payer_overturn_rate": 0.15
  },
  "thresholds": {
    "pursue": 0.3,
    "high_confidence": 0.7
  },
  "version": "1.0.0",
  "last_calibrated": "2026-05-15T00:00:00Z"
}
```

Upload a modified model:
```bash
aws s3 cp custom-model.json s3://<model-bucket>/models/scoring-model.json
```

The model is cached in Lambda memory and reloaded on cold starts. The monthly recalibration job automatically adjusts weights based on observed outcomes.

### Changing the Pursue Threshold

Increase the threshold (e.g., 0.5) to be more selective about which appeals to pursue. Decrease it (e.g., 0.2) to pursue more appeals.

## CARC/RARC Mappings

### Adding Evidence Category Mappings

Insert records into DynamoDB with PK `CARC_MAP`:

```bash
aws dynamodb put-item --table-name DenialAppeals --item '{
  "PK": {"S": "CARC_MAP"},
  "SK": {"S": "CODE#296"},
  "code": {"S": "296"},
  "description": {"S": "Precertification/authorization/notification absent."},
  "required_evidence_categories": {"L": [{"S": "AUTHORIZATION"}, {"S": "DOCUMENTATION"}]},
  "group_code_description": {"S": "Contractual Obligation"}
}'
```

## Regulatory References

### Adding LCD/NCD References

Insert records with PK `REG_REF`:

```bash
aws dynamodb put-item --table-name DenialAppeals --item '{
  "PK": {"S": "REG_REF"},
  "SK": {"S": "lcd#L38308"},
  "reference_id": {"S": "L38308"},
  "type": {"S": "lcd"},
  "section": {"S": "§4.1"},
  "description": {"S": "Coverage criteria for spinal fusion procedures"},
  "applicable_carc_codes": {"L": [{"S": "CO-50"}, {"S": "CO-97"}]},
  "payer_types": {"L": [{"S": "medicare"}]}
}'
```

## Bedrock Guardrails

### Modifying Content Policies

Edit `infra/stacks/guardrails-stack.ts` and redeploy:

```bash
cdk deploy GuardrailsStack
```

Update the guardrail version on Lambda functions:
```bash
aws lambda update-function-configuration \
  --function-name denial-appeal-classifier \
  --environment "Variables={GUARDRAIL_VERSION=<new-version>}"
```

## Appeal Deadline Window

Default is 60 days from denial date. Change via environment variable:

```bash
aws lambda update-function-configuration \
  --function-name denial-appeal-viability \
  --environment "Variables={DEFAULT_APPEAL_WINDOW_DAYS=90}"
```

## Webhook Configuration

Set a tenant's webhook endpoint via the API:

```bash
curl -X POST https://<api-url>/v1/tenants \
  -H "x-tenant-id: admin" \
  -d '{
    "tenant_id": "hospital-abc",
    "tenant_name": "ABC Hospital",
    "webhook_endpoint": "https://hospital-abc.example.com/denial-events",
    "rate_limit_rpm": 200
  }'
```
