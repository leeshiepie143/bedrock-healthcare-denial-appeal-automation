/**
 * HealthLake FHIR Query Lambda
 *
 * Queries AWS HealthLake for clinical evidence (FHIR R4 resources) associated
 * with a patient and date of service. Searches across multiple resource types
 * (Encounter, Procedure, Condition, DiagnosticReport, DocumentReference),
 * enforces a 50-item maximum per denial, and implements a 60-second timeout
 * with graceful degradation.
 *
 * Uses AWS SigV4 signing for HealthLake requests via the service principal.
 * Does NOT perform entity extraction — that is handled by the entity-extractor.
 */

import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import type { HttpRequest as SmithyHttpRequest } from '@smithy/types';
import type { FhirResourceType } from '@shared/models';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Input parameters for the HealthLake query. */
export interface HealthLakeQueryInput {
  /** Patient ID to search for (FHIR Patient resource ID). */
  patientId: string;
  /** Date of service (ISO 8601 date string, e.g. "2024-01-15"). */
  dateOfService: string;
  /** Optional: override the date range window in days (default: 30). */
  dateRangeWindowDays?: number;
}

/** A raw FHIR resource returned from HealthLake. */
export interface FhirResource {
  resourceType: FhirResourceType;
  id: string;
  meta?: {
    lastUpdated?: string;
    versionId?: string;
  };
  [key: string]: unknown;
}

/** Result of the HealthLake query operation. */
export interface HealthLakeQueryResult {
  /** Retrieved FHIR resources, sorted by most recent first. */
  resources: FhirResource[];
  /** Total number of resources retrieved (before 50-item cap). */
  totalRetrieved: number;
  /** Number of resources returned (after 50-item cap). */
  returnedCount: number;
  /** Whether the 50-item cap was applied. */
  capped: boolean;
  /** Duration of the query operation in milliseconds. */
  durationMs: number;
  /** Whether the operation timed out. */
  timedOut: boolean;
  /** Resource types that were successfully queried. */
  queriedResourceTypes: FhirResourceType[];
  /** Resource types that failed or timed out. */
  failedResourceTypes: FhirResourceType[];
  /** Error message if a non-timeout error occurred. */
  error?: string;
}

