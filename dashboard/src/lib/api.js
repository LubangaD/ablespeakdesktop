const API_BASE = '/api';

async function fetchApi(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options
  });
  if (!res.ok) {
    // Prefer the server's own explanation when it sends one.
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || `API ${path}: ${res.status}`);
  }
  return res.json();
}

export const api = {
  getHealth: () => fetchApi('/health'),
  getStatus: () => fetchApi('/status'),
  getCommandStats: () => fetchApi('/commands/stats'),
  getSessions: () => fetchApi('/sessions'),
  getTools: () => fetchApi('/tools'),
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

  // ── Settings: API keys and provider choice (saved to this device's .env) ──
  getApiKeys: () => fetchApi('/settings/keys'),
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
  importProfile: (file) => fetchApi('/students/profile/import', {
    method: 'POST',
    body: JSON.stringify(file),
  }),
  getRecognition: (studentId, days = 7) => fetchApi(`/students/${studentId}/recognition?days=${days}`),
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
};
