/**
 * Bedrock Agent Invoke Handler Lambda
 *
 * API Gateway handler that accepts user messages and invokes the
 * Bedrock Agent for multi-turn conversational denial appeal management.
 *
 * Gated behind the ENABLE_AGENTIC_MODE environment variable.
 * When disabled, returns 404 Not Found.
 *
 * Requirements: 10.4, 10.7
 */

import {
  BedrockAgentRuntimeClient,
  InvokeAgentCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

// ─── Environment Variables ──────────────────────────────────────────────────

function getAgentId(): string {
  return process.env.BEDROCK_AGENT_ID || '';
}

function getAgentAliasId(): string {
  return process.env.BEDROCK_AGENT_ALIAS_ID || '';
}

function isAgenticModeEnabled(): boolean {
  return process.env.ENABLE_AGENTIC_MODE === 'true';
}

// ─── AWS SDK Clients ────────────────────────────────────────────────────────

let agentRuntimeClient: BedrockAgentRuntimeClient | null = null;

function getAgentRuntimeClient(): BedrockAgentRuntimeClient {
  if (!agentRuntimeClient) {
    agentRuntimeClient = new BedrockAgentRuntimeClient({
      region: process.env.AWS_REGION || 'us-east-1',
    });
  }
  return agentRuntimeClient;
}

/** Allows injecting mock clients for testing. */
export function setClients(clients: { agentRuntime?: BedrockAgentRuntimeClient }): void {
  if (clients.agentRuntime) agentRuntimeClient = clients.agentRuntime;
}

/** Resets all clients (useful for testing cleanup). */
export function resetClients(): void {
  agentRuntimeClient = null;
}

// ─── Types ──────────────────────────────────────────────────────────────────

/** Request body for agent invocation */
export interface AgentInvokeRequest {
  message: string;
  session_id?: string;
}

/** Response body from agent invocation */
export interface AgentInvokeResponse {
  response: string;
  session_id: string;
}

// ─── Response Helpers ───────────────────────────────────────────────────────

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token,X-Tenant-Id',
};

function jsonResponse(statusCode: number, body: Record<string, unknown>): APIGatewayProxyResult {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(body),
  };
}

// ─── Main Handler ───────────────────────────────────────────────────────────

/**
 * Lambda handler for invoking the Bedrock Agent via API Gateway.
 *
 * Expects:
 * - x-tenant-id header for tenant isolation
 * - JSON body with `message` (required) and `session_id` (optional)
 *
 * Returns:
 * - 404 if ENABLE_AGENTIC_MODE is not set
 * - 400 for invalid requests
 * - 200 with agent response and session_id
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  // Feature flag gate
  if (!isAgenticModeEnabled()) {
    return jsonResponse(404, {
      error: 'Agentic mode is not enabled',
      message: 'The /agent/invoke endpoint is not available. Set ENABLE_AGENTIC_MODE=true to enable.',
    });
  }

  // Extract tenant ID from header
  const tenantId = event.headers?.['x-tenant-id'] || event.headers?.['X-Tenant-Id'];
  if (!tenantId) {
    return jsonResponse(400, {
      error: 'Missing required header: x-tenant-id',
    });
  }

  // Parse request body
  let input: AgentInvokeRequest;
  try {
    input = JSON.parse(event.body || '{}');
  } catch {
    return jsonResponse(400, {
      error: 'Invalid JSON in request body',
    });
  }

  // Validate message field
  if (!input.message || typeof input.message !== 'string' || input.message.trim().length === 0) {
    return jsonResponse(400, {
      error: 'Missing or empty required field: message',
    });
  }

  // Generate or use existing session ID (scoped to tenant)
  const sessionId = input.session_id || `${tenantId}-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;

  try {
    const client = getAgentRuntimeClient();
    const agentId = getAgentId();
    const agentAliasId = getAgentAliasId();

    if (!agentId || !agentAliasId) {
      return jsonResponse(500, {
        error: 'Agent configuration error: BEDROCK_AGENT_ID and BEDROCK_AGENT_ALIAS_ID must be set',
      });
    }

    const command = new InvokeAgentCommand({
      agentId,
      agentAliasId,
      sessionId,
      inputText: input.message,
      sessionState: {
        sessionAttributes: {
          tenant_id: tenantId,
        },
      },
    });

    const response = await client.send(command);

    // Collect the streamed response chunks
    let agentResponse = '';
    if (response.completion) {
      for await (const event of response.completion) {
        if (event.chunk?.bytes) {
          agentResponse += new TextDecoder().decode(event.chunk.bytes);
        }
      }
    }

    console.info(
      `[AGENT_INVOKE] tenant_id=${tenantId}, session_id=${sessionId}, ` +
      `message_length=${input.message.length}, response_length=${agentResponse.length}`
    );

    return jsonResponse(200, {
      response: agentResponse,
      session_id: sessionId,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const errorName = error instanceof Error ? error.name : 'UnknownError';

    console.error(
      `[AGENT_INVOKE_ERROR] tenant_id=${tenantId}, session_id=${sessionId}, ` +
      `error=${errorName}: ${errorMessage}`
    );

    // Handle specific Bedrock Agent errors
    if (errorName === 'ThrottlingException') {
      return jsonResponse(429, {
        error: 'Rate limit exceeded. Please retry after a brief delay.',
        session_id: sessionId,
      });
    }

    if (errorName === 'ValidationException') {
      return jsonResponse(400, {
        error: 'Invalid request to Bedrock Agent',
        details: errorMessage,
        session_id: sessionId,
      });
    }

    if (errorName === 'AccessDeniedException') {
      return jsonResponse(403, {
        error: 'Access denied to Bedrock Agent',
        session_id: sessionId,
      });
    }

    return jsonResponse(500, {
      error: 'Failed to invoke agent',
      session_id: sessionId,
    });
  }
}
