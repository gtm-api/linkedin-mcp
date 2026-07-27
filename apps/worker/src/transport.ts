import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { type JSONRPCMessage, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

// In-memory transport: ferries one JSON-RPC message to a fresh McpServer and
// resolves with its response. No shared state - safe for concurrent requests
// in one isolate.
class WorkerTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private pending = new Map<string | number, (msg: JSONRPCMessage) => void>();

  async start(): Promise<void> {}
  async close(): Promise<void> {
    this.onclose?.();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const id = (message as { id?: string | number }).id;
    if (id != null) {
      const resolve = this.pending.get(id);
      if (resolve) {
        this.pending.delete(id);
        resolve(message);
      }
    }
  }

  dispatch(message: JSONRPCMessage): Promise<JSONRPCMessage | null> {
    const id = (message as { id?: string | number }).id;
    if (id == null) {
      this.onmessage?.(message);
      return Promise.resolve(null);
    }
    return new Promise<JSONRPCMessage>((resolve) => {
      this.pending.set(id, resolve);
      this.onmessage?.(message);
    });
  }
}

// Stateless MCP: each request gets a fresh server. Non-initialize messages are
// primed with a synthetic initialize so the SDK server is ready to answer
// tools/list and tools/call within this single request.
export async function handleMcpMessage(
  server: McpServer,
  message: JSONRPCMessage,
): Promise<JSONRPCMessage | null> {
  const transport = new WorkerTransport();
  await server.connect(transport);
  try {
    const method = (message as { method?: string }).method;
    if (method && method !== 'initialize') {
      await transport.dispatch({
        jsonrpc: '2.0',
        id: '__prime_init__',
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'gtm-mcp-stateless-primer', version: '0.0.0' },
        },
      } as JSONRPCMessage);
    }
    return await transport.dispatch(message);
  } finally {
    await server.close().catch(() => {});
  }
}
