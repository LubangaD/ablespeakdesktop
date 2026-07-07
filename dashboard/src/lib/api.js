const API_BASE = '/api';

async function fetchApi(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options
  });
  if (!res.ok) throw new Error(`API ${path}: ${res.status}`);
  return res.json();
}

export const api = {
  getHealth: () => fetchApi('/health'),
  getStatus: () => fetchApi('/status'),
  getCommands: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return fetchApi(`/commands${q ? '?' + q : ''}`);
  },
  getCommandStats: () => fetchApi('/commands/stats'),
  getSessions: () => fetchApi('/sessions'),
  getLibrary: () => fetchApi('/library'),
  getToolDetail: (cat, tool) => fetchApi(`/library/${cat}/${tool}`),
  getContext: () => fetchApi('/context'),
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
  // ── Students ──
  getStudents: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return fetchApi(`/students${q ? '?' + q : ''}`);
  },
  getActiveStudent: () => fetchApi('/students/active'),
  addStudent: (data) => fetchApi('/students', { method: 'POST', body: JSON.stringify(data) }),
  updateStudent: (id, data) => fetchApi(`/students/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  importRosterCsv: (csv) => fetchApi('/students/roster-csv', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ csv }),
  }),
  // ── Speech profiles ──
  getSpeechProfile: (studentId) => fetchApi(`/students/${studentId}/speech-profile`),
  saveSpeechProfile: (studentId, data) => fetchApi(`/students/${studentId}/speech-profile`, {
    method: 'PUT',
    body: JSON.stringify(data),
  }),
  // ── Sync (T4) — classroomKey is write-only: sent via saveSyncSettings, never returned by getSyncStatus ──
  getSyncStatus: () => fetchApi('/sync/status'),
  saveSyncSettings: (sync) => fetchApi('/setup/app-settings', {
    method: 'POST',
    body: JSON.stringify({ sync }),
  }),
  // ── T5: Progress Monitoring ──
  getBaselineSuggestion: (studentId, measure) => fetchApi(`/students/${studentId}/baseline-suggestion?measure=${encodeURIComponent(measure)}`),
  createGoal: (studentId, data) => fetchApi(`/students/${studentId}/goals`, { method: 'POST', body: JSON.stringify(data) }),
  getGoals: (studentId, status = 'active') => fetchApi(`/students/${studentId}/goals?status=${status}`),
  patchGoal: (goalId, data) => fetchApi(`/goals/${goalId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  getPoints: (goalId) => fetchApi(`/goals/${goalId}/points`),
  addManualPoint: (goalId, data) => fetchApi(`/goals/${goalId}/points`, { method: 'POST', body: JSON.stringify(data) }),
  getPhases: (goalId) => fetchApi(`/goals/${goalId}/phases`),
  addPhase: (goalId, data) => fetchApi(`/goals/${goalId}/phases`, { method: 'POST', body: JSON.stringify(data) }),
  getFlags: (goalId, unacknowledgedOnly = false) => fetchApi(`/goals/${goalId}/flags${unacknowledgedOnly ? '?unacknowledged=1' : ''}`),
  acknowledgeFlag: (flagId) => fetchApi(`/flags/${flagId}/ack`, { method: 'POST' }),
  recomputeProgress: () => fetchApi('/progress/recompute', { method: 'POST' }),
};
