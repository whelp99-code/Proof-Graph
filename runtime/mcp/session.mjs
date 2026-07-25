import readline from 'node:readline';
import { asToolError } from '../../server/lib/errors.mjs';
import { assertFiniteJson } from '../../server/lib/validate.mjs';
import { PRODUCT_NAME, PRODUCT_TITLE, VERSION } from '../version.mjs';
import { invokePlatformTool, listPlatformTools } from './tools.mjs';

const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2024-11-05'];
const MAX_LINE_BYTES = 2_000_000;
const response = (id, result) => ({ jsonrpc: '2.0', id, result });
const errorResponse = (id, code, message, data = undefined) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } });
const toolResult = (value, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError });

export class PlatformMcpSession {
  constructor({ write, platform }) {
    this.write = write;
    this.platform = platform;
    this.negotiated = null;
    this.initialized = false;
  }
  send(value) { this.write(`${JSON.stringify(value)}\n`); }
  async handle(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') { this.send(errorResponse(message?.id, -32600, 'Invalid Request')); return; }
    const { id, method, params } = message;
    if (typeof method !== 'string') { this.send(errorResponse(id, -32600, 'Invalid Request')); return; }
    if (method === 'initialize') {
      if (this.negotiated) { this.send(errorResponse(id, -32600, 'Already initialized')); return; }
      const requested = params?.protocolVersion;
      this.negotiated = SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0];
      this.send(response(id, {
        protocolVersion: this.negotiated,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: PRODUCT_NAME, title: PRODUCT_TITLE, version: VERSION, description: 'Universal Graph Engineering control plane for AI coding tools.' },
        instructions: 'Compile, execute, inspect, debug, and verify engineering graphs. Vendor adapters are disabled until explicitly configured and live-canary verified.',
      }));
      return;
    }
    if (method === 'notifications/initialized') { if (this.negotiated) this.initialized = true; return; }
    if (method.startsWith('notifications/')) return;
    if (method === 'ping') { this.send(response(id, {})); return; }
    if (!this.initialized) { this.send(errorResponse(id, -32002, 'Server not initialized')); return; }
    if (method === 'tools/list') { this.send(response(id, { tools: listPlatformTools() })); return; }
    if (method === 'tools/call') {
      const name = params?.name;
      if (typeof name !== 'string' || !listPlatformTools().some((tool) => tool.name === name)) { this.send(errorResponse(id, -32602, `Unknown tool: ${String(name)}`)); return; }
      try {
        const args = params?.arguments ?? {};
        assertFiniteJson(args);
        this.send(response(id, toolResult(await invokePlatformTool(name, args, this.platform), false)));
      } catch (error) { this.send(response(id, toolResult(asToolError(error), true))); }
      return;
    }
    this.send(errorResponse(id, -32601, `Method not found: ${method}`));
  }
}

export function runPlatformStdioServer({ input = process.stdin, output = process.stdout, platform }) {
  const session = new PlatformMcpSession({ write: (line) => output.write(line), platform });
  const reader = readline.createInterface({ input, crlfDelay: Infinity, terminal: false });
  let queue = Promise.resolve();
  reader.on('line', (line) => {
    queue = queue.then(async () => {
      if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) { session.send(errorResponse(null, -32700, 'Message exceeds maximum size')); return; }
      let message;
      try { message = JSON.parse(line); } catch { session.send(errorResponse(null, -32700, 'Parse error')); return; }
      await session.handle(message);
    }).catch((error) => {
      process.stderr.write(`[proofgraph] internal MCP error: ${error?.stack || error}\n`);
      session.send(errorResponse(null, -32603, 'Internal error'));
    });
  });
  reader.on('close', async () => { await queue; if (output !== process.stdout) output.end?.(); });
  return { session, reader };
}
