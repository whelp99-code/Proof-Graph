#!/usr/bin/env node
import { runStdioServer } from './lib/mcp.mjs';

process.on('uncaughtException', (error) => {
  process.stderr.write(`[proofgraph-claude] uncaught exception: ${error?.stack || error}\n`);
  process.exitCode = 1;
});

process.on('unhandledRejection', (error) => {
  process.stderr.write(`[proofgraph-claude] unhandled rejection: ${error?.stack || error}\n`);
  process.exitCode = 1;
});

runStdioServer();
