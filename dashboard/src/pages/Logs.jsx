import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useWebSocket } from '../hooks/useWebSocket';
import { useState, useEffect, useRef } from 'react';
import { Pause, Play, ScrollText } from 'lucide-react';
import { Button, Chip } from '../components/ui';

export default function Logs({ embedded = false }) {
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
      {embedded ? (
        <p className="hub-lead">What the AbleSpeak engine is doing, as it happens.</p>
      ) : (
        <header className="page-header">
          <h2><ScrollText size={28} aria-hidden="true" /> Logs</h2>
          <p>What the AbleSpeak engine is doing, as it happens.</p>
        </header>
      )}

      <div className="logs-toolbar">
        <div className="chip-row" role="group" aria-label="Filter by log level">
          {levels.map(l => (
            <Chip
              key={l}
              selected={(l === 'All' && !level) || level === l}
              onClick={() => setLevel(l === 'All' ? null : l)}
              aria-label={`Show ${l === 'All' ? 'all' : l} logs`}
            >
              {l}
            </Chip>
          ))}
        </div>
        <Button
          icon={paused ? Play : Pause}
          onClick={() => setPaused(!paused)}
          aria-pressed={paused}
          className="push-right"
        >
          {paused ? 'Resume scrolling' : 'Pause scrolling'}
        </Button>
      </div>

      <div className="log-stream" ref={containerRef} role="log" aria-label="AbleSpeak log output" aria-live={paused ? 'off' : 'polite'}>
        {logs.length === 0 && (
          <div className="log-empty">Waiting for log events…</div>
        )}
        {logs.map((log, i) => (
          <div key={i} className={`log-line ${log.level}`}>
            <span className="log-time">{log.timestamp} </span>
            <span className="log-level">{log.level}</span>
            {' '}
            {log.message}
          </div>
        ))}
      </div>
    </div>
  );
}
