#!/usr/bin/env node
import path from 'node:path';
import { createPlatform } from '../platform.mjs';
import { runPlatformStdioServer } from './session.mjs';

const projectDir = path.resolve(process.env.PROOFGRAPH_PROJECT_DIR || process.cwd());
const overrides = process.env.PROOFGRAPH_DATA_DIR ? { data_dir: path.resolve(process.env.PROOFGRAPH_DATA_DIR) } : {};
const platform = await createPlatform({ projectDir, configPath: process.env.PROOFGRAPH_CONFIG, overrides });

process.on('uncaughtException', (error) => { process.stderr.write(`[proofgraph] uncaught exception: ${error?.stack || error}\n`); process.exitCode = 1; });
process.on('unhandledRejection', (error) => { process.stderr.write(`[proofgraph] unhandled rejection: ${error?.stack || error}\n`); process.exitCode = 1; });
runPlatformStdioServer({ platform });