/** Result from querying a single resource type. */
export interface SingleResourceTypeResult {
  resourceType: FhirResourceType;
  resources: FhirResource[];
  success: boolean;
  error?: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** FHIR resource types to query for clinical evidence. */
export const EVIDENCE_RESOURCE_TYPES: FhirResourceType[] = [
  'Encounter',
  'Procedure',
  'Condition',
  'DiagnosticReport',
  'DocumentReference',
];

/** Maximum number of evidence items to return per denial. */
export const MAX_EVIDENCE_ITEMS = 50;

/** Query timeout in milliseconds (60 seconds). */
export const QUERY_TIMEOUT_MS = 60_000;

/** Default date range window: ±30 days from date of service. */
export const DEFAULT_DATE_RANGE_DAYS = 30;

// ─── Environment Variables ──────────────────────────────────────────────────

function getHealthLakeEndpoint(): string {
  const endpoint = process.env.HEALTHLAKE_ENDPOINT;
  if (!endpoint) {
    throw new Error('HEALTHLAKE_ENDPOINT environment variable is not set');
  }
  return endpoint;
}

function getHealthLakeDatastoreId(): string {
  const datastoreId = process.env.HEALTHLAKE_DATASTORE_ID;
  if (!datastoreId) {
    throw new Error('HEALTHLAKE_DATASTORE_ID environment variable is not set');
  }
  return datastoreId;
}

function getAwsRegion(): string {
  return process.env.AWS_REGION || 'us-east-1';
}

// ─── SigV4 Signing ──────────────────────────────────────────────────────────

/** Creates a SigV4 signer for HealthLake requests. */
function createSigner(): SignatureV4 {
  return new SignatureV4({
    service: 'healthlake',
    region: getAwsRegion(),
    credentials: defaultProvider(),
    sha256: Sha256,
  });
}

// Allow injection for testing
let signerFactory: () => SignatureV4 = createSigner;
let fetchFn: typeof fetch = globalThis.fetch;

/** Allows injecting mock dependencies for testing. */
export function setDependencies(deps: {
  signerFactory?: () => SignatureV4;
  fetchFn?: typeof fetch;
}): void {
  if (deps.signerFactory) signerFactory = deps.signerFactory;
  if (deps.fetchFn) fetchFn = deps.fetchFn;
}

/** Resets dependencies to defaults. */
export function resetDependencies(): void {
  signerFactory = createSigner;
  fetchFn = globalThis.fetch;
}

// ─── Date Range Calculation ─────────────────────────────────────────────────

/**
 * Calculates the date range for FHIR search based on date of service ± window.
 * Returns ISO 8601 date strings for start and end.
 */
export function calculateDateRange(
  dateOfService: string,
  windowDays: number = DEFAULT_DATE_RANGE_DAYS
): { startDate: string; endDate: string } {
  const date = new Date(dateOfService);
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid dateOfService: ${dateOfService}`);
  }

  const startDate = new Date(date);
  startDate.setDate(startDate.getDate() - windowDays);

  const endDate = new Date(date);
  endDate.setDate(endDate.getDate() + windowDays);

  return {
    startDate: startDate.toISOString().split('T')[0],
    endDate: endDate.toISOString().split('T')[0],
  };
}

// ─── FHIR Query Construction ────────────────────────────────────────────────

/**
 * Builds the FHIR search URL for a given resource type, patient, and date range.
 */
export function buildFhirSearchUrl(
  endpoint: string,
  datastoreId: string,
  resourceType: FhirResourceType,
  patientId: string,
  startDate: string,
  endDate: string
): string {
  const basePath = `${endpoint}/datastore/${datastoreId}/r4/${resourceType}`;
  const params = new URLSearchParams();
  params.set('patient', `Patient/${patientId}`);
  params.set('date', `ge${startDate}`);
  params.append('date', `le${endDate}`);
  params.set('_count', '50'); // Request up to 50 per resource type
  params.set('_sort', '-date'); // Most recent first

  return `${basePath}?${params.toString()}`;
}

// ─── Single Resource Type Query ─────────────────────────────────────────────

/**
 * Queries HealthLake for a single FHIR resource type.
 * Uses SigV4 signing and respects the provided AbortSignal for timeout.
 */
export async function querySingleResourceType(
  resourceType: FhirResourceType,
  patientId: string,
  startDate: string,
  endDate: string,
  signal: AbortSignal
): Promise<SingleResourceTypeResult> {
  const endpoint = getHealthLakeEndpoint();
  const datastoreId = getHealthLakeDatastoreId();
  const region = getAwsRegion();

  const searchUrl = buildFhirSearchUrl(
    endpoint,
    datastoreId,
    resourceType,
    patientId,
    startDate,
    endDate
  );

  try {
    const url = new URL(searchUrl);

    // Build the HTTP request object for SigV4 signing
    // Handle multi-value query params (e.g., date=ge...&date=le...)
    const queryParams: Record<string, string | string[]> = {};
    url.searchParams.forEach((value, key) => {
      const existing = queryParams[key];
      if (existing) {
        queryParams[key] = Array.isArray(existing)
          ? [...existing, value]
          : [existing, value];
      } else {
        queryParams[key] = value;
      }
    });

    const httpRequest: SmithyHttpRequest = {
      method: 'GET',
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port ? parseInt(url.port) : undefined,
      path: url.pathname,
      query: queryParams,
      headers: {
        host: url.hostname,
        'content-type': 'application/fhir+json',
        accept: 'application/fhir+json',
      },
    };

    // Sign the request with SigV4
    const signer = signerFactory();
    const signedRequest = await signer.sign(httpRequest);

    // Execute the signed request
    const response = await fetchFn(searchUrl, {
      method: 'GET',
      headers: signedRequest.headers as Record<string, string>,
      signal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      return {
        resourceType,
        resources: [],
        success: false,
        error: `HTTP ${response.status}: ${errorBody.substring(0, 200)}`,
      };
    }

    const bundle = await response.json() as {
      resourceType: string;
      entry?: Array<{ resource: FhirResource }>;
      total?: number;
    };

    // Extract resources from FHIR Bundle
    const resources: FhirResource[] = (bundle.entry || [])
      .map((entry) => entry.resource)
      .filter((resource): resource is FhirResource =>
        resource != null && typeof resource.id === 'string'
      );

    return {
      resourceType,
      resources,
      success: true,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return {
        resourceType,
        resources: [],
        success: false,
        error: 'Query timed out',
      };
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      resourceType,
      resources: [],
      success: false,
      error: errorMessage,
    };
  }
}

// ─── Main Query Function ────────────────────────────────────────────────────

/**
 * Queries HealthLake for clinical evidence across all resource types.
 *
 * - Queries each resource type in parallel
 * - Enforces 60-second timeout with graceful degradation (returns partial results)
 * - Caps total results at 50 items, keeping the most recent
 * - Returns structured result with metadata
 */
export async function queryHealthLake(
  input: HealthLakeQueryInput
): Promise<HealthLakeQueryResult> {
  const startTime = Date.now();

  const { patientId, dateOfService, dateRangeWindowDays } = input;

  // Calculate date range
  const { startDate, endDate } = calculateDateRange(
    dateOfService,
    dateRangeWindowDays ?? DEFAULT_DATE_RANGE_DAYS
  );

  // Set up timeout with AbortController
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), QUERY_TIMEOUT_MS);

  const queriedResourceTypes: FhirResourceType[] = [];
  const failedResourceTypes: FhirResourceType[] = [];
  let allResources: FhirResource[] = [];
  let timedOut = false;
  let errorMessage: string | undefined;

  try {
    // Query all resource types in parallel
    const results = await Promise.allSettled(
      EVIDENCE_RESOURCE_TYPES.map((resourceType) =>
        querySingleResourceType(
          resourceType,
          patientId,
          startDate,
          endDate,
          controller.signal
        )
      )
    );

    // Process results
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const resourceType = EVIDENCE_RESOURCE_TYPES[i];

      if (result.status === 'fulfilled' && result.value.success) {
        queriedResourceTypes.push(resourceType);
        allResources = allResources.concat(result.value.resources);
      } else {
        failedResourceTypes.push(resourceType);
        if (result.status === 'fulfilled' && result.value.error?.includes('timed out')) {
          timedOut = true;
        }
      }
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      timedOut = true;
    } else {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
  } finally {
    clearTimeout(timeoutId);
  }

  // Sort all resources by date (most recent first)
  allResources.sort((a, b) => {
    const dateA = getResourceDate(a);
    const dateB = getResourceDate(b);
    return dateB.localeCompare(dateA);
  });

  const totalRetrieved = allResources.length;
  const capped = totalRetrieved > MAX_EVIDENCE_ITEMS;

  // Enforce 50-item maximum, keeping most recent
  if (capped) {
    allResources = allResources.slice(0, MAX_EVIDENCE_ITEMS);
  }

  const durationMs = Date.now() - startTime;

  return {
    resources: allResources,
    totalRetrieved,
    returnedCount: allResources.length,
    capped,
    durationMs,
    timedOut,
    queriedResourceTypes,
    failedResourceTypes,
    ...(errorMessage && { error: errorMessage }),
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Extracts a sortable date string from a FHIR resource.
 * Looks at common date fields across resource types.
 */
export function getResourceDate(resource: FhirResource): string {
  // Try common date fields in order of preference
  const dateFields = [
    'date',
    'effectiveDateTime',
    'period.start',
    'recordedDate',
    'created',
    'meta.lastUpdated',
  ];

  for (const field of dateFields) {
    const value = getNestedValue(resource, field);
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }

  // Fallback: use meta.lastUpdated if available
  if (resource.meta?.lastUpdated) {
    return resource.meta.lastUpdated;
  }

  // No date found — sort to end
  return '1970-01-01';
}

/**
 * Gets a nested value from an object using dot notation.
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current == null || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}
