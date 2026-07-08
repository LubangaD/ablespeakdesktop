/**
 * Launcher that strips ELECTRON_RUN_AS_NODE before starting Electron.
 * This env var (set by electron-builder or other tools) makes require('electron')
 * return a path string instead of the module, crashing the main process.
 */
const { spawn } = require('child_process');
const path = require('path');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(
  path.join(__dirname, 'node_modules', '.bin', 'electron'),
  ['electron-main.cjs'],
  { env, stdio: 'inherit', cwd: __dirname }
);

child.on('exit', (code) => process.exit(code ?? 0));
