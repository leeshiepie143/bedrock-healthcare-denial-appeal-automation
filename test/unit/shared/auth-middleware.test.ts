/**
 * Unit tests for auth-middleware.ts
 *
 * Tests RBAC enforcement, tenant isolation, rate limiting, and auth context extraction.
 * Requirements: 9.4, 9.5, 10.1, 10.6, 10.7
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import {
  validateTenantAccess,
  enforceTenantScope,
  checkRateLimit,
  createAuthContext,
  validateOrganizationalUnitAccess,
  createDeniedAccessEvent,
  createForbiddenResponse,
  createRateLimitResponse,
  resetRateLimit,
  resetAllRateLimits,
} from '../../../src/shared/auth-middleware';

// ─── Test Helpers ───────────────────────────────────────────────────────────

function createMockEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    httpMethod: 'GET',
    path: '/appeals',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    headers: {
      'x-tenant-id': 'tenant-123',
      'x-user-id': 'user-456',
      'x-org-unit': 'cardiology',
    },
    multiValueHeaders: {},
    body: null,
    isBase64Encoded: false,
    stageVariables: null,
    resource: '',
    requestContext: {
      accountId: '123456789012',
      apiId: 'api-id',
      authorizer: null,
      protocol: 'HTTP/1.1',
      httpMethod: 'GET',
      identity: {
        sourceIp: '192.168.1.100',
        userArn: null,
        accessKey: null,
        accountId: null,
        apiKey: null,
        apiKeyId: null,
        caller: null,
        clientCert: null,
        cognitoAuthenticationProvider: null,
        cognitoAuthenticationType: null,
        cognitoIdentityId: null,
        cognitoIdentityPoolId: null,
        principalOrgId: null,
        user: null,
        userAgent: null,
      },
      path: '/appeals',
      stage: 'prod',
      requestId: 'req-789',
      requestTimeEpoch: Date.now(),
      resourceId: 'resource-id',
      resourcePath: '/appeals',
    },
    ...overrides,
  } as APIGatewayProxyEvent;
}

// ─── validateTenantAccess ───────────────────────────────────────────────────

describe('validateTenantAccess', () => {
  it('returns true when request tenant matches authenticated tenant', () => {
    expect(validateTenantAccess('tenant-123', 'tenant-123')).toBe(true);
  });

  it('returns false when request tenant differs from authenticated tenant', () => {
    expect(validateTenantAccess('tenant-123', 'tenant-456')).toBe(false);
  });

  it('returns false when request tenant is empty', () => {
    expect(validateTenantAccess('', 'tenant-123')).toBe(false);
  });

  it('returns false when authenticated tenant is empty', () => {
    expect(validateTenantAccess('tenant-123', '')).toBe(false);
  });

  it('returns false when both are empty', () => {
    expect(validateTenantAccess('', '')).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(validateTenantAccess('Tenant-123', 'tenant-123')).toBe(false);
  });
});

// ─── enforceTenantScope ─────────────────────────────────────────────────────

describe('enforceTenantScope', () => {
  it('returns true when PK matches TENANT#<authenticatedTenantId>', () => {
    expect(enforceTenantScope('TENANT#tenant-123', 'tenant-123')).toBe(true);
  });

  it('returns false when PK has a different tenant ID', () => {
    expect(enforceTenantScope('TENANT#tenant-456', 'tenant-123')).toBe(false);
  });

  it('returns false when PK does not start with TENANT# prefix', () => {
    expect(enforceTenantScope('AUDIT#tenant-123#2024-01-01', 'tenant-123')).toBe(false);
  });

  it('returns false when PK is empty', () => {
    expect(enforceTenantScope('', 'tenant-123')).toBe(false);
  });

  it('returns false when authenticated tenant is empty', () => {
    expect(enforceTenantScope('TENANT#tenant-123', '')).toBe(false);
  });

  it('returns false when PK has extra content after tenant ID', () => {
    // PK should be exactly TENANT#<tenantId>, not TENANT#<tenantId>#extra
    expect(enforceTenantScope('TENANT#tenant-123#extra', 'tenant-123')).toBe(false);
  });

  it('handles tenant IDs with special characters', () => {
    expect(enforceTenantScope('TENANT#org-health-care_01', 'org-health-care_01')).toBe(true);
  });
});

// ─── validateOrganizationalUnitAccess ───────────────────────────────────────

describe('validateOrganizationalUnitAccess', () => {
  it('allows access when user org unit matches resource org unit', () => {
    const result = validateOrganizationalUnitAccess('cardiology', 'cardiology');
    expect(result.allowed).toBe(true);
  });

  it('denies access when user org unit does not match resource org unit', () => {
    const result = validateOrganizationalUnitAccess('cardiology', 'oncology');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('cardiology');
    expect(result.reason).toContain('oncology');
  });

  it('denies access when user has no org unit assigned', () => {
    const result = validateOrganizationalUnitAccess(null, 'cardiology');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('no organizational unit');
  });

  it('allows access when resource has no org unit restriction', () => {
    const result = validateOrganizationalUnitAccess('cardiology', null);
    expect(result.allowed).toBe(true);
  });
});

// ─── checkRateLimit ─────────────────────────────────────────────────────────

describe('checkRateLimit', () => {
  beforeEach(() => {
    resetAllRateLimits();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetAllRateLimits();
  });

  it('allows first request for a tenant', () => {
    const result = checkRateLimit('tenant-1', 0, 100);
    expect(result.allowed).toBe(true);
    expect(result.currentCount).toBe(1);
    expect(result.limit).toBe(100);
    expect(result.retryAfterSeconds).toBeNull();
  });

  it('allows requests up to the limit', () => {
    for (let i = 0; i < 99; i++) {
      const result = checkRateLimit('tenant-1', 0, 100);
      expect(result.allowed).toBe(true);
    }
    // 100th request should still be allowed
    const result = checkRateLimit('tenant-1', 0, 100);
    expect(result.allowed).toBe(true);
    expect(result.currentCount).toBe(100);
  });

  it('denies request when limit is exceeded', () => {
    // Fill up to the limit
    for (let i = 0; i < 100; i++) {
      checkRateLimit('tenant-1', 0, 100);
    }
    // 101st request should be denied
    const result = checkRateLimit('tenant-1', 0, 100);
    expect(result.allowed).toBe(false);
    expect(result.currentCount).toBe(100);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('enforces minimum rate limit of 100 req/min', () => {
    // Even if limitPerMinute is set to 50, effective limit should be 100
    for (let i = 0; i < 100; i++) {
      const result = checkRateLimit('tenant-1', 0, 50);
      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(100);
    }
  });

  it('allows higher custom rate limits', () => {
    for (let i = 0; i < 200; i++) {
      const result = checkRateLimit('tenant-1', 0, 200);
      expect(result.allowed).toBe(true);
    }
    // 201st should be denied
    const result = checkRateLimit('tenant-1', 0, 200);
    expect(result.allowed).toBe(false);
  });

  it('resets after the sliding window expires', () => {
    // Fill up to the limit
    for (let i = 0; i < 100; i++) {
      checkRateLimit('tenant-1', 0, 100);
    }

    // Advance time past the 1-minute window
    vi.advanceTimersByTime(61_000);

    // Should be allowed again
    const result = checkRateLimit('tenant-1', 0, 100);
    expect(result.allowed).toBe(true);
    expect(result.currentCount).toBe(1);
  });

  it('isolates rate limits between tenants', () => {
    // Fill tenant-1 to the limit
    for (let i = 0; i < 100; i++) {
      checkRateLimit('tenant-1', 0, 100);
    }

    // tenant-2 should still be allowed
    const result = checkRateLimit('tenant-2', 0, 100);
    expect(result.allowed).toBe(true);
    expect(result.currentCount).toBe(1);
  });

  it('provides retry-after seconds when rate limited', () => {
    for (let i = 0; i < 100; i++) {
      checkRateLimit('tenant-1', 0, 100);
    }

    const result = checkRateLimit('tenant-1', 0, 100);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(result.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('resetRateLimit clears a specific tenant', () => {
    for (let i = 0; i < 100; i++) {
      checkRateLimit('tenant-1', 0, 100);
    }

    resetRateLimit('tenant-1');

    const result = checkRateLimit('tenant-1', 0, 100);
    expect(result.allowed).toBe(true);
    expect(result.currentCount).toBe(1);
  });
});

// ─── createAuthContext ──────────────────────────────────────────────────────

describe('createAuthContext', () => {
  it('extracts auth context from headers', () => {
    const event = createMockEvent();
    const context = createAuthContext(event);

    expect(context).not.toBeNull();
    expect(context!.tenantId).toBe('tenant-123');
    expect(context!.userId).toBe('user-456');
    expect(context!.organizationalUnit).toBe('cardiology');
    expect(context!.sourceIp).toBe('192.168.1.100');
    expect(context!.requestId).toBe('req-789');
  });

  it('extracts auth context from authorizer claims', () => {
    const event = createMockEvent({
      headers: {},
      requestContext: {
        ...createMockEvent().requestContext,
        authorizer: {
          'custom:tenant_id': 'tenant-auth',
          sub: 'user-auth',
          'custom:org_unit': 'radiology',
        },
      },
    });

    const context = createAuthContext(event);

    expect(context).not.toBeNull();
    expect(context!.tenantId).toBe('tenant-auth');
    expect(context!.userId).toBe('user-auth');
    expect(context!.organizationalUnit).toBe('radiology');
  });

  it('prefers authorizer claims over headers', () => {
    const event = createMockEvent({
      headers: {
        'x-tenant-id': 'header-tenant',
        'x-user-id': 'header-user',
      },
      requestContext: {
        ...createMockEvent().requestContext,
        authorizer: {
          'custom:tenant_id': 'auth-tenant',
          sub: 'auth-user',
        },
      },
    });

    const context = createAuthContext(event);

    expect(context).not.toBeNull();
    expect(context!.tenantId).toBe('auth-tenant');
    expect(context!.userId).toBe('auth-user');
  });

  it('returns null when tenant ID cannot be extracted', () => {
    const event = createMockEvent({
      headers: { 'x-user-id': 'user-456' },
    });

    const context = createAuthContext(event);
    expect(context).toBeNull();
  });

  it('returns null when user ID cannot be extracted', () => {
    const event = createMockEvent({
      headers: { 'x-tenant-id': 'tenant-123' },
    });

    const context = createAuthContext(event);
    expect(context).toBeNull();
  });

  it('handles case-insensitive header names', () => {
    const event = createMockEvent({
      headers: {
        'X-Tenant-Id': 'tenant-upper',
        'X-User-Id': 'user-upper',
        'X-Org-Unit': 'surgery',
      },
    });

    const context = createAuthContext(event);

    expect(context).not.toBeNull();
    expect(context!.tenantId).toBe('tenant-upper');
    expect(context!.userId).toBe('user-upper');
    expect(context!.organizationalUnit).toBe('surgery');
  });

  it('falls back to userArn for userId', () => {
    const event = createMockEvent({
      headers: { 'x-tenant-id': 'tenant-123' },
      requestContext: {
        ...createMockEvent().requestContext,
        identity: {
          ...createMockEvent().requestContext.identity,
          sourceIp: '10.0.0.1',
          userArn: 'arn:aws:iam::123456789012:user/service-account',
        },
      },
    });

    const context = createAuthContext(event);

    expect(context).not.toBeNull();
    expect(context!.userId).toBe('arn:aws:iam::123456789012:user/service-account');
    expect(context!.sourceIp).toBe('10.0.0.1');
  });

  it('sets organizationalUnit to null when not available', () => {
    const event = createMockEvent({
      headers: {
        'x-tenant-id': 'tenant-123',
        'x-user-id': 'user-456',
      },
    });

    const context = createAuthContext(event);

    expect(context).not.toBeNull();
    expect(context!.organizationalUnit).toBeNull();
  });
});

// ─── createDeniedAccessEvent ────────────────────────────────────────────────

describe('createDeniedAccessEvent', () => {
  it('creates a complete denied access event', () => {
    const authContext = {
      tenantId: 'tenant-123',
      userId: 'user-456',
      organizationalUnit: 'cardiology',
      sourceIp: '192.168.1.100',
      requestId: 'req-789',
    };

    const event = createDeniedAccessEvent(
      authContext,
      'DENIAL#claim-001',
      'Cross-tenant access attempt'
    );

    expect(event.tenantId).toBe('tenant-123');
    expect(event.userId).toBe('user-456');
    expect(event.requestedResource).toBe('DENIAL#claim-001');
    expect(event.reason).toBe('Cross-tenant access attempt');
    expect(event.sourceIp).toBe('192.168.1.100');
    expect(event.requestId).toBe('req-789');
    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ─── createForbiddenResponse ────────────────────────────────────────────────

describe('createForbiddenResponse', () => {
  it('returns a 403 response with correct structure', () => {
    const response = createForbiddenResponse();

    expect(response.statusCode).toBe(403);
    expect(response.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(response.body);
    expect(body.error).toBe('Forbidden');
    expect(body.message).toContain('Insufficient permissions');
  });
});

// ─── createRateLimitResponse ────────────────────────────────────────────────

describe('createRateLimitResponse', () => {
  it('returns a 429 response with Retry-After header', () => {
    const response = createRateLimitResponse(30);

    expect(response.statusCode).toBe(429);
    expect(response.headers['Content-Type']).toBe('application/json');
    expect(response.headers['Retry-After']).toBe('30');

    const body = JSON.parse(response.body);
    expect(body.error).toBe('Too Many Requests');
    expect(body.retryAfterSeconds).toBe(30);
  });
});
