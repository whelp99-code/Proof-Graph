#!/usr/bin/env node
import process from 'node:process';

const mode = process.env.FAKE_PI_MODE ?? 'settled';
const resultFor = (prompt = '') => {
  const verify = /\(verify\)/.test(prompt);
  return verify
    ? { outcome: 'success', summary: 'pi fake verified', output: { verification: { passed: true, checks: ['pi-rpc-contract'] } }, artifacts: [], dynamic_tasks: [], workspace_actions: [], metadata: {} }
    : { outcome: 'success', summary: 'pi fake completed', output: { result: { unicode: 'line\u2028separator', bytes: Buffer.byteLength(prompt) } }, artifacts: [], dynamic_tasks: [], workspace_actions: [], metadata: {} };
};

let buffer = '';
let promptCommand = null;
function emit(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function complete() {
  const payload = resultFor(promptCommand?.message ?? '');
  emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(payload) }] } });
  emit({ type: 'agent_end', messages: [{ role: 'assistant', content: JSON.stringify(payload) }] });
  if (mode === 'agent-end-only') { setImmediate(() => process.exit(0)); return; }
  emit({ type: 'agent_settled' });
}
function line(raw) {
  if (!raw.trim()) return;
  const command = JSON.parse(raw.replace(/\r$/, ''));
  if (command.type === 'prompt') {
    promptCommand = command;
    emit({ id: command.id, type: 'response', command: 'prompt', success: mode !== 'prompt-error', ...(mode === 'prompt-error' ? { error: 'intentional rejection' } : {}) });
    if (mode === 'prompt-error') return;
    emit({ type: 'agent_start' });
    if (mode === 'malformed') { process.stdout.write('{bad-json\n'); return; }
    if (mode === 'blocking-ui') { emit({ type: 'extension_ui_request', id: 'ui_1', method: 'confirm', title: 'Allow?', message: 'Continue?' }); return; }
    if (mode === 'extension-error') { emit({ type: 'extension_error', error: 'intentional extension failure' }); return; }
    complete();
  } else if (command.type === 'extension_ui_response' && command.id === 'ui_1') {
    if (command.cancelled === true) complete();
  } else if (command.type === 'abort') {
    process.exit(0);
  }
}
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  while (true) {
    const index = buffer.indexOf('\n');
    if (index < 0) break;
    const raw = buffer.slice(0, index); buffer = buffer.slice(index + 1); line(raw);
  }
});
process.stdin.resume();
