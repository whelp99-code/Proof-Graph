import readline from 'node:readline';
import { asToolError, ValidationError } from './errors.mjs';
import { assertFiniteJson } from './validate.mjs';
import { invokeTool, listTools } from './tools.mjs';
import { VERSION } from '../../runtime/version.mjs';

const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2024-11-05'];
const MAX_LINE_BYTES = 2_000_000;

function response(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function errorResponse(id, code, message, data = undefined) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

function toolResult(value, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError,
  };
}

export class McpSession {
  constructor({ write, context = {}, testMode = process.env.PROOFGRAPH_TEST_MODE === '1' } = {}) {
    this.write = write;
    this.context = { ...context, testMode };
    this.testMode = testMode;
    this.initialized = false;
    this.negotiated = null;
  }

  send(message) {
    this.write(`${JSON.stringify(message)}\n`);
  }

  async handle(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') {
      this.send(errorResponse(message?.id, -32600, 'Invalid Request'));
      return;
    }
    const { id, method, params } = message;
    if (typeof method !== 'string') {
      this.send(errorResponse(id, -32600, 'Invalid Request'));
      return;
    }
    if (method === 'initialize') {
      if (this.initialized || this.negotiated) {
        this.send(errorResponse(id, -32600, 'Already initialized'));
        return;
      }
      const requested = params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0];
      this.negotiated = protocolVersion;
      this.send(response(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: 'proofgraph-claude',
          title: 'ProofGraph Claude Graph and Evidence Server',
          version: VERSION,
          description: 'Local dynamic graph control, bounded verification loops, human approval, and evidence-gated research for Claude Code.',
        },
        instructions: 'Use pg_graph_preview and pg_graph_start for dynamic Graph Engineering, or pg_start_run for legacy evidence research. The server computes graph routes, approval gates, terminal states, and claim classifications.',
      }));
      return;
    }
    if (method === 'notifications/initialized') {
      if (!this.negotiated) return;
      this.initialized = true;
      return;
    }
    if (method.startsWith('notifications/')) return;
    if (method === 'ping') {
      this.send(response(id, {}));
      return;
    }
    if (!this.initialized) {
      this.send(errorResponse(id, -32002, 'Server not initialized'));
      return;
    }
    if (method === 'tools/list') {
      this.send(response(id, { tools: listTools({ testMode: this.testMode }) }));
      return;
    }
    if (method === 'tools/call') {
      const name = params?.name;
      if (typeof name !== 'string' || !listTools({ testMode: this.testMode }).some((tool) => tool.name === name)) {
        this.send(errorResponse(id, -32602, `Unknown tool: ${String(name)}`));
        return;
      }
      try {
        const args = params?.arguments ?? {};
        assertFiniteJson(args);
        const value = await invokeTool(name, args, this.context);
        this.send(response(id, toolResult(value, false)));
      } catch (error) {
        const value = asToolError(error);
        this.send(response(id, toolResult(value, true)));
      }
      return;
    }
    this.send(errorResponse(id, -32601, `Method not found: ${method}`));
  }
}

export function runStdioServer({ input = process.stdin, output = process.stdout, context = {} } = {}) {
  const session = new McpSession({ write: (line) => output.write(line), context });
  const reader = readline.createInterface({ input, crlfDelay: Infinity, terminal: false });
  reader.on('line', async (line) => {
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
      session.send(errorResponse(null, -32700, 'Message exceeds maximum size'));
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      session.send(errorResponse(null, -32700, 'Parse error'));
      return;
    }
    try {
      await session.handle(message);
    } catch (error) {
      process.stderr.write(`[proofgraph-claude] internal MCP error: ${error?.stack || error}\n`);
      session.send(errorResponse(message?.id, -32603, 'Internal error'));
    }
  });
  reader.on('close', () => {
    if (output !== process.stdout) output.end?.();
  });
  return { session, reader };
}
