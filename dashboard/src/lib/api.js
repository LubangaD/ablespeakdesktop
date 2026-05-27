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
};
