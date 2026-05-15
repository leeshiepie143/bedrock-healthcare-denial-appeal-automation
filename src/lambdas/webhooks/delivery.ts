/**
 * Webhook Delivery Lambda
 *
 * Triggered by EventBridge events for workflow state changes.
 * Looks up the tenant's configured webhook endpoint from DynamoDB,
 * then delivers the event payload via HTTP POST with retry logic.
 *
 * Retry policy: up to 3 attempts with exponential backoff.
 * Timeout: 10 seconds per attempt.
 * Target: < 30 second total webhook delivery time.
 *
 * Requirements: 10.5
 */

import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { EventBridgeEvent } from 'aws-lambda';
import type { TenantConfiguration } from '@shared/models';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WebhookPayload {
  eventType: string;
  tenantId: string;
  claimId: string;
  timestamp: string;
  detail: Record<string, unknown>;
}

export interface WebhookDeliveryResult {
  success: boolean;
  statusCode?: number;
  attempts: number;
  error?: string;
  deliveryTimeMs: number;
}

interface WorkflowStateChangeDetail {
  tenantId: string;
  claimId: string;
  status?: string;
  currentStep?: string;
  [key: string]: unknown;
}

// ─── Configuration ──────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const TIMEOUT_MS = 10_000; // 10 seconds per attempt
const BASE_BACKOFF_MS = 1_000; // 1 second base for exponential backoff

// ─── Client Management (testable via DI) ────────────────────────────────────

interface Clients {
  dynamo: DynamoDBClient;
}

let clients: Clients | null = null;

function getClients(): Clients {
  if (!clients) {
    clients = {
      dynamo: new DynamoDBClient({}),
    };
  }
  return clients;
}

/** Inject mock clients for testing */
export function setClients(mockClients: Clients): void {
  clients = mockClients;
}

/** Reset clients (for test cleanup) */
export function resetClients(): void {
  clients = null;
}

// ─── HTTP Fetch with Timeout ────────────────────────────────────────────────

/**
 * Performs an HTTP POST with a timeout.
 * Uses native fetch (available in Node.js 20+).
 */
export async function fetchWithTimeout(
  url: string,
  body: string,
  timeoutMs: number,
  headers: Record<string, string>
): Promise<{ status: number; ok: boolean }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body,
      signal: controller.signal,
    });
    return { status: response.status, ok: response.ok };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── Core Logic ─────────────────────────────────────────────────────────────

/**
 * Looks up the tenant's webhook configuration from DynamoDB.
 */
export async function getTenantWebhookConfig(
  tenantId: string
): Promise<{ endpoint: string | null; secret: string }> {
  const { dynamo } = getClients();
  const tableName = process.env.TABLE_NAME;

  if (!tableName) {
    throw new Error('TABLE_NAME environment variable is not set');
  }

  const result = await dynamo.send(
    new GetItemCommand({
      TableName: tableName,
      Key: {
        PK: { S: `TENANT#${tenantId}` },
        SK: { S: 'CONFIG' },
      },
      ProjectionExpression: 'webhook_endpoint, webhook_secret',
    })
  );

  if (!result.Item) {
    return { endpoint: null, secret: '' };
  }

  const config = unmarshall(result.Item) as Partial<TenantConfiguration>;
  return {
    endpoint: config.webhook_endpoint ?? null,
    secret: config.webhook_secret ?? '',
  };
}

/**
 * Calculates exponential backoff delay for a given attempt number.
 * Attempt 1: 1s, Attempt 2: 2s, Attempt 3: 4s
 */
export function calculateBackoff(attempt: number): number {
  return BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
}

/**
 * Sleeps for the specified duration in milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Delivers a webhook payload to the configured endpoint with retry logic.
 * Retries up to 3 times with exponential backoff if the endpoint
 * doesn't respond with a 2xx status within 10 seconds.
 */
