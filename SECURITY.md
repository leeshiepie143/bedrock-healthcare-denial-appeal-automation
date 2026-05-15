# Security

## Reporting a Vulnerability

If you discover a potential security issue in this project, we ask that you notify AWS Security via our [vulnerability reporting page](https://aws.amazon.com/security/vulnerability-reporting/). Do **not** create a public GitHub issue for security vulnerabilities.

## Security Considerations

This solution processes Protected Health Information (PHI). Before deploying to production:

1. **BAA Coverage** — Ensure your AWS account has a Business Associate Agreement in place.
2. **Encryption** — All data is encrypted at rest (KMS CMK) and in transit (TLS 1.2+). Verify KMS key policies match your organization's requirements.
3. **Access Control** — Review IAM policies, Cognito user pool settings, and API Gateway authorizers before exposing endpoints.
4. **Audit Logging** — The audit log table is append-only by design. Enable CloudTrail for additional AWS API-level logging.
5. **Network Isolation** — The solution deploys in a VPC with private subnets. Verify security group rules and VPC endpoint policies.
6. **Bedrock Guardrails** — Review guardrail configuration (content filters, denied topics, PII handling) against your organization's policies.
7. **Data Retention** — Default retention is 7 years with Glacier tiering. Adjust lifecycle policies per your compliance requirements.
8. **Tenant Isolation** — In multi-tenant mode, verify that per-tenant KMS keys, S3 prefixes, and DynamoDB partition scoping meet your isolation requirements.

## Shared Responsibility

This is a reference architecture. You are responsible for:
- Configuring authentication and authorization for your environment
- Managing encryption keys and access policies
- Monitoring and responding to security alerts
- Conducting security assessments before production deployment
- Ensuring compliance with HIPAA, state regulations, and organizational policies
