#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
if (args[0] === 'router') args.shift();
const usage = args[0] === 'usage';
const script = usage ? (args.shift(), resolve(import.meta.dirname, 'usage-status.mjs'))
  : resolve(import.meta.dirname, 'connection', args[0] === 'service' ? (args.shift(), 'service.py') : 'configure.py');
const child = spawn(usage ? process.execPath : 'python3', [script, ...args], { stdio: 'inherit' });
child.on('error', () => { process.stderr.write('Python 3.14+ is required for the Codex connector.\n'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
