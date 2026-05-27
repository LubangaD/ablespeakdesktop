import { useEffect, useRef, useState, useCallback } from 'react';

export function useWebSocket(path = '/ws/dashboard') {
  const [connected, setConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState(null);
  const wsRef = useRef(null);
  const listenersRef = useRef(new Map());
  const reconnectRef = useRef(null);

  const connect = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}${path}`;

    try { wsRef.current = new WebSocket(url); } catch { return; }

    wsRef.current.onopen = () => setConnected(true);
    wsRef.current.onclose = () => {
      setConnected(false);
      reconnectRef.current = setTimeout(connect, 3000);
    };
    wsRef.current.onerror = () => {};
    wsRef.current.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        setLastMessage(data);
        const handlers = listenersRef.current.get(data.type);
        if (handlers) handlers.forEach(fn => fn(data));
      } catch {}
    };
  }, [path]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, [connect]);

  const on = useCallback((type, handler) => {
    if (!listenersRef.current.has(type)) listenersRef.current.set(type, new Set());
    listenersRef.current.get(type).add(handler);
    return () => listenersRef.current.get(type)?.delete(handler);
  }, []);

  return { connected, lastMessage, on, wsRef };
}
