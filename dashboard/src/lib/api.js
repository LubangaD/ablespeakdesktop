const API_BASE = '/api';

// The admin PIN unlock key (server/src/admin-pin.js). Kept in memory only, so
// closing or reloading the dashboard locks the developer pages again.
let adminToken = '';
export const ADMIN_EVENT = 'ablespeak-admin';

export function setAdminToken(token) {
  adminToken = token || '';
  window.dispatchEvent(new CustomEvent(ADMIN_EVENT, { detail: { unlocked: !!adminToken } }));
}

async function fetchApi(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(adminToken ? { 'X-AbleSpeak-Admin': adminToken } : {}),
      ...options.headers,
    },
  });
  if (!res.ok) {
    // Prefer the server's own explanation when it sends one.
    const body = await res.json().catch(() => null);
    // The unlock ran out: lock the developer pages so the PIN screen shows.
    if (body?.adminRequired && adminToken) setAdminToken('');
    const err = new Error(body?.error || body?.message || `API ${path}: ${res.status}`);
    err.status = res.status;
    err.adminRequired = !!body?.adminRequired;
    err.body = body; // anything else the server sent with it (setup steps)
    throw err;
  }
  return res.json();
}

export const api = {
  // Admin PIN for the developer pages
  getAdminStatus: () => fetchApi('/admin/status'),
  setAdminPin: (pin, currentPin) => fetchApi('/admin/pin', {
    method: 'POST',
    body: JSON.stringify(currentPin ? { pin, currentPin } : { pin }),
  }),
  unlockAdmin: (pin) => fetchApi('/admin/unlock', { method: 'POST', body: JSON.stringify({ pin }) }),
  lockAdmin: () => fetchApi('/admin/lock', { method: 'POST' }),
  // The helper PIN (admin only): opens just the Users page. null removes it.
  setHelperPin: (pin) => fetchApi('/admin/helper-pin', { method: 'POST', body: JSON.stringify({ pin }) }),
  // Admin account (admin only): this Windows account opens every page without a PIN
  setAdminAccount: (on) => fetchApi('/admin/account', { method: 'POST', body: JSON.stringify({ on }) }),

  // AbleSpeak account (Phase 2): email + code sign-in; the server keeps the session
  getAccountStatus: () => fetchApi('/account/status'),
  sendSignInCode: (email) => fetchApi('/account/sign-in/email', { method: 'POST', body: JSON.stringify({ email }) }),
  verifySignInCode: (email, code) => fetchApi('/account/sign-in/code', { method: 'POST', body: JSON.stringify({ email, code }) }),
  signOut: () => fetchApi('/account/sign-out', { method: 'POST' }),
  startGoogleSignIn: () => fetchApi('/account/sign-in/google', { method: 'POST' }),
  skipSignIn: () => fetchApi('/account/not-now', { method: 'POST' }),
  // The account's profile (Profile page): details, photo and the analytics choice
  getAccountProfile: () => fetchApi('/account/profile'),
  saveAccountProfile: (fields) => fetchApi('/account/profile', { method: 'PUT', body: JSON.stringify(fields) }),
  saveAccountConsent: (choice) => fetchApi('/account/consent', { method: 'PUT', body: JSON.stringify(choice) }),
  saveAccountPhoto: (image) => fetchApi('/account/photo', { method: 'PUT', body: JSON.stringify({ image }) }),
  removeAccountPhoto: () => fetchApi('/account/photo', { method: 'DELETE' }),
  // Google Analytics keys (Settings, admin only)
  getAnalyticsSettings: () => fetchApi('/settings/analytics'),
  saveAnalyticsSettings: (measurementId, apiSecret) => fetchApi('/settings/analytics', { method: 'PUT', body: JSON.stringify({ measurementId, apiSecret }) }),
  removeAnalyticsSettings: () => fetchApi('/settings/analytics', { method: 'DELETE' }),

  getHealth: () => fetchApi('/health'),
  getStatus: () => fetchApi('/status'),
  getCommandStats: () => fetchApi('/commands/stats'),
  getRecentCommands: (limit = 20) => fetchApi(`/commands?limit=${limit}`),
  getSessions: () => fetchApi('/sessions'),
  getTools: () => fetchApi('/tools'),
  // Each voice command's stage timings and today's cost (Developer › Speed)
  getSpeed: () => fetchApi('/speed'),
  getLibrary: () => fetchApi('/library'),
  getToolDetail: (cat, tool) => fetchApi(`/library/${cat}/${tool}`),
  getContext: () => fetchApi('/context'),
  getScreen: () => fetchApi('/screen'),
  getResolution: (days = 30) => fetchApi(`/screen/resolution?days=${days}`),
  getLogs: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return fetchApi(`/logs${q ? '?' + q : ''}`);
  },
  getRecentLogs: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return fetchApi(`/logs/recent${q ? '?' + q : ''}`);
  },
  getHealthAlerts: () => fetchApi('/logs/health'),
  getConfig: () => fetchApi('/config'),
  sendCommand: (target, data) => fetchApi('/command', {
    method: 'POST',
    body: JSON.stringify({ target, data })
  }),
  getSystem: () => fetchApi('/system'),
  getAiStatus: () => fetchApi('/ai/status'),
  getAiProviders: () => fetchApi('/ai/providers'),
  clearAiHistory: () => fetchApi('/ai/clear', { method: 'POST' }),

  // ── Settings: API keys and provider choice (saved to this device's .env) ──
  getApiKeys: () => fetchApi('/settings/keys'),
  // Shared computer (admin): several learners use it, so no profile opens by itself
  getSharedComputer: () => fetchApi('/settings/shared-computer'),
  setSharedComputer: (shared) => fetchApi('/settings/shared-computer', {
    method: 'PUT',
    body: JSON.stringify({ shared }),
  }),
  saveApiKey: (provider, body) => fetchApi(`/settings/keys/${encodeURIComponent(provider)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  }),
  removeApiKey: (provider) => fetchApi(`/settings/keys/${encodeURIComponent(provider)}`, { method: 'DELETE' }),
  useProvider: (provider, model) => fetchApi('/settings/provider', {
    method: 'POST',
    body: JSON.stringify({ provider, model }),
  }),

  // ── Teacher Dashboard ──
  getTeacherAnalytics: () => fetchApi('/teacher/analytics'),
  getStudents: () => fetchApi('/teacher/students'),
  addStudent: (name, session_prefix) => fetchApi('/teacher/students', {
    method: 'POST',
    body: JSON.stringify({ name, session_prefix }),
  }),
  deleteStudent: (id) => fetchApi(`/teacher/students/${id}`, { method: 'DELETE' }),
  getProfile: (studentId) => fetchApi(`/students/${studentId}/profile`),
  saveProfile: (studentId, changes) => fetchApi(`/students/${studentId}/profile`, {
    method: 'PUT',
    body: JSON.stringify(changes),
  }),
  exportProfile: (studentId) => fetchApi(`/students/${studentId}/profile/export`),
  // "My voice" (server/src/routes/voice-profile.js): a voiceprint made and kept on this computer
  getVoiceProfile: (studentId) => fetchApi(`/voice-profile${studentId != null ? `?student=${encodeURIComponent(studentId)}` : ''}`),
  addVoicePerson: (name) => fetchApi('/voice-profile/people', { method: 'POST', body: JSON.stringify({ name }) }),
  startVoiceSetup: (id, consent) => fetchApi(`/voice-profile/${id}/start`, { method: 'POST', body: JSON.stringify(consent) }),
  sendVoicePhrase: (id, phrase, wav) => fetchApi(`/voice-profile/${id}/clips`, { method: 'POST', body: JSON.stringify({ phrase, wav }) }),
  sendVoiceRoom: (id, wav) => fetchApi(`/voice-profile/${id}/room`, { method: 'POST', body: JSON.stringify({ wav }) }),
  keepVoiceSetup: (id) => fetchApi(`/voice-profile/${id}/keep`, { method: 'POST' }),
  finishVoiceSetup: (id) => fetchApi(`/voice-profile/${id}/finish`, { method: 'POST' }),
  cancelVoiceSetup: (id) => fetchApi(`/voice-profile/${id}/enrollment`, { method: 'DELETE' }),
  deleteVoice: (id) => fetchApi(`/voice-profile/${id}`, { method: 'DELETE' }),
  // With intoId, the file loads into that profile (a person's own settings) instead of matching by name
  importProfile: (file, intoId = null) => fetchApi(`/students/profile/import${intoId != null ? `?into=${encodeURIComponent(intoId)}` : ''}`, {
    method: 'POST',
    body: JSON.stringify(file),
  }),
  getRecognition: (studentId, days = 7) => fetchApi(`/students/${studentId}/recognition?days=${days}`),
  getProgress: (studentId, days = 30) => fetchApi(`/students/${studentId}/progress?days=${days}`),
  getActiveStudent: () => fetchApi('/students/active'),
  setActiveStudent: (studentId) => fetchApi('/students/active', {
    method: 'PUT',
    body: JSON.stringify({ student_id: studentId }),
  }),

  // ── Teacher Dashboard: Progress Monitoring (Tier 2 KPI engine) ──
  getBaselineSuggestion: (studentId, measure) =>
    fetchApi(`/students/${studentId}/baseline-suggestion?measure=${encodeURIComponent(measure)}`),
  createGoal: (studentId, body) => fetchApi(`/students/${studentId}/goals`, {
    method: 'POST',
    body: JSON.stringify(body),
  }),
  getGoals: (studentId, status = 'active') =>
    fetchApi(`/students/${studentId}/goals?status=${encodeURIComponent(status)}`),
  patchGoal: (goalId, body) => fetchApi(`/goals/${goalId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  }),
  getPoints: (goalId) => fetchApi(`/goals/${goalId}/points`),
  addPoint: (goalId, body) => fetchApi(`/goals/${goalId}/points`, {
    method: 'POST',
    body: JSON.stringify(body),
  }),
  getPhases: (goalId) => fetchApi(`/goals/${goalId}/phases`),
  addPhase: (goalId, body) => fetchApi(`/goals/${goalId}/phases`, {
    method: 'POST',
    body: JSON.stringify(body),
  }),
  getFlags: (goalId, unacknowledgedOnly = false) =>
    fetchApi(`/goals/${goalId}/flags${unacknowledgedOnly ? '?unacknowledged=1' : ''}`),
  acknowledgeFlag: (flagId) => fetchApi(`/flags/${flagId}/ack`, { method: 'POST' }),
  recomputeProgress: () => fetchApi('/progress/recompute', { method: 'POST' }),

  // ── Exams (server/src/exam): papers, sittings, the live exam ──
  getExams: () => fetchApi('/exams'),
  getExam: (id) => fetchApi(`/exams/${id}`),
  importExam: (fileName, data, settings) => fetchApi('/exams/import', {
    method: 'POST',
    body: JSON.stringify({ fileName, data, settings }),
  }),
  saveExam: (id, changes) => fetchApi(`/exams/${id}`, { method: 'PUT', body: JSON.stringify(changes) }),
  deleteExam: (id) => fetchApi(`/exams/${id}`, { method: 'DELETE' }),
  startExam: (id, studentId) => fetchApi(`/exams/${id}/start`, { method: 'POST', body: JSON.stringify({ studentId }) }),
  getExamAttempts: () => fetchApi('/exams/attempts'),
  resumeExamAttempt: (id) => fetchApi(`/exams/attempts/${id}/resume`, { method: 'POST' }),
  getLiveExam: () => fetchApi('/exams/live'),
  getExamFolder: () => fetchApi('/exams/folder'),
  openExamFolder: () => fetchApi('/exams/folder/open', { method: 'POST' }),
  pauseExam: () => fetchApi('/exams/live/pause', { method: 'POST' }),
  unpauseExam: () => fetchApi('/exams/live/unpause', { method: 'POST' }),
  stopExam: () => fetchApi('/exams/live/stop', { method: 'POST' }),
};

/**
 * Save a file the server makes (a script, an audit trail) to the person's
 * Downloads, with the unlock key sent as for any other request.
 */
export async function downloadFile(path) {
  const res = await fetch(`${API_BASE}${path}`, { headers: adminToken ? { 'X-AbleSpeak-Admin': adminToken } : {} });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || `Download failed (${res.status})`);
  }
  const name = decodeURIComponent((res.headers.get('content-disposition') || '').match(/filename\*=UTF-8''([^;]+)/)?.[1] || 'download');
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
