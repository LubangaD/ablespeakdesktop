/**
 * AbleSpeak T4 Sync Receiver Routes — teacher-hosted ingest + status.
 *
 * POST /api/sync/ingest — student devices push encrypted row batches here.
 *   404 unless this device is an enabled receiver (endpoint invisible otherwise).
 *   401 on ANY decrypt failure — identical response for wrong key / tamper / malformed
 *   package, so a probing client learns nothing about which part failed.
 *   413 for payloads over 5MB.
 *
 * GET /api/sync/status — role, enabled, deviceId, per-table cursors, last sync/ingest
 *   times, devices seen. SECURITY: classroomKey is NEVER included (only a boolean
 *   `configured` flag).
 */

import express, { Router } from 'express';
import { decryptPayload } from '../sync-crypto.js';
import { ingestRows, getSyncCursor } from '../db.js';
import { getAppSettings } from '../app-settings.js';
import { SYNC_TABLES } from '../sync-client.js';

const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024; // 5MB

export function createSyncRouter({ syncClient } = {}) {
  const router = Router();

  // Route-level body parser: 6mb cap for sync ingest payloads.
  // Registered on this router before index.js mounts the global body parser so a >6mb
  // ingest returns 413 at the parser level rather than being absorbed by a larger global limit.
  // DO NOT raise this limit — use the manual approxBytes check below for the 5MB content cap.
  router.use('/sync/ingest', express.json({ limit: '6mb' }));

  // Receiver-side state (in-process): last ingest time + devices seen
  let lastIngestAt = null;
  const devicesSeen = new Map(); // deviceId → last seen ISO time

  router.post('/sync/ingest', (req, res) => {
    const settings = getAppSettings();
    const sync = settings.sync || {};
    if (!sync.enabled || sync.role !== 'receiver') {
      return res.status(404).json({ error: 'Not found' });
    }

    const { deviceId, package: pkg } = req.body || {};
    if (!deviceId || typeof deviceId !== 'string' || !pkg || typeof pkg !== 'object') {
      return res.status(400).json({ error: 'deviceId and package are required' });
    }

    // Size cap — check the encrypted data field (dominant part of the payload)
    const approxBytes = (pkg.data?.length || 0) + (pkg.salt?.length || 0) + (pkg.iv?.length || 0) + (pkg.tag?.length || 0);
    if (approxBytes > MAX_PAYLOAD_BYTES) {
      return res.status(413).json({ error: 'Payload too large' });
    }

    // Decrypt — identical 401 for every failure mode (wrong key, tamper, malformed)
    let payload;
    try {
      payload = decryptPayload(pkg, sync.classroomKey);
    } catch {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const batches = Array.isArray(payload?.batches) ? payload.batches : [];
    const counts = {};
    for (const batch of batches) {
      if (!batch || !SYNC_TABLES.includes(batch.table) || !Array.isArray(batch.rows)) continue;
      try {
        counts[batch.table] = ingestRows(batch.table, batch.rows, deviceId);
      } catch (err) {
        // Row-level failure must not lose the rest of the batch set
        counts[batch.table] = { inserted: 0, skipped: batch.rows.length, error: 'ingest_failed' };
      }
    }

    lastIngestAt = new Date().toISOString();
    devicesSeen.set(deviceId, lastIngestAt);

    res.json({ ok: true, counts });
  });

  router.get('/sync/status', (req, res) => {
    const settings = getAppSettings();
    const sync = settings.sync || {};
    const cursors = {};
    for (const t of SYNC_TABLES) {
      try { cursors[t] = getSyncCursor(t); } catch { cursors[t] = '0'; }
    }

    // SECURITY: no classroomKey anywhere in this response — boolean flag only
    res.json({
      role: sync.role || 'sender',
      enabled: !!sync.enabled,
      deviceId: settings.deviceId || '',
      configured: !!sync.classroomKey,
      targetUrl: sync.targetUrl || '',
      intervalMs: sync.intervalMs || 30000,
      cursors,
      lastSyncAt: syncClient ? syncClient.lastSuccessAt : null,
      lastSyncError: syncClient ? syncClient.lastError : null,
      lastIngestAt,
      devicesSeen: [...devicesSeen.entries()].map(([id, at]) => ({ deviceId: id, lastSeenAt: at })),
    });
  });

  return router;
}
