/**
 * A YouTube video's sponsor segments, from SponsorBlock (sponsor.ajay.app:
 * viewers mark the parts of a video that are sponsor reads, self-promotion or
 * "like and subscribe"), for "skip the sponsor". The idea is the Voqal
 * library's youtube profile, which lists them for its AI.
 *
 * Asked by the first 4 characters of the video ID's SHA-256 (SponsorBlock's
 * k-anonymity lookup), so the service never learns which video is watched;
 * the matching video is picked out here.
 */
import { createHash } from 'node:crypto';

const API = 'https://sponsor.ajay.app/api/skipSegments';
export const CATEGORIES = ['sponsor', 'selfpromo', 'interaction'];
export const CATEGORY_NAMES = { sponsor: 'sponsor', selfpromo: 'self-promotion', interaction: 'subscribe reminder' };
const KEEP_MS = 10 * 60000;
const cache = new Map(); // videoId → { at, segments }

/** → [{ category, start, end }] in seconds, in order; [] when none or not reachable. */
export async function sponsorSegments(videoId, { fetchImpl = fetch, timeoutMs = 1500, now = Date.now() } = {}) {
  const id = String(videoId || '');
  if (!/^[\w-]{6,20}$/.test(id)) return [];
  const kept = cache.get(id);
  if (kept && now - kept.at < KEEP_MS) return kept.segments;
  const prefix = createHash('sha256').update(id).digest('hex').slice(0, 4);
  let segments;
  try {
    const res = await fetchImpl(`${API}/${prefix}?categories=${encodeURIComponent(JSON.stringify(CATEGORIES))}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 404) {
      segments = []; // nothing marked in any video with this prefix
    } else if (!res.ok) {
      return []; // asked again next time
    } else {
      const videos = await res.json();
      const mine = (Array.isArray(videos) ? videos : []).find(v => v?.videoID === id);
      segments = (mine?.segments || [])
        .filter(s => CATEGORIES.includes(s.category) && (s.actionType || 'skip') === 'skip' && Array.isArray(s.segment))
        .map(s => ({ category: s.category, start: Math.round(s.segment[0]), end: Math.round(s.segment[1]) }))
        .filter(s => s.end > s.start)
        .sort((a, b) => a.start - b.start);
    }
  } catch {
    return []; // too slow or offline: asked again next time
  }
  cache.set(id, { at: now, segments });
  return segments;
}

/** The segment "skip the sponsor" skips at `at` seconds: the one playing, or one starting in the next 5 s. */
export function segmentToSkip(segments, at) {
  if (!Number.isFinite(at)) return null;
  return segments.find(s => at >= s.start - 5 && at < s.end - 1) || null;
}

/** The next segment after `at` seconds, or null. */
export function nextSegment(segments, at) {
  return segments.find(s => s.start > at) || null;
}

/** For tests: forget what was looked up. */
export function clearSponsorCache() {
  cache.clear();
}
