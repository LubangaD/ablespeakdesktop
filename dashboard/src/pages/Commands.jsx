import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useState } from 'react';
import { ChevronDown, ChevronRight, Clock, Zap, Mic, ArrowRight, CheckCircle, XCircle, Terminal } from 'lucide-react';

export default function Commands() {
  const [filter, setFilter] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const { data: commands = [] } = useQuery({
    queryKey: ['commands', filter],
    queryFn: () => api.getCommands({ limit: 100, type: filter || undefined }),
    refetchInterval: 5000,
  });

  const types = ['All', 'open_url', 'create_tab', 'click_element', 'scroll', 'javascript', 'search_youtube', 'media_control', 'press_key_combination'];

  const getTypeIcon = (type) => {
    const icons = {
      open_url: '🌐', create_tab: '📑', click_element: '👆',
      scroll: '📜', javascript: '⚡', search_youtube: '🎵',
      media_control: '▶️', press_key_combination: '⌨️',
      make_tab_active: '🔀', type_text: '✏️',
    };
    return icons[type] || '🔧';
  };

  const getStatusColor = (cmd) => {
    if (cmd.result?.includes?.('error') || cmd.result?.includes?.('Error')) return 'error';
    return 'success';
  };

  return (
    <div className="commands-page">
      {/* Sticky header + filters */}
      <div className="commands-sticky-bar">
        <div className="commands-header">
          <div>
            <h2>Command History</h2>
            <p className="commands-subtitle">
              {commands.length > 0
                ? `${commands.length} commands executed`
                : 'Commands executed through AbleSpeak will appear here'}
            </p>
          </div>
        </div>

        {/* Category pills */}
        <div className="commands-filters">
          {types.map(t => (
            <button
              key={t}
              className={`tools-cat-pill${(t === 'All' && !filter) || filter === t ? ' active' : ''}`}
              onClick={() => setFilter(t === 'All' ? null : t)}
            >
              {t === 'All' ? 'All' : t.replace(/_/g, ' ')}
            </button>
          ))}
        </div>
      </div>

      {/* Command list */}
      <div className="commands-list">
        {commands.length === 0 && (
          <div className="commands-empty">
            <div className="commands-empty-badge">
              <Terminal size={36} />
            </div>
            <h3>No commands yet</h3>
            <p>Everything you do with your voice will show up here, newest first.</p>
            <div className="commands-empty-hint">Try saying:</div>
            <div className="commands-empty-examples">
              <span className="commands-empty-chip"><Mic size={13} /> “Open YouTube”</span>
              <span className="commands-empty-chip"><Mic size={13} /> “Play Finale by Bien”</span>
              <span className="commands-empty-chip"><Mic size={13} /> “Scroll down”</span>
            </div>
          </div>
        )}
        {commands.map((cmd) => (
          <div key={cmd.id} className="commands-item-wrap">
            <button
              className={`commands-item${expanded === cmd.id ? ' expanded' : ''}`}
              onClick={() => setExpanded(expanded === cmd.id ? null : cmd.id)}
              aria-expanded={expanded === cmd.id}
            >
              <span className="commands-item-icon">{getTypeIcon(cmd.type)}</span>
              <div className="commands-item-info">
                <span className="commands-item-type">{cmd.type?.replace(/_/g, ' ') || 'unknown'}</span>
                <span className="commands-item-dir">
                  <ArrowRight size={10} />
                  {cmd.direction === 'voqal_to_ext' ? 'Extension' : 'Server'}
                </span>
              </div>
              <div className="commands-item-meta">
                {cmd.latency_ms && (
                  <span className="commands-item-latency">
                    <Zap size={12} /> {cmd.latency_ms}ms
                  </span>
                )}
                <span className="commands-item-time">
                  <Clock size={12} /> {cmd.created_at}
                </span>
              </div>
              <span className="commands-item-chevron">
                {expanded === cmd.id ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              </span>
            </button>
            {expanded === cmd.id && (
              <div className="commands-detail">
                {cmd.payload && (
                  <div className="commands-detail-section">
                    <span className="commands-detail-label">Payload</span>
                    <pre className="commands-detail-code">{
                      typeof cmd.payload === 'string'
                        ? (cmd.payload.startsWith('{') ? JSON.stringify(JSON.parse(cmd.payload), null, 2) : cmd.payload)
                        : JSON.stringify(cmd.payload, null, 2)
                    }</pre>
                  </div>
                )}
                {cmd.result && (
                  <div className="commands-detail-section">
                    <span className="commands-detail-label">Result</span>
                    <pre className="commands-detail-code">{
                      typeof cmd.result === 'string'
                        ? (cmd.result.startsWith('{') ? JSON.stringify(JSON.parse(cmd.result), null, 2) : cmd.result)
                        : JSON.stringify(cmd.result, null, 2)
                    }</pre>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
