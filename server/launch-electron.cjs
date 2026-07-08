/**
 * Launcher that strips ELECTRON_RUN_AS_NODE before starting Electron.
 * This env var (set by electron-builder or other tools) makes require('electron')
 * return a path string instead of the module, crashing the main process.
 */
const { spawn } = require('child_process');

// In plain Node, require('electron') resolves to the electron.exe path —
// unlike node_modules/.bin/electron, which is a POSIX script Windows can't spawn.
const electronPath = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(
  electronPath,
  ['electron-main.cjs'],
  { env, stdio: 'inherit', cwd: __dirname }
);

child.on('exit', (code) => process.exit(code ?? 0));