export async function deliverWebhook(
  endpoint: string,
  payload: WebhookPayload,
  webhookSecret: string
): Promise<WebhookDeliveryResult> {
  const startTime = Date.now();
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {};

  if (webhookSecret) {
    headers['X-Webhook-Secret'] = webhookSecret;
  }

  let lastError: string | undefined;
  let lastStatusCode: number | undefined;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetchWithTimeout(endpoint, body, TIMEOUT_MS, headers);
      lastStatusCode = response.status;

      if (response.ok) {
        const deliveryTimeMs = Date.now() - startTime;
        console.log(
          JSON.stringify({
            level: 'INFO',
            message: 'Webhook delivered successfully',
            endpoint,
            attempt,
            statusCode: response.status,
            deliveryTimeMs,
            eventType: payload.eventType,
            tenantId: payload.tenantId,
            claimId: payload.claimId,
          })
        );
        return {
          success: true,
          statusCode: response.status,
          attempts: attempt,
          deliveryTimeMs,
        };
      }

      // Non-2xx response — retry
      lastError = `HTTP ${response.status}`;
      console.log(
        JSON.stringify({
          level: 'WARN',
          message: 'Webhook delivery failed with non-2xx response',
          endpoint,
          attempt,
          statusCode: response.status,
          eventType: payload.eventType,
          tenantId: payload.tenantId,
        })
      );
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const isTimeout = error instanceof Error && error.name === 'AbortError';
      lastError = isTimeout ? 'Request timed out' : errorMessage;

      console.log(
        JSON.stringify({
          level: 'WARN',
          message: isTimeout ? 'Webhook delivery timed out' : 'Webhook delivery error',
          endpoint,
          attempt,
          error: lastError,
          eventType: payload.eventType,
          tenantId: payload.tenantId,
        })
      );
    }

    // Wait before retrying (except after the last attempt)
    if (attempt < MAX_RETRIES) {
      const backoffMs = calculateBackoff(attempt);
      await sleep(backoffMs);
    }
  }

  // All retries exhausted
  const deliveryTimeMs = Date.now() - startTime;
  console.log(
    JSON.stringify({
      level: 'ERROR',
      message: 'Webhook delivery failed after all retries',
      endpoint,
      attempts: MAX_RETRIES,
      lastError,
      lastStatusCode,
      deliveryTimeMs,
      eventType: payload.eventType,
      tenantId: payload.tenantId,
      claimId: payload.claimId,
    })
  );

  return {
    success: false,
    statusCode: lastStatusCode,
    attempts: MAX_RETRIES,
    error: lastError,
    deliveryTimeMs,
  };
}

// ─── Lambda Handler ─────────────────────────────────────────────────────────

/**
 * EventBridge event handler for webhook delivery.
 * Extracts tenant ID from the event, looks up webhook config,
 * and delivers the event payload to the tenant's endpoint.
 */
export async function handler(
  event: EventBridgeEvent<string, WorkflowStateChangeDetail>
): Promise<WebhookDeliveryResult> {
  const { tenantId, claimId, ...rest } = event.detail;

  if (!tenantId) {
    console.log(
      JSON.stringify({
        level: 'ERROR',
        message: 'Missing tenantId in event detail',
        eventType: event['detail-type'],
      })
    );
    return {
      success: false,
      attempts: 0,
      error: 'Missing tenantId in event detail',
      deliveryTimeMs: 0,
    };
  }

  if (!claimId) {
    console.log(
      JSON.stringify({
        level: 'ERROR',
        message: 'Missing claimId in event detail',
        eventType: event['detail-type'],
        tenantId,
      })
    );
    return {
      success: false,
      attempts: 0,
      error: 'Missing claimId in event detail',
      deliveryTimeMs: 0,
    };
  }

  // Look up tenant webhook configuration
  const { endpoint, secret } = await getTenantWebhookConfig(tenantId);

  if (!endpoint) {
    console.log(
      JSON.stringify({
        level: 'INFO',
        message: 'No webhook endpoint configured for tenant',
        tenantId,
        eventType: event['detail-type'],
      })
    );
    return {
      success: true, // Not a failure — tenant simply has no webhook configured
      attempts: 0,
      deliveryTimeMs: 0,
    };
  }

  // Build webhook payload
  const payload: WebhookPayload = {
    eventType: event['detail-type'],
    tenantId,
    claimId,
    timestamp: event.time,
    detail: rest,
  };

  // Deliver with retries
  return deliverWebhook(endpoint, payload, secret);
}
