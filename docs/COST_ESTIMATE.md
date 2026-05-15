# Cost Estimate

Estimated monthly costs for the Revenue Cycle Denial Appeal Agent at different scales. All prices are US East (N. Virginia) as of May 2026.

## Assumptions

- Average denial document: 3 pages
- Average appeal letter: 1,500 tokens generated
- Average HealthLake query: 5 FHIR resources retrieved
- Bedrock model: Claude 3 Sonnet ($3/M input tokens, $15/M output tokens)
- DynamoDB on-demand pricing

## Small (100 denials/month)

| Service | Usage | Monthly Cost |
|---------|-------|-------------|
| Lambda | ~500 invocations, 512MB, avg 10s | $0.05 |
| Step Functions | 100 executions, 5 transitions each | $0.13 |
| DynamoDB | ~1,000 writes, ~5,000 reads | $1.50 |
| S3 | 300 MB stored | $0.01 |
| Textract | 300 pages | $4.50 |
| Bedrock (Claude) | ~200K input + 150K output tokens | $1.85 |
| Comprehend Medical | ~500 API calls | $5.00 |
| HealthLake | 500 FHIR queries | $2.50 |
| KMS | 1 key, ~200 requests | $1.20 |
| API Gateway | ~500 requests | $0.02 |
| **Total** | | **~$17/month** |

## Medium (1,000 denials/month)

| Service | Usage | Monthly Cost |
|---------|-------|-------------|
| Lambda | ~5,000 invocations | $0.50 |
| Step Functions | 1,000 executions | $1.25 |
| DynamoDB | ~10,000 writes, ~50,000 reads | $15.00 |
| S3 | 3 GB stored | $0.07 |
| Textract | 3,000 pages | $45.00 |
| Bedrock (Claude) | ~2M input + 1.5M output tokens | $28.50 |
| Comprehend Medical | ~5,000 API calls | $50.00 |
| HealthLake | 5,000 FHIR queries | $25.00 |
| KMS | 1 key, ~2,000 requests | $1.60 |
| API Gateway | ~5,000 requests | $0.02 |
| VPC (NAT Gateway) | 1 NAT, moderate traffic | $35.00 |
| **Total** | | **~$202/month** |

## Large (10,000 denials/month)

| Service | Usage | Monthly Cost |
|---------|-------|-------------|
| Lambda | ~50,000 invocations | $5.00 |
| Step Functions | 10,000 executions | $12.50 |
| DynamoDB | ~100,000 writes, ~500,000 reads | $150.00 |
| S3 | 30 GB stored | $0.70 |
| Textract | 30,000 pages | $450.00 |
| Bedrock (Claude) | ~20M input + 15M output tokens | $285.00 |
| Comprehend Medical | ~50,000 API calls | $500.00 |
| HealthLake | 50,000 FHIR queries | $250.00 |
| KMS | 10 keys (multi-tenant), ~20,000 requests | $16.00 |
| API Gateway | ~50,000 requests | $0.18 |
| VPC (NAT Gateway) | 1 NAT, high traffic | $45.00 |
| **Total** | | **~$1,715/month** |

## Cost Comparison vs. SaaS Alternatives

| Scale | This Solution | Per-Claim SaaS ($15/claim) | Savings |
|-------|--------------|---------------------------|---------|
| 100/month | $17 | $1,500 | 99% |
| 1,000/month | $202 | $15,000 | 99% |
| 10,000/month | $1,715 | $150,000 | 99% |

## Cost Optimization Tips

1. **Reserved Capacity** — Switch DynamoDB to provisioned mode with reserved capacity at scale.
2. **Bedrock Provisioned Throughput** — For predictable workloads, provisioned throughput reduces per-token costs.
3. **S3 Intelligent Tiering** — Automatically moves infrequently accessed documents to cheaper storage.
4. **Lambda ARM64** — Already configured (ARM64 is 20% cheaper than x86).
5. **Skip Textract for EDI** — EDI 835/277 files bypass Textract entirely (parsed directly).
