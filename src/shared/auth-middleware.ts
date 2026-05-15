/**
 * Authentication and Authorization Middleware
 *
 * Provides RBAC enforcement, tenant isolation, and per-tenant rate limiting
 * for the Denial Appeal Agent multi-tenant deployment.
 *
 * Key functions:
 * - validateTenantAccess: Checks if request tenant matches authenticated tenant
 * - enforceTenantScope: Validates DynamoDB PK starts with TENANT#<authenticatedTenantId>
 * - checkRateLimit: Per-tenant sliding window rate limiter (in-memory)
 * - createAuthContext: Extracts tenant ID and user identity from API Gateway event
 *
 * Requirements: 9.4, 9.5, 10.1, 10.6, 10.7
 */

import type { APIGatewayProxyEvent } from 'aws-lambda';
import { KEY_PREFIX } from './dynamodb';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Represents the authenticated context extracted from an API Gateway event. */
export interface AuthContext {
  tenantId: string;
  userId: string;
  organizationalUnit: string | null;
  sourceIp: string;
  requestId: string;
}

/** Result of an access validation check. */
export interface AccessValidationResult {
  allowed: boolean;
  reason: string;
}

/** Result of a rate limit check. */
export interface RateLimitResult {
  allowed: boolean;
  currentCount: number;
  limit: number;
  retryAfterSeconds: number | null;
}

/** Represents a denied access event for audit logging. */
export interface DeniedAccessEvent {
  tenantId: string;
  userId: string;
  requestedResource: string;
  reason: string;
  sourceIp: string;
  requestId: string;
  timestamp: string;
}

// ─── Rate Limiting (In-Memory Sliding Window) ───────────────────────────────

/**
 * In-memory rate limit store.
 * Maps tenantId → array of request timestamps (epoch ms).
 *
 * Note: In Lambda, this resets per cold start. Production deployments
 * should use DynamoDB or ElastiCache for distributed rate limiting.
 */
const rateLimitStore: Map<string, number[]> = new Map();

/** Default rate limit window in milliseconds (1 minute). */
const RATE_LIMIT_WINDOW_MS = 60_000;

/** Default minimum rate limit per tenant (requests per minute). */
const DEFAULT_RATE_LIMIT_RPM = 100;

// ─── Tenant Access Validation ───────────────────────────────────────────────

/**
 * Validates that the request tenant ID matches the authenticated tenant ID.
 * Returns true if access is allowed, false if cross-tenant access is attempted.
 *
 * @param requestTenantId - The tenant ID from the request (e.g., from path or body)
 * @param authenticatedTenantId - The tenant ID from the authenticated context
 * @returns true if the tenant IDs match, false otherwise
 */
export function validateTenantAccess(
  requestTenantId: string,
  authenticatedTenantId: string
): boolean {
  if (!requestTenantId || !authenticatedTenantId) {
    return false;
  }
  return requestTenantId === authenticatedTenantId;
}

// ─── DynamoDB Partition Key Tenant Scoping ──────────────────────────────────

/**
 * Validates that a DynamoDB partition key (PK) is scoped to the authenticated tenant.
 * The PK must start with "TENANT#<authenticatedTenantId>".
 *
 * This ensures all DynamoDB queries are tenant-scoped, preventing cross-tenant
 * data access at the data layer.
 *
 * @param pk - The DynamoDB partition key to validate
 * @param authenticatedTenantId - The tenant ID from the authenticated context
 * @returns true if the PK is correctly scoped to the tenant
 */
export function enforceTenantScope(pk: string, authenticatedTenantId: string): boolean {
  if (!pk || !authenticatedTenantId) {
    return false;
  }
  const expectedPrefix = `${KEY_PREFIX.TENANT}${authenticatedTenantId}`;
  return pk === expectedPrefix;
}

// ─── Organizational Unit Scoping ────────────────────────────────────────────

/**
 * Validates that a user has access to a resource based on organizational unit scoping.
 * Users can only access denial records and clinical evidence for patients assigned
 * to their organizational unit or care team.
 *
 * @param userOrgUnit - The organizational unit of the authenticated user
 * @param resourceOrgUnit - The organizational unit associated with the resource
 * @returns AccessValidationResult indicating whether access is allowed
 */
export function validateOrganizationalUnitAccess(
  userOrgUnit: string | null,
  resourceOrgUnit: string | null
): AccessValidationResult {
  // If user has no org unit assigned, deny access (principle of least privilege)
  if (!userOrgUnit) {
    return {
      allowed: false,
      reason: 'User has no organizational unit assignment',
    };
  }

  // If resource has no org unit restriction, allow access within tenant
  if (!resourceOrgUnit) {
    return {
      allowed: true,
      reason: 'Resource has no organizational unit restriction',
    };
  }

  // Check if user's org unit matches the resource's org unit
  if (userOrgUnit === resourceOrgUnit) {
    return {
      allowed: true,
      reason: 'User organizational unit matches resource scope',
    };
  }

  return {
    allowed: false,
    reason: `User organizational unit '${userOrgUnit}' does not match resource scope '${resourceOrgUnit}'`,
  };
}

// ─── Rate Limiting ──────────────────────────────────────────────────────────

/**
 * Checks whether a tenant has exceeded their per-minute rate limit using
 * a sliding window algorithm.
 *
 * Returns true if the request is under the limit and should be allowed.
 * Returns false if the rate limit has been exceeded.
 *
 * @param tenantId - The tenant making the request
 * @param currentRequestCount - Current number of requests in the window (ignored, computed internally)
 * @param limitPerMinute - The rate limit for this tenant (must be >= 100)
 * @returns RateLimitResult with allowed status and metadata
 */
