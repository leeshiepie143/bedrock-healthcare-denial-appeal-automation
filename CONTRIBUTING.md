# Contributing

We welcome contributions to the Bedrock Healthcare Denial Appeal Automation project. This document provides guidelines for contributing.

## Reporting Bugs / Feature Requests

Use GitHub Issues to report bugs or suggest features. When filing an issue, check existing issues first to avoid duplicates. Provide as much context as possible — steps to reproduce, expected behavior, actual behavior, and environment details.

## Contributing via Pull Requests

1. Fork the repository.
2. Create a feature branch from `main`.
3. Make your changes. Follow existing code style and patterns.
4. Add or update tests for your changes.
5. Run the full test suite: `npm test`
6. Run the linter: `npm run lint`
7. Commit with a clear, descriptive message.
8. Open a pull request against `main`.

### Pull Request Checklist

- [ ] Tests pass (`npm test` — all 1,011+ tests green)
- [ ] TypeScript compiles without errors (`npm run build`)
- [ ] New code follows existing patterns (client injection, path aliases, EARS-format requirements)
- [ ] Property-based tests added for new correctness properties
- [ ] CDK synth succeeds for infrastructure changes (`npm run synth`)
- [ ] Documentation updated if behavior changes

## Development Setup

```bash
git clone https://github.com/aws-samples/bedrock-healthcare-denial-appeal-automation.git
cd bedrock-healthcare-denial-appeal-automation
npm install
docker-compose up -d   # LocalStack for local development
npm test               # Verify everything works
```

## Code Style

- TypeScript strict mode throughout
- No `any` types — use proper interfaces
- Path aliases: `@shared/`, `@lambdas/`, `@infra/`
- Client injection pattern: `setClients()` / `resetClients()` for testability
- Fire-and-forget for audit logging (never block handlers)
- EARS format for requirements (WHEN/IF/THE/SHALL)

## Testing Standards

- Unit tests alongside implementation (vitest)
- Property-based tests in `test/property/` (fast-check, 100+ iterations)
- Integration tests in `test/integration/`
- Mock AWS SDK clients — never call real AWS services in tests
- Test file naming: `<module>.test.ts` for unit, `<module>.property.test.ts` for PBT

## Security

See [SECURITY.md](SECURITY.md) for reporting security vulnerabilities.

## Licensing

See the [LICENSE](LICENSE) file. By contributing, you agree that your contributions will be licensed under the MIT-0 License.
