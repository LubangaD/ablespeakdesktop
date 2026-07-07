import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getAppSettings, saveAppSettings, _setSettingsPath } from './app-settings.js';

const DEFAULTS = {
  autoStart: false,
  wakeWordEnabled: true,
  wakeWordPhrases: ['hey able', 'able speak'],
  setupComplete: false,
  deviceId: '',
  sync: { enabled: false, role: 'sender', targetUrl: '', classroomKey: '', intervalMs: 30000 },
};

let tmpDir;

// Helper: set an isolated temp path for each test group
function makeTmpPath() {
  tmpDir = mkdtempSync(join(tmpdir(), 'ablespeak-test-'));
  const p = join(tmpDir, 'app-settings.json');
  _setSettingsPath(p);
  return p;
}

function cleanup() {
  if (tmpDir && existsSync(tmpDir)) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ── Defaults ──

test('getAppSettings: missing file returns defaults', () => {
  makeTmpPath();
  try {
    const s = getAppSettings();
    assert.equal(s.autoStart, false);
    assert.equal(s.wakeWordEnabled, true);
    assert.deepEqual(s.wakeWordPhrases, ['hey able', 'able speak']);
    assert.equal(s.setupComplete, false);
    // T4: new defaults
    assert.equal(s.deviceId, '');
    assert.equal(s.sync.enabled, false);
    assert.equal(s.sync.role, 'sender');
    assert.equal(s.sync.targetUrl, '');
    assert.equal(s.sync.classroomKey, '');
    assert.equal(s.sync.intervalMs, 30000);
  } finally { cleanup(); }
});

test('getAppSettings: all default fields present', () => {
  makeTmpPath();
  try {
    const s = getAppSettings();
    assert.ok('autoStart' in s);
    assert.ok('wakeWordEnabled' in s);
    assert.ok('wakeWordPhrases' in s);
    assert.ok('setupComplete' in s);
    assert.ok('deviceId' in s);
    assert.ok('sync' in s);
  } finally { cleanup(); }
});

// ── Read/Write ──

test('saveAppSettings: writes file and getAppSettings reads it back', () => {
  const p = makeTmpPath();
  try {
    saveAppSettings({ autoStart: true });
    assert.ok(existsSync(p), 'settings file should exist after save');
    const s = getAppSettings();
    assert.equal(s.autoStart, true);
  } finally { cleanup(); }
});

test('saveAppSettings: merges patch; unset keys keep defaults', () => {
  makeTmpPath();
  try {
    saveAppSettings({ setupComplete: true });
    const s = getAppSettings();
    assert.equal(s.setupComplete, true);
    assert.equal(s.autoStart, false);  // default preserved
    assert.equal(s.wakeWordEnabled, true);  // default preserved
  } finally { cleanup(); }
});

test('saveAppSettings: successive patches accumulate', () => {
  makeTmpPath();
  try {
    saveAppSettings({ autoStart: true });
    saveAppSettings({ setupComplete: true });
    const s = getAppSettings();
    assert.equal(s.autoStart, true);
    assert.equal(s.setupComplete, true);
  } finally { cleanup(); }
});

test('saveAppSettings: wakeWordPhrases can be updated', () => {
  makeTmpPath();
  try {
    saveAppSettings({ wakeWordPhrases: ['ok able', 'hey computer'] });
    const s = getAppSettings();
    assert.deepEqual(s.wakeWordPhrases, ['ok able', 'hey computer']);
  } finally { cleanup(); }
});

test('saveAppSettings: writes atomically (tmp+rename) — file is valid JSON on disk', () => {
  const p = makeTmpPath();
  try {
    saveAppSettings({ autoStart: true });
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.autoStart, true);
  } finally { cleanup(); }
});

test('saveAppSettings: wakeWordEnabled can be toggled off', () => {
  makeTmpPath();
  try {
    saveAppSettings({ wakeWordEnabled: false });
    assert.equal(getAppSettings().wakeWordEnabled, false);
  } finally { cleanup(); }
});

// ── T4: sync defaults + deviceId ──

test('saveAppSettings: deviceId auto-generated on first write', () => {
  makeTmpPath();
  try {
    saveAppSettings({ autoStart: false });
    const s = getAppSettings();
    assert.ok(s.deviceId, 'deviceId should be non-empty after first write');
    assert.match(s.deviceId, /^[0-9a-f]{8}-[0-9a-f]{4}-/i);
  } finally { cleanup(); }
});

test('saveAppSettings: deviceId stable across successive writes', () => {
  makeTmpPath();
  try {
    saveAppSettings({});
    const first = getAppSettings().deviceId;
    saveAppSettings({ autoStart: true });
    const second = getAppSettings().deviceId;
    assert.equal(first, second, 'deviceId should not change on subsequent writes');
  } finally { cleanup(); }
});

test('saveAppSettings: sync sub-object merges shallowly', () => {
  makeTmpPath();
  try {
    saveAppSettings({ sync: { enabled: true, role: 'receiver' } });
    const s = getAppSettings();
    assert.equal(s.sync.enabled, true);
    assert.equal(s.sync.role, 'receiver');
    // Other sync fields retain defaults
    assert.equal(s.sync.intervalMs, 30000);
    assert.equal(s.sync.targetUrl, '');
  } finally { cleanup(); }
});
