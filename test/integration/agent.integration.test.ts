/**
 * Integration tests for the Bedrock Agent invoke handler (agentic mode).
 *
 * Tests verify:
 * - Feature flag gating (404 when disabled)
 * - Successful agent invocation with mocked Bedrock Agent Runtime
 * - Multi-turn session context preservation
 * - Tenant isolation via x-tenant-id header
 * - Graceful error handling for Bedrock Agent failures
 *
 * Requirements: 10.1, 10.4, 10.6
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  handler,
  setClients,
  resetClients,
} from '@lambdas/agent/invoke-handler';
import type { APIGatewayProxyEvent } from 'aws-lambda';

// ─── Mock Bedrock Agent Runtime Client ──────────────────────────────────────

function createMockAgentRuntimeClient() {
  return {
    send: vi.fn(),
  };
}

/**
 * Creates a mock async iterable that simulates the Bedrock Agent
 * streaming response (completion chunks).
 */
function createMockCompletionStream(responseText: string) {
  const encoder = new TextEncoder();
  const chunks = [{ chunk: { bytes: encoder.encode(responseText) } }];

  return {
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

// ─── Test Helpers ───────────────────────────────────────────────────────────

function createApiEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    path: '/agent/invoke',
    pathParameters: null,
    queryStringParameters: null,
    headers: {
      'x-tenant-id': 'tenant-1',
    },
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    body: JSON.stringify({ message: 'What is the status of claim CLM001?' }),
    isBase64Encoded: false,
    stageVariables: null,
    requestContext: {} as APIGatewayProxyEvent['requestContext'],
    resource: '',
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Agent Invoke Handler - Integration Tests', () => {
  let mockClient: ReturnType<typeof createMockAgentRuntimeClient>;

  beforeEach(() => {
    mockClient = createMockAgentRuntimeClient();
    setClients({ agentRuntime: mockClient as any });
    process.env.BEDROCK_AGENT_ID = 'test-agent-id';
    process.env.BEDROCK_AGENT_ALIAS_ID = 'test-alias-id';
  });

  afterEach(() => {
    resetClients();
    delete process.env.ENABLE_AGENTIC_MODE;
    delete process.env.BEDROCK_AGENT_ID;
    delete process.env.BEDROCK_AGENT_ALIAS_ID;
  });

  describe('Feature flag gating', () => {
    it('should return 404 when ENABLE_AGENTIC_MODE is not set', async () => {
      delete process.env.ENABLE_AGENTIC_MODE;

      const event = createApiEvent();
      const result = await handler(event);

      expect(result.statusCode).toBe(404);
      const body = JSON.parse(result.body);
      expect(body.error).toBe('Agentic mode is not enabled');
      expect(body.message).toContain('ENABLE_AGENTIC_MODE');
    });

    it('should return 404 when ENABLE_AGENTIC_MODE is set to false', async () => {
      process.env.ENABLE_AGENTIC_MODE = 'false';

      const event = createApiEvent();
      const result = await handler(event);

      expect(result.statusCode).toBe(404);
      const body = JSON.parse(result.body);
      expect(body.error).toBe('Agentic mode is not enabled');
    });

    it('should proceed when ENABLE_AGENTIC_MODE is set to true', async () => {
      process.env.ENABLE_AGENTIC_MODE = 'true';

      mockClient.send.mockResolvedValueOnce({
        completion: createMockCompletionStream('Claim CLM001 is currently in progress.'),
      });

      const event = createApiEvent();
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
    });
  });

  describe('Successful agent invocation', () => {
    beforeEach(() => {
      process.env.ENABLE_AGENTIC_MODE = 'true';
    });

    it('should accept a message and return a response', async () => {
      const expectedResponse = 'Claim CLM001 is currently in the evidence retrieval stage.';
      mockClient.send.mockResolvedValueOnce({
        completion: createMockCompletionStream(expectedResponse),
      });

      const event = createApiEvent({
        body: JSON.stringify({ message: 'What is the status of claim CLM001?' }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.response).toBe(expectedResponse);
      expect(body.session_id).toBeDefined();
      expect(typeof body.session_id).toBe('string');
    });

    it('should generate a session_id when none is provided', async () => {
      mockClient.send.mockResolvedValueOnce({
        completion: createMockCompletionStream('Response text'),
      });

      const event = createApiEvent({
        body: JSON.stringify({ message: 'Hello' }),
        headers: { 'x-tenant-id': 'tenant-abc' },
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.session_id).toContain('tenant-abc');
    });

    it('should use provided session_id for multi-turn conversations', async () => {
      const sessionId = 'existing-session-123';
      mockClient.send.mockResolvedValueOnce({
        completion: createMockCompletionStream('Follow-up response'),
      });

      const event = createApiEvent({
        body: JSON.stringify({
          message: 'Tell me more about the denial reason',
          session_id: sessionId,
        }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.session_id).toBe(sessionId);

      // Verify the session_id was passed to the Bedrock Agent
      const sendCall = mockClient.send.mock.calls[0][0];
      expect(sendCall.input.sessionId).toBe(sessionId);
    });

    it('should pass the input message to the Bedrock Agent', async () => {
      const userMessage = 'Classify the denial for claim CLM-999';
      mockClient.send.mockResolvedValueOnce({
        completion: createMockCompletionStream('Classification complete.'),
      });

      const event = createApiEvent({
        body: JSON.stringify({ message: userMessage }),
      });

      await handler(event);

      const sendCall = mockClient.send.mock.calls[0][0];
      expect(sendCall.input.inputText).toBe(userMessage);
      expect(sendCall.input.agentId).toBe('test-agent-id');
      expect(sendCall.input.agentAliasId).toBe('test-alias-id');
    });
  });

  describe('Multi-turn conversation context', () => {
    beforeEach(() => {
      process.env.ENABLE_AGENTIC_MODE = 'true';
    });

    it('should maintain session context across multiple invocations', async () => {
      const sessionId = 'multi-turn-session-001';

      // First turn
      mockClient.send.mockResolvedValueOnce({
        completion: createMockCompletionStream('I found claim CLM001. It was denied for reason CO-50.'),
      });

      const firstEvent = createApiEvent({
        body: JSON.stringify({
          message: 'Look up claim CLM001',
          session_id: sessionId,
        }),
      });

      const firstResult = await handler(firstEvent);
      expect(firstResult.statusCode).toBe(200);
      const firstBody = JSON.parse(firstResult.body);
      expect(firstBody.session_id).toBe(sessionId);

      // Second turn (same session)
      mockClient.send.mockResolvedValueOnce({
        completion: createMockCompletionStream('The viability score for this appeal is 0.72. I recommend pursuing.'),
      });

      const secondEvent = createApiEvent({
        body: JSON.stringify({
          message: 'What is the viability of appealing this?',
          session_id: sessionId,
        }),
      });

      const secondResult = await handler(secondEvent);
      expect(secondResult.statusCode).toBe(200);
      const secondBody = JSON.parse(secondResult.body);
      expect(secondBody.session_id).toBe(sessionId);

      // Verify both calls used the same session ID
      expect(mockClient.send.mock.calls[0][0].input.sessionId).toBe(sessionId);
      expect(mockClient.send.mock.calls[1][0].input.sessionId).toBe(sessionId);
    });
  });

  describe('Tenant isolation', () => {
    beforeEach(() => {
      process.env.ENABLE_AGENTIC_MODE = 'true';
    });

    it('should require x-tenant-id header', async () => {
      const event = createApiEvent({
        headers: {},
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toContain('x-tenant-id');
    });

    it('should accept X-Tenant-Id header (case variation)', async () => {
      mockClient.send.mockResolvedValueOnce({
        completion: createMockCompletionStream('Response'),
      });

      const event = createApiEvent({
        headers: { 'X-Tenant-Id': 'tenant-2' },
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
    });

    it('should pass tenant_id in session attributes to the agent', async () => {
      mockClient.send.mockResolvedValueOnce({
        completion: createMockCompletionStream('Response'),
      });

      const event = createApiEvent({
        headers: { 'x-tenant-id': 'tenant-xyz' },
      });

      await handler(event);

      const sendCall = mockClient.send.mock.calls[0][0];
      expect(sendCall.input.sessionState.sessionAttributes.tenant_id).toBe('tenant-xyz');
    });

    it('should scope generated session_id to the tenant', async () => {
      mockClient.send.mockResolvedValueOnce({
        completion: createMockCompletionStream('Response'),
      });

      const event = createApiEvent({
        headers: { 'x-tenant-id': 'tenant-isolated' },
        body: JSON.stringify({ message: 'Hello' }),
      });

      const result = await handler(event);
      const body = JSON.parse(result.body);

      expect(body.session_id).toContain('tenant-isolated');
    });
  });

  describe('Error handling', () => {
    beforeEach(() => {
      process.env.ENABLE_AGENTIC_MODE = 'true';
    });

    it('should return 400 for invalid JSON body', async () => {
      const event = createApiEvent({
        body: 'not valid json{{{',
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toContain('Invalid JSON');
    });

    it('should return 400 for missing message field', async () => {
      const event = createApiEvent({
        body: JSON.stringify({}),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toContain('message');
    });

    it('should return 400 for empty message', async () => {
      const event = createApiEvent({
        body: JSON.stringify({ message: '   ' }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toContain('message');
    });

    it('should return 500 when agent configuration is missing', async () => {
      delete process.env.BEDROCK_AGENT_ID;
      delete process.env.BEDROCK_AGENT_ALIAS_ID;

      const event = createApiEvent();
      const result = await handler(event);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.error).toContain('Agent configuration error');
    });

    it('should return 429 for ThrottlingException from Bedrock', async () => {
      const throttleError = new Error('Rate exceeded');
      throttleError.name = 'ThrottlingException';
      mockClient.send.mockRejectedValueOnce(throttleError);

      const event = createApiEvent();
      const result = await handler(event);

      expect(result.statusCode).toBe(429);
      const body = JSON.parse(result.body);
      expect(body.error).toContain('Rate limit');
      expect(body.session_id).toBeDefined();
    });

    it('should return 400 for ValidationException from Bedrock', async () => {
      const validationError = new Error('Invalid input text');
      validationError.name = 'ValidationException';
      mockClient.send.mockRejectedValueOnce(validationError);

      const event = createApiEvent();
      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toContain('Invalid request');
      expect(body.details).toBe('Invalid input text');
    });

    it('should return 403 for AccessDeniedException from Bedrock', async () => {
      const accessError = new Error('Not authorized');
      accessError.name = 'AccessDeniedException';
      mockClient.send.mockRejectedValueOnce(accessError);

      const event = createApiEvent();
      const result = await handler(event);

      expect(result.statusCode).toBe(403);
      const body = JSON.parse(result.body);
      expect(body.error).toContain('Access denied');
    });

    it('should return 500 for unexpected errors', async () => {
      mockClient.send.mockRejectedValueOnce(new Error('Something went wrong'));

      const event = createApiEvent();
      const result = await handler(event);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.error).toBe('Failed to invoke agent');
      expect(body.session_id).toBeDefined();
    });

    it('should handle empty completion stream gracefully', async () => {
      mockClient.send.mockResolvedValueOnce({
        completion: {
          [Symbol.asyncIterator]: async function* () {
            // Empty stream - no chunks
          },
        },
      });

      const event = createApiEvent();
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.response).toBe('');
      expect(body.session_id).toBeDefined();
    });

    it('should handle null completion gracefully', async () => {
      mockClient.send.mockResolvedValueOnce({
        completion: null,
      });

      const event = createApiEvent();
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.response).toBe('');
    });
  });

  describe('Response format', () => {
    beforeEach(() => {
      process.env.ENABLE_AGENTIC_MODE = 'true';
    });

    it('should include CORS headers in all responses', async () => {
      mockClient.send.mockResolvedValueOnce({
        completion: createMockCompletionStream('Response'),
      });

      const event = createApiEvent();
      const result = await handler(event);

      expect(result.headers?.['Content-Type']).toBe('application/json');
      expect(result.headers?.['Access-Control-Allow-Origin']).toBe('*');
      expect(result.headers?.['Access-Control-Allow-Headers']).toContain('X-Tenant-Id');
    });

    it('should include CORS headers in error responses', async () => {
      delete process.env.ENABLE_AGENTIC_MODE;

      const event = createApiEvent();
      const result = await handler(event);

      expect(result.headers?.['Content-Type']).toBe('application/json');
      expect(result.headers?.['Access-Control-Allow-Origin']).toBe('*');
    });
  });
});
