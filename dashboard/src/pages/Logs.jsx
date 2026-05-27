import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useWebSocket } from '../hooks/useWebSocket';
import { useState, useEffect, useRef } from 'react';

export default function Logs() {
  const [level, setLevel] = useState(null);
  const [logs, setLogs] = useState([]);
  const [paused, setPaused] = useState(false);
  const containerRef = useRef(null);
  const { lastMessage } = useWebSocket();

  // Initial load
  const { data: initialLogs } = useQuery({
    queryKey: ['recentLogs', level],
    queryFn: () => api.getRecentLogs({ limit: 100, level: level || undefined }),
    staleTime: 10000
  });

  useEffect(() => {
    if (initialLogs) setLogs(initialLogs);
  }, [initialLogs]);

  // Live updates
  useEffect(() => {
    if (!lastMessage || lastMessage.type !== 'log_event' || paused) return;
    const event = lastMessage.event;
    if (level && event.level !== level) return;
    setLogs(prev => [...prev, event].slice(-200));
  }, [lastMessage, level, paused]);

  // Auto-scroll
  useEffect(() => {
    if (!paused && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs, paused]);

  const levels = ['All', 'INFO', 'WARN', 'ERROR'];

  return (
    <div>
      <header className="page-header">
        <h2>Log Viewer</h2>
        <p>Real-time AbleSpeak engine log stream</p>
      </header>

      <div style={{ display: 'flex', gap: 8, marginBottom: 20, alignItems: 'center' }}>
        <div className="filter-group" role="group" aria-label="Filter by log level" style={{ marginBottom: 0 }}>
          {levels.map(l => (
            <button
              key={l}
              className={`filter-btn${(l === 'All' && !level) || level === l ? ' active' : ''}`}
              onClick={() => setLevel(l === 'All' ? null : l)}
              aria-label={`Show ${l} logs`}
              aria-pressed={(l === 'All' && !level) || level === l}
            >
              {l}
            </button>
          ))}
        </div>
        <button
          className={`filter-btn${paused ? ' active' : ''}`}
          onClick={() => setPaused(!paused)}
          aria-label={paused ? 'Resume auto-scroll' : 'Pause auto-scroll'}
          aria-pressed={paused}
          style={{ marginLeft: 'auto' }}
        >
          {paused ? '▶ Resume' : '⏸ Pause'}
        </button>
      </div>

      <div className="log-stream" ref={containerRef} role="log" aria-label="AbleSpeak log output" aria-live={paused ? 'off' : 'polite'}>
        {logs.length === 0 && (
          <div style={{ color: 'var(--text-muted)', padding: 20 }}>Waiting for log events...</div>
        )}
        {logs.map((log, i) => (
          <div key={i} className={`log-line ${log.level}`}>
            <span style={{ color: 'var(--text-muted)' }}>{log.timestamp} </span>
            <span style={{ fontWeight: 600, minWidth: 50, display: 'inline-block' }}>{log.level}</span>
            {' '}
            {log.message}
          </div>
        ))}
      </div>
    </div>
  );
}