export function checkRateLimit(
  tenantId: string,
  currentRequestCount: number,
  limitPerMinute: number
): RateLimitResult {
  // Enforce minimum rate limit of 100 req/min per requirements
  const effectiveLimit = Math.max(limitPerMinute, DEFAULT_RATE_LIMIT_RPM);
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;

  // Get or initialize the request timestamps for this tenant
  let timestamps = rateLimitStore.get(tenantId);
  if (!timestamps) {
    timestamps = [];
    rateLimitStore.set(tenantId, timestamps);
  }

  // Remove expired timestamps (outside the sliding window)
  const activeTimestamps = timestamps.filter((ts) => ts > windowStart);
  rateLimitStore.set(tenantId, activeTimestamps);

  const currentCount = activeTimestamps.length;

  if (currentCount >= effectiveLimit) {
    // Calculate retry-after based on oldest timestamp in window
    const oldestInWindow = activeTimestamps[0];
    const retryAfterMs = oldestInWindow ? oldestInWindow + RATE_LIMIT_WINDOW_MS - now : RATE_LIMIT_WINDOW_MS;
    const retryAfterSeconds = Math.ceil(Math.max(retryAfterMs, 1000) / 1000);

    return {
      allowed: false,
      currentCount,
      limit: effectiveLimit,
      retryAfterSeconds,
    };
  }

  // Record this request
  activeTimestamps.push(now);

  return {
    allowed: true,
    currentCount: currentCount + 1,
    limit: effectiveLimit,
    retryAfterSeconds: null,
  };
}

/**
 * Resets the rate limit store for a specific tenant.
 * Useful for testing or administrative overrides.
 */
export function resetRateLimit(tenantId: string): void {
  rateLimitStore.delete(tenantId);
}

/**
 * Resets the entire rate limit store.
 * Useful for testing cleanup.
 */
export function resetAllRateLimits(): void {
  rateLimitStore.clear();
}

// ─── Auth Context Extraction ────────────────────────────────────────────────

/**
 * Extracts the authentication context from an API Gateway proxy event.
 * Reads tenant ID and user identity from the event's authorizer context,
 * headers, or request context.
 *
 * Expected sources (in priority order):
 * 1. Authorizer context (from Cognito or custom authorizer)
 * 2. Request headers (X-Tenant-Id, X-User-Id, X-Org-Unit)
 * 3. Request context (for IAM-authenticated requests)
 *
 * @param event - The API Gateway proxy event
 * @returns AuthContext or null if authentication info cannot be extracted
 */
export function createAuthContext(event: APIGatewayProxyEvent): AuthContext | null {
  // Try authorizer context first (Cognito or custom authorizer)
  const authorizerClaims = event.requestContext?.authorizer;

  let tenantId: string | undefined;
  let userId: string | undefined;
  let organizationalUnit: string | null = null;

  if (authorizerClaims) {
    // Custom authorizer or Cognito claims
    tenantId =
      authorizerClaims['custom:tenant_id'] as string |
      undefined ?? authorizerClaims['tenantId'] as string | undefined;
    userId =
      authorizerClaims['sub'] as string |
      undefined ?? authorizerClaims['userId'] as string | undefined;
    organizationalUnit =
      (authorizerClaims['custom:org_unit'] as string) ||
      (authorizerClaims['organizationalUnit'] as string) ||
      null;
  }

  // Fallback to headers
  if (!tenantId) {
    tenantId =
      event.headers?.['x-tenant-id'] ||
      event.headers?.['X-Tenant-Id'] ||
      undefined;
  }

  if (!userId) {
    userId =
      event.headers?.['x-user-id'] ||
      event.headers?.['X-User-Id'] ||
      event.requestContext?.identity?.userArn ||
      undefined;
  }

  if (!organizationalUnit) {
    organizationalUnit =
      event.headers?.['x-org-unit'] ||
      event.headers?.['X-Org-Unit'] ||
      null;
  }

  // Cannot create auth context without tenant and user
  if (!tenantId || !userId) {
    return null;
  }

  const sourceIp =
    event.requestContext?.identity?.sourceIp || '0.0.0.0';
  const requestId =
    event.requestContext?.requestId || 'unknown';

  return {
    tenantId,
    userId,
    organizationalUnit,
    sourceIp,
    requestId,
  };
}

// ─── Cross-Tenant Access Denial ─────────────────────────────────────────────

/**
 * Creates a denied access event for audit logging when cross-tenant access is attempted.
 *
 * @param authContext - The authenticated user's context
 * @param requestedResource - Description of the resource that was requested
 * @param reason - The reason access was denied
 * @returns DeniedAccessEvent for audit logging
 */
export function createDeniedAccessEvent(
  authContext: AuthContext,
  requestedResource: string,
  reason: string
): DeniedAccessEvent {
  return {
    tenantId: authContext.tenantId,
    userId: authContext.userId,
    requestedResource,
    reason,
    sourceIp: authContext.sourceIp,
    requestId: authContext.requestId,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Creates a standardized 403 Forbidden error response for cross-tenant access attempts.
 */
export function createForbiddenResponse(): {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
} {
  return {
    statusCode: 403,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify({
      error: 'Forbidden',
      message: 'Insufficient permissions to access the requested resource',
    }),
  };
}

/**
 * Creates a standardized 429 Too Many Requests error response for rate limit violations.
 */
export function createRateLimitResponse(retryAfterSeconds: number): {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
} {
  return {
    statusCode: 429,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Retry-After': String(retryAfterSeconds),
    },
    body: JSON.stringify({
      error: 'Too Many Requests',
      message: 'Rate limit exceeded. Please retry after the specified interval.',
      retryAfterSeconds,
    }),
  };
}
