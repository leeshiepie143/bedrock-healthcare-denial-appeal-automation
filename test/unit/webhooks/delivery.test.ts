/**
 * Unit tests for Webhook Delivery Lambda
 *
 * Tests webhook delivery with retry logic, exponential backoff,
 * tenant configuration lookup, and error handling.
 *
 * Requirements: 10.5
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  handler,
  setClients,
  resetClients,
  deliverWebhook,
  calculateBackoff,
  getTenantWebhookConfig,
  fetchWithTimeout,
} from '@lambdas/webhooks/delivery';
import type { WebhookPayload } from '@lambdas/webhooks/delivery';

// ─── Mock fetch globally ────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ─── Mock DynamoDB Client ───────────────────────────────────────────────────

function createMockDynamoClient() {
  return {
    send: vi.fn(),
  };
}

// ─── Test Helpers ───────────────────────────────────────────────────────────

function createEventBridgeEvent(
  overrides: Partial<{
    detailType: string;
    detail: Record<string, unknown>;
    time: string;
  }> = {}
): any {
  return {
    version: '0',
    id: 'event-123',
    source: 'denial-appeal-agent',
    account: '123456789012',
    time: overrides.time ?? '2024-01-15T10:00:00Z',
    region: 'us-east-1',
    resources: [],
    'detail-type': overrides.detailType ?? 'workflow.state.changed',
    detail: overrides.detail ?? {
      tenantId: 'tenant-1',
      claimId: 'CLM001',
      status: 'completed',
      currentStep: 'letter_generation',
    },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Webhook Delivery Lambda', () => {
  let mockDynamo: ReturnType<typeof createMockDynamoClient>;

  beforeEach(() => {
    mockDynamo = createMockDynamoClient();
    setClients({ dynamo: mockDynamo as any });
    process.env.TABLE_NAME = 'TestTable';
    mockFetch.mockReset();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    resetClients();
    delete process.env.TABLE_NAME;
    vi.useRealTimers();
  });

  describe('calculateBackoff', () => {
    it('should return 1000ms for attempt 1', () => {
      expect(calculateBackoff(1)).toBe(1000);
    });

    it('should return 2000ms for attempt 2', () => {
      expect(calculateBackoff(2)).toBe(2000);
    });

    it('should return 4000ms for attempt 3', () => {
      expect(calculateBackoff(3)).toBe(4000);
    });
  });

  describe('getTenantWebhookConfig', () => {
    it('should return webhook endpoint and secret from DynamoDB', async () => {
      mockDynamo.send.mockResolvedValueOnce({
        Item: {
          webhook_endpoint: { S: 'https://example.com/webhook' },
          webhook_secret: { S: 'secret-123' },
        },
      });

      const result = await getTenantWebhookConfig('tenant-1');

      expect(result.endpoint).toBe('https://example.com/webhook');
      expect(result.secret).toBe('secret-123');

      const sendCall = mockDynamo.send.mock.calls[0][0];
      expect(sendCall.input.Key).toEqual({
        PK: { S: 'TENANT#tenant-1' },
        SK: { S: 'CONFIG' },
      });
    });

    it('should return null endpoint when tenant config not found', async () => {
      mockDynamo.send.mockResolvedValueOnce({ Item: undefined });

      const result = await getTenantWebhookConfig('nonexistent');

      expect(result.endpoint).toBeNull();
      expect(result.secret).toBe('');
    });

    it('should return null endpoint when webhook_endpoint is not set', async () => {
      mockDynamo.send.mockResolvedValueOnce({
        Item: {
          webhook_secret: { S: 'secret-123' },
        },
      });

      const result = await getTenantWebhookConfig('tenant-1');

      expect(result.endpoint).toBeNull();
    });

    it('should throw when TABLE_NAME is not set', async () => {
      delete process.env.TABLE_NAME;

      await expect(getTenantWebhookConfig('tenant-1')).rejects.toThrow(
        'TABLE_NAME environment variable is not set'
      );
    });
  });

  describe('deliverWebhook', () => {
    const testPayload: WebhookPayload = {
      eventType: 'workflow.state.changed',
      tenantId: 'tenant-1',
      claimId: 'CLM001',
      timestamp: '2024-01-15T10:00:00Z',
      detail: { status: 'completed' },
    };

    it('should deliver successfully on first attempt with 200 response', async () => {
      mockFetch.mockResolvedValueOnce({ status: 200, ok: true });

      const result = await deliverWebhook(
        'https://example.com/webhook',
        testPayload,
        'secret-123'
      );

      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(result.attempts).toBe(1);
      expect(result.deliveryTimeMs).toBeGreaterThanOrEqual(0);

      // Verify fetch was called with correct params
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('https://example.com/webhook');
      expect(options.method).toBe('POST');
      expect(options.headers['Content-Type']).toBe('application/json');
      expect(options.headers['X-Webhook-Secret']).toBe('secret-123');
      expect(JSON.parse(options.body)).toEqual(testPayload);
    });

    it('should deliver successfully on second attempt after first failure', async () => {
      mockFetch
        .mockResolvedValueOnce({ status: 500, ok: false })
        .mockResolvedValueOnce({ status: 200, ok: true });

      const result = await deliverWebhook(
        'https://example.com/webhook',
        testPayload,
        ''
      );

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(2);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should deliver successfully on third attempt after two failures', async () => {
      mockFetch
        .mockResolvedValueOnce({ status: 503, ok: false })
        .mockResolvedValueOnce({ status: 502, ok: false })
        .mockResolvedValueOnce({ status: 200, ok: true });

      const result = await deliverWebhook(
        'https://example.com/webhook',
        testPayload,
        ''
      );

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(3);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('should fail after 3 unsuccessful attempts', async () => {
      mockFetch
        .mockResolvedValueOnce({ status: 500, ok: false })
        .mockResolvedValueOnce({ status: 500, ok: false })
        .mockResolvedValueOnce({ status: 500, ok: false });

      const result = await deliverWebhook(
        'https://example.com/webhook',
        testPayload,
        ''
      );

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(3);
      expect(result.error).toBe('HTTP 500');
      expect(result.statusCode).toBe(500);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('should handle timeout errors and retry', async () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';

      mockFetch
        .mockRejectedValueOnce(abortError)
        .mockResolvedValueOnce({ status: 200, ok: true });

      const result = await deliverWebhook(
        'https://example.com/webhook',
        testPayload,
        ''
      );

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(2);
    });

    it('should handle network errors and retry', async () => {
      mockFetch
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValueOnce({ status: 200, ok: true });

      const result = await deliverWebhook(
        'https://example.com/webhook',
        testPayload,
        ''
      );

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(3);
    });

    it('should fail with timeout error after all retries timeout', async () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';

      mockFetch
        .mockRejectedValueOnce(abortError)
        .mockRejectedValueOnce(abortError)
        .mockRejectedValueOnce(abortError);

      const result = await deliverWebhook(
        'https://example.com/webhook',
        testPayload,
        ''
      );

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(3);
      expect(result.error).toBe('Request timed out');
    });

    it('should not include X-Webhook-Secret header when secret is empty', async () => {
      mockFetch.mockResolvedValueOnce({ status: 200, ok: true });

      await deliverWebhook('https://example.com/webhook', testPayload, '');

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers['X-Webhook-Secret']).toBeUndefined();
    });

    it('should include X-Webhook-Secret header when secret is provided', async () => {
      mockFetch.mockResolvedValueOnce({ status: 200, ok: true });

      await deliverWebhook('https://example.com/webhook', testPayload, 'my-secret');

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers['X-Webhook-Secret']).toBe('my-secret');
    });
  });

  describe('handler', () => {
    it('should deliver webhook when tenant has endpoint configured', async () => {
      mockDynamo.send.mockResolvedValueOnce({
        Item: {
          webhook_endpoint: { S: 'https://example.com/webhook' },
          webhook_secret: { S: 'secret-abc' },
        },
      });
      mockFetch.mockResolvedValueOnce({ status: 200, ok: true });

      const event = createEventBridgeEvent();
      const result = await handler(event);

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(1);

      // Verify payload sent to webhook
      const [, options] = mockFetch.mock.calls[0];
      const sentPayload = JSON.parse(options.body);
      expect(sentPayload.eventType).toBe('workflow.state.changed');
      expect(sentPayload.tenantId).toBe('tenant-1');
      expect(sentPayload.claimId).toBe('CLM001');
      expect(sentPayload.timestamp).toBe('2024-01-15T10:00:00Z');
      expect(sentPayload.detail).toEqual({
        status: 'completed',
        currentStep: 'letter_generation',
      });
    });

    it('should return success with 0 attempts when no webhook endpoint configured', async () => {
      mockDynamo.send.mockResolvedValueOnce({ Item: undefined });

      const event = createEventBridgeEvent();
      const result = await handler(event);

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(0);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should return error when tenantId is missing from event', async () => {
      const event = createEventBridgeEvent({
        detail: { claimId: 'CLM001', status: 'completed' },
      });

      const result = await handler(event);

      expect(result.success).toBe(false);
      expect(result.error).toContain('tenantId');
      expect(mockDynamo.send).not.toHaveBeenCalled();
    });

    it('should return error when claimId is missing from event', async () => {
      const event = createEventBridgeEvent({
        detail: { tenantId: 'tenant-1', status: 'completed' },
      });

      const result = await handler(event);

      expect(result.success).toBe(false);
      expect(result.error).toContain('claimId');
    });

    it('should handle various event types', async () => {
      mockDynamo.send.mockResolvedValueOnce({
        Item: {
          webhook_endpoint: { S: 'https://example.com/webhook' },
          webhook_secret: { S: '' },
        },
      });
      mockFetch.mockResolvedValueOnce({ status: 200, ok: true });

      const event = createEventBridgeEvent({
        detailType: 'appeal.resolved',
        detail: {
          tenantId: 'tenant-1',
          claimId: 'CLM002',
          outcomeType: 'overturn',
        },
      });

      const result = await handler(event);

      expect(result.success).toBe(true);
      const [, options] = mockFetch.mock.calls[0];
      const sentPayload = JSON.parse(options.body);
      expect(sentPayload.eventType).toBe('appeal.resolved');
      expect(sentPayload.claimId).toBe('CLM002');
    });

    it('should handle DynamoDB errors gracefully', async () => {
      mockDynamo.send.mockRejectedValueOnce(new Error('DynamoDB unavailable'));

      const event = createEventBridgeEvent();

      await expect(handler(event)).rejects.toThrow('DynamoDB unavailable');
    });
  });
});
