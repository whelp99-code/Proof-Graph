#!/usr/bin/env node
import process from 'node:process';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('fake-agent 1.2.3\n');
  process.exit(0);
}

function result(prompt = '') {
  const verify = prompt.includes('Node:') && prompt.includes('(verify)');
  return verify
    ? { outcome: 'success', summary: 'fake verified', output: { verification: { passed: true, checks: ['fake-cli'] }, result: { prompt_bytes: Buffer.byteLength(prompt) } } }
    : { outcome: 'success', summary: 'fake completed', output: { result: { prompt_bytes: Buffer.byteLength(prompt) } } };
}

if (args.includes('--mode') && args[args.indexOf('--mode') + 1] === 'rpc') {
  let buffer = '';
  process.stdin.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const newline = buffer.indexOf('\n');
    if (newline < 0) return;
    const command = JSON.parse(buffer.slice(0, newline));
    const payload = result(command.message);
    process.stdout.write(`${JSON.stringify({ id: command.id, type: 'response', command: 'prompt', success: true })}\n`);
    process.stdout.write(`${JSON.stringify({ type: 'agent_start' })}\n`);
    process.stdout.write(`${JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(payload) }] } })}\n`);
    process.stdout.write(`${JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant', content: JSON.stringify(payload) }] })}\n`);
  });
  process.stdin.resume();
} else {
  let stdin = '';
  process.stdin.on('data', (chunk) => { stdin += chunk.toString('utf8'); });
  process.stdin.on('end', () => {
    const prompt = stdin || args.at(-1) || '';
    const payload = result(prompt);
    switch (process.env.FAKE_AGENT_SHAPE) {
      case 'nested': process.stdout.write(JSON.stringify({ type: 'result', result: JSON.stringify(payload) })); break;
      case 'jsonl':
        process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 't1' })}\n`);
        process.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(payload) } })}\n`);
        break;
      case 'fenced': process.stdout.write(`\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``); break;
      case 'malformed': process.stdout.write('{not-json'); break;
      case 'oversize': process.stdout.write('x'.repeat(2_500_000)); break;
      case 'exit': process.stderr.write('intentional failure\n'); process.exitCode = 7; break;
      case 'sleep': setTimeout(() => process.stdout.write(JSON.stringify(payload)), 5_000); break;
      default: process.stdout.write(JSON.stringify(payload));
    }
  });
  process.stdin.resume();
}
