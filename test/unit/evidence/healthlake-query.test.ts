/**
 * Unit tests for HealthLake FHIR Query Lambda
 *
 * Tests FHIR query construction, date range calculation, 50-item cap enforcement,
 * 60-second timeout with graceful degradation, and SigV4 authorization flow.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  queryHealthLake,
  querySingleResourceType,
  calculateDateRange,
  buildFhirSearchUrl,
  getResourceDate,
  setDependencies,
  resetDependencies,
  EVIDENCE_RESOURCE_TYPES,
  MAX_EVIDENCE_ITEMS,
  QUERY_TIMEOUT_MS,
  DEFAULT_DATE_RANGE_DAYS,
  type HealthLakeQueryInput,
  type FhirResource,
  type HealthLakeQueryResult,
} from '@lambdas/evidence/healthlake-query';

// ─── Test Helpers ───────────────────────────────────────────────────────────

function createMockFhirResource(
  resourceType: string,
  id: string,
  date: string
): FhirResource {
  return {
    resourceType: resourceType as any,
    id,
    meta: { lastUpdated: date },
    date,
  };
}

function createMockBundle(resources: FhirResource[]) {
  return {
    resourceType: 'Bundle',
    type: 'searchset',
    total: resources.length,
    entry: resources.map((resource) => ({ resource })),
  };
}

function createMockSigner() {
  return {
    sign: vi.fn().mockImplementation((request) =>
      Promise.resolve({ ...request, headers: { ...request.headers, authorization: 'AWS4-HMAC-SHA256 ...' } })
    ),
  } as any;
}

function createMockFetchFn(responses: Map<string, Response | Error> | Response) {
  return vi.fn().mockImplementation((url: string, _options?: RequestInit) => {
    if (responses instanceof Response) {
      return Promise.resolve(responses.clone());
    }
    for (const [pattern, response] of responses.entries()) {
      if (url.includes(pattern)) {
        if (response instanceof Error) {
          return Promise.reject(response);
        }
        return Promise.resolve(response.clone());
      }
    }
    return Promise.resolve(new Response(JSON.stringify({ resourceType: 'Bundle', entry: [] }), {
      status: 200,
      headers: { 'content-type': 'application/fhir+json' },
    }));
  });
}

// ─── Setup / Teardown ───────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  resetDependencies();
  process.env.HEALTHLAKE_ENDPOINT = 'https://test-datastore.healthlake.us-east-1.amazonaws.com';
  process.env.HEALTHLAKE_DATASTORE_ID = 'test-datastore-id';
  process.env.AWS_REGION = 'us-east-1';
});

afterEach(() => {
  resetDependencies();
  delete process.env.HEALTHLAKE_ENDPOINT;
  delete process.env.HEALTHLAKE_DATASTORE_ID;
  delete process.env.AWS_REGION;
});

// ─── Date Range Calculation ─────────────────────────────────────────────────

describe('calculateDateRange', () => {
  it('should calculate ±30 day range from date of service', () => {
    const result = calculateDateRange('2024-06-15');
    expect(result.startDate).toBe('2024-05-16');
    expect(result.endDate).toBe('2024-07-15');
  });

  it('should handle custom window days', () => {
    const result = calculateDateRange('2024-06-15', 7);
    expect(result.startDate).toBe('2024-06-08');
    expect(result.endDate).toBe('2024-06-22');
  });

  it('should handle year boundary crossing', () => {
    const result = calculateDateRange('2024-01-10', 30);
    expect(result.startDate).toBe('2023-12-11');
    expect(result.endDate).toBe('2024-02-09');
  });

  it('should throw for invalid date', () => {
    expect(() => calculateDateRange('not-a-date')).toThrow('Invalid dateOfService');
  });

  it('should handle leap year dates', () => {
    const result = calculateDateRange('2024-02-29', 1);
    expect(result.startDate).toBe('2024-02-28');
    expect(result.endDate).toBe('2024-03-01');
  });
});

// ─── FHIR Search URL Construction ──────────────────────────────────────────

describe('buildFhirSearchUrl', () => {
  it('should build correct URL with all parameters', () => {
    const url = buildFhirSearchUrl(
      'https://test.healthlake.us-east-1.amazonaws.com',
      'ds-123',
      'Encounter',
      'patient-456',
      '2024-01-01',
      '2024-02-01'
    );

    expect(url).toContain('/datastore/ds-123/r4/Encounter');
    expect(url).toContain('patient=Patient%2Fpatient-456');
    expect(url).toContain('date=ge2024-01-01');
    expect(url).toContain('date=le2024-02-01');
    expect(url).toContain('_count=50');
    expect(url).toContain('_sort=-date');
  });

  it('should build correct URL for each resource type', () => {
    for (const resourceType of EVIDENCE_RESOURCE_TYPES) {
      const url = buildFhirSearchUrl(
        'https://test.healthlake.us-east-1.amazonaws.com',
        'ds-123',
        resourceType,
        'patient-1',
        '2024-01-01',
        '2024-02-01'
      );
      expect(url).toContain(`/r4/${resourceType}`);
    }
  });
});

// ─── getResourceDate ────────────────────────────────────────────────────────

describe('getResourceDate', () => {
  it('should extract date from top-level date field', () => {
    const resource: FhirResource = {
      resourceType: 'Encounter',
      id: '1',
      date: '2024-06-15T10:00:00Z',
    };
    expect(getResourceDate(resource)).toBe('2024-06-15T10:00:00Z');
  });

  it('should extract effectiveDateTime', () => {
    const resource: FhirResource = {
      resourceType: 'DiagnosticReport',
      id: '1',
      effectiveDateTime: '2024-06-10T08:00:00Z',
    };
    expect(getResourceDate(resource)).toBe('2024-06-10T08:00:00Z');
  });

  it('should fall back to meta.lastUpdated', () => {
    const resource: FhirResource = {
      resourceType: 'Condition',
      id: '1',
      meta: { lastUpdated: '2024-06-01T12:00:00Z' },
    };
    expect(getResourceDate(resource)).toBe('2024-06-01T12:00:00Z');
  });

  it('should return fallback date when no date fields exist', () => {
    const resource: FhirResource = {
      resourceType: 'Procedure',
      id: '1',
    };
    expect(getResourceDate(resource)).toBe('1970-01-01');
  });
});

// ─── querySingleResourceType ────────────────────────────────────────────────

describe('querySingleResourceType', () => {
  it('should return resources from a successful query', async () => {
    const mockResources = [
      createMockFhirResource('Encounter', 'enc-1', '2024-06-15T10:00:00Z'),
      createMockFhirResource('Encounter', 'enc-2', '2024-06-14T09:00:00Z'),
    ];

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(createMockBundle(mockResources)), {
        status: 200,
        headers: { 'content-type': 'application/fhir+json' },
      })
    );

    setDependencies({
      signerFactory: () => createMockSigner(),
      fetchFn: mockFetch,
    });

    const controller = new AbortController();
    const result = await querySingleResourceType(
      'Encounter',
      'patient-1',
      '2024-05-16',
      '2024-07-15',
      controller.signal
    );

    expect(result.success).toBe(true);
    expect(result.resourceType).toBe('Encounter');
    expect(result.resources).toHaveLength(2);
    expect(result.resources[0].id).toBe('enc-1');
  });

  it('should handle HTTP error responses', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('Access Denied', { status: 403 })
    );

    setDependencies({
      signerFactory: () => createMockSigner(),
      fetchFn: mockFetch,
    });

    const controller = new AbortController();
    const result = await querySingleResourceType(
      'Encounter',
      'patient-1',
      '2024-05-16',
      '2024-07-15',
      controller.signal
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('HTTP 403');
    expect(result.resources).toHaveLength(0);
  });

  it('should handle abort signal (timeout)', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';

    const mockFetch = vi.fn().mockRejectedValue(abortError);

    setDependencies({
      signerFactory: () => createMockSigner(),
      fetchFn: mockFetch,
    });

    const controller = new AbortController();
    const result = await querySingleResourceType(
      'Encounter',
      'patient-1',
      '2024-05-16',
      '2024-07-15',
      controller.signal
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
  });

  it('should handle network errors', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));

    setDependencies({
      signerFactory: () => createMockSigner(),
      fetchFn: mockFetch,
    });

    const controller = new AbortController();
    const result = await querySingleResourceType(
      'Encounter',
      'patient-1',
      '2024-05-16',
      '2024-07-15',
      controller.signal
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Network error');
  });

  it('should handle empty bundle response', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ resourceType: 'Bundle', entry: [] }), {
        status: 200,
        headers: { 'content-type': 'application/fhir+json' },
      })
    );

    setDependencies({
      signerFactory: () => createMockSigner(),
      fetchFn: mockFetch,
    });

    const controller = new AbortController();
    const result = await querySingleResourceType(
      'Condition',
      'patient-1',
      '2024-05-16',
      '2024-07-15',
      controller.signal
    );

    expect(result.success).toBe(true);
    expect(result.resources).toHaveLength(0);
  });

  it('should use SigV4 signing for requests', async () => {
    const mockSigner = createMockSigner();
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ resourceType: 'Bundle', entry: [] }), {
        status: 200,
        headers: { 'content-type': 'application/fhir+json' },
      })
    );

    setDependencies({
      signerFactory: () => mockSigner,
      fetchFn: mockFetch,
    });

    const controller = new AbortController();
    await querySingleResourceType(
      'Encounter',
      'patient-1',
      '2024-05-16',
      '2024-07-15',
      controller.signal
    );

    expect(mockSigner.sign).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ authorization: expect.any(String) }),
      })
    );
  });
});

// ─── queryHealthLake (Integration) ──────────────────────────────────────────

describe('queryHealthLake', () => {
  it('should query all resource types and combine results', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/Encounter')) {
        return Promise.resolve(new Response(JSON.stringify(createMockBundle([
          createMockFhirResource('Encounter', 'enc-1', '2024-06-15T10:00:00Z'),
        ])), { status: 200 }));
      }
      if (url.includes('/Procedure')) {
        return Promise.resolve(new Response(JSON.stringify(createMockBundle([
          createMockFhirResource('Procedure', 'proc-1', '2024-06-14T09:00:00Z'),
        ])), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ resourceType: 'Bundle', entry: [] }), { status: 200 }));
    });

    setDependencies({
      signerFactory: () => createMockSigner(),
      fetchFn: mockFetch,
    });

    const result = await queryHealthLake({
      patientId: 'patient-1',
      dateOfService: '2024-06-15',
    });

    expect(result.resources).toHaveLength(2);
    expect(result.totalRetrieved).toBe(2);
    expect(result.returnedCount).toBe(2);
    expect(result.capped).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.queriedResourceTypes).toContain('Encounter');
    expect(result.queriedResourceTypes).toContain('Procedure');
    expect(mockFetch).toHaveBeenCalledTimes(5); // One per resource type
  });

  it('should enforce 50-item maximum and keep most recent', async () => {
    // Generate 60 resources across types
    const resources: FhirResource[] = [];
    for (let i = 0; i < 60; i++) {
      const day = String(i + 1).padStart(2, '0');
      resources.push(
        createMockFhirResource('Encounter', `enc-${i}`, `2024-06-${day > '30' ? '30' : day}T10:00:00Z`)
      );
    }

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/Encounter')) {
        return Promise.resolve(new Response(
          JSON.stringify(createMockBundle(resources.slice(0, 30))),
          { status: 200 }
        ));
      }
      if (url.includes('/Procedure')) {
        return Promise.resolve(new Response(
          JSON.stringify(createMockBundle(resources.slice(30, 60))),
          { status: 200 }
        ));
      }
      return Promise.resolve(new Response(
        JSON.stringify({ resourceType: 'Bundle', entry: [] }),
        { status: 200 }
      ));
    });

    setDependencies({
      signerFactory: () => createMockSigner(),
      fetchFn: mockFetch,
    });

    const result = await queryHealthLake({
      patientId: 'patient-1',
      dateOfService: '2024-06-15',
    });

    expect(result.totalRetrieved).toBe(60);
    expect(result.returnedCount).toBe(MAX_EVIDENCE_ITEMS);
    expect(result.capped).toBe(true);
    expect(result.resources).toHaveLength(MAX_EVIDENCE_ITEMS);
  });

  it('should sort results by date (most recent first)', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/Encounter')) {
        return Promise.resolve(new Response(JSON.stringify(createMockBundle([
          createMockFhirResource('Encounter', 'enc-old', '2024-06-01T10:00:00Z'),
          createMockFhirResource('Encounter', 'enc-new', '2024-06-20T10:00:00Z'),
        ])), { status: 200 }));
      }
      if (url.includes('/Procedure')) {
        return Promise.resolve(new Response(JSON.stringify(createMockBundle([
          createMockFhirResource('Procedure', 'proc-mid', '2024-06-10T10:00:00Z'),
        ])), { status: 200 }));
      }
      return Promise.resolve(new Response(
        JSON.stringify({ resourceType: 'Bundle', entry: [] }),
        { status: 200 }
      ));
    });

    setDependencies({
      signerFactory: () => createMockSigner(),
      fetchFn: mockFetch,
    });

    const result = await queryHealthLake({
      patientId: 'patient-1',
      dateOfService: '2024-06-15',
    });

    expect(result.resources[0].id).toBe('enc-new');
    expect(result.resources[1].id).toBe('proc-mid');
    expect(result.resources[2].id).toBe('enc-old');
  });

  it('should handle partial failures gracefully', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/Encounter')) {
        return Promise.resolve(new Response(JSON.stringify(createMockBundle([
          createMockFhirResource('Encounter', 'enc-1', '2024-06-15T10:00:00Z'),
        ])), { status: 200 }));
      }
      if (url.includes('/Procedure')) {
        return Promise.resolve(new Response('Internal Server Error', { status: 500 }));
      }
      return Promise.resolve(new Response(
        JSON.stringify({ resourceType: 'Bundle', entry: [] }),
        { status: 200 }
      ));
    });

    setDependencies({
      signerFactory: () => createMockSigner(),
      fetchFn: mockFetch,
    });

    const result = await queryHealthLake({
      patientId: 'patient-1',
      dateOfService: '2024-06-15',
    });

    expect(result.resources).toHaveLength(1);
    expect(result.queriedResourceTypes).toContain('Encounter');
    expect(result.failedResourceTypes).toContain('Procedure');
    expect(result.timedOut).toBe(false);
  });

  it('should handle timeout with graceful degradation', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/Encounter')) {
        return Promise.resolve(new Response(JSON.stringify(createMockBundle([
          createMockFhirResource('Encounter', 'enc-1', '2024-06-15T10:00:00Z'),
        ])), { status: 200 }));
      }
      // Simulate timeout for other resource types
      return Promise.reject(abortError);
    });

    setDependencies({
      signerFactory: () => createMockSigner(),
      fetchFn: mockFetch,
    });

    const result = await queryHealthLake({
      patientId: 'patient-1',
      dateOfService: '2024-06-15',
    });

    // Should still return partial results from Encounter
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0].id).toBe('enc-1');
    expect(result.timedOut).toBe(true);
    expect(result.queriedResourceTypes).toContain('Encounter');
    expect(result.failedResourceTypes.length).toBeGreaterThan(0);
  });

  it('should return empty results when all queries fail', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('Service Unavailable', { status: 503 })
    );

    setDependencies({
      signerFactory: () => createMockSigner(),
      fetchFn: mockFetch,
    });

    const result = await queryHealthLake({
      patientId: 'patient-1',
      dateOfService: '2024-06-15',
    });

    expect(result.resources).toHaveLength(0);
    expect(result.totalRetrieved).toBe(0);
    expect(result.returnedCount).toBe(0);
    expect(result.failedResourceTypes).toHaveLength(5);
    expect(result.queriedResourceTypes).toHaveLength(0);
  });

  it('should throw when HEALTHLAKE_ENDPOINT is not set', async () => {
    delete process.env.HEALTHLAKE_ENDPOINT;

    const mockFetch = vi.fn();
    setDependencies({
      signerFactory: () => createMockSigner(),
      fetchFn: mockFetch,
    });

    // The error will be thrown inside querySingleResourceType
    // and caught by Promise.allSettled, resulting in all failed
    const result = await queryHealthLake({
      patientId: 'patient-1',
      dateOfService: '2024-06-15',
    });

    expect(result.failedResourceTypes).toHaveLength(5);
    expect(result.resources).toHaveLength(0);
  });

  it('should use custom date range window when provided', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      // Verify the date range in the URL
      expect(url).toContain('ge2024-06-08');
      expect(url).toContain('le2024-06-22');
      return Promise.resolve(new Response(
        JSON.stringify({ resourceType: 'Bundle', entry: [] }),
        { status: 200 }
      ));
    });

    setDependencies({
      signerFactory: () => createMockSigner(),
      fetchFn: mockFetch,
    });

    await queryHealthLake({
      patientId: 'patient-1',
      dateOfService: '2024-06-15',
      dateRangeWindowDays: 7,
    });

    expect(mockFetch).toHaveBeenCalled();
  });

  it('should include durationMs in result', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ resourceType: 'Bundle', entry: [] }), { status: 200 })
    );

    setDependencies({
      signerFactory: () => createMockSigner(),
      fetchFn: mockFetch,
    });

    const result = await queryHealthLake({
      patientId: 'patient-1',
      dateOfService: '2024-06-15',
    });

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.durationMs).toBe('number');
  });
});

// ─── Environment Variable Validation ────────────────────────────────────────

describe('environment variable validation', () => {
  it('should fail gracefully when HEALTHLAKE_DATASTORE_ID is not set', async () => {
    delete process.env.HEALTHLAKE_DATASTORE_ID;

    const mockFetch = vi.fn();
    setDependencies({
      signerFactory: () => createMockSigner(),
      fetchFn: mockFetch,
    });

    const result = await queryHealthLake({
      patientId: 'patient-1',
      dateOfService: '2024-06-15',
    });

    expect(result.failedResourceTypes).toHaveLength(5);
    expect(result.resources).toHaveLength(0);
  });
});

// ─── Constants Verification ─────────────────────────────────────────────────

describe('constants', () => {
  it('should have correct resource types', () => {
    expect(EVIDENCE_RESOURCE_TYPES).toEqual([
      'Encounter',
      'Procedure',
      'Condition',
      'DiagnosticReport',
      'DocumentReference',
    ]);
  });

  it('should have 50-item maximum', () => {
    expect(MAX_EVIDENCE_ITEMS).toBe(50);
  });

  it('should have 60-second timeout', () => {
    expect(QUERY_TIMEOUT_MS).toBe(60_000);
  });

  it('should have 30-day default date range', () => {
    expect(DEFAULT_DATE_RANGE_DAYS).toBe(30);
  });
});
