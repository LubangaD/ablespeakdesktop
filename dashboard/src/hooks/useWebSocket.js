import { useEffect, useRef, useState, useCallback } from 'react';

export function useWebSocket(path = '/ws/dashboard') {
  const [connected, setConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState(null);
  const wsRef = useRef(null);
  const listenersRef = useRef(new Map());
  const reconnectRef = useRef(null);

  const connect = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    // If a pairing token is provided (window global or <meta name="ablespeak-ws-token">),
    // include it. The server origin-locks + loopback-locks regardless; the token
    // is extra defense on shared machines.
    const token = window.__ABLESPEAK_WS_TOKEN__ ||
      document.querySelector('meta[name="ablespeak-ws-token"]')?.content || '';
    const qs = token ? `?token=${encodeURIComponent(token)}` : '';
    const url = `${protocol}//${window.location.host}${path}${qs}`;

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
