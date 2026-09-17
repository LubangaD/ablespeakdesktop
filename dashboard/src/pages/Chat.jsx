import { useWebSocket } from '../hooks/useWebSocket';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useState, useEffect, useRef, useCallback } from 'react';
import { Mic, MicOff, Send, AlertCircle } from 'lucide-react';

const SHOWN_EVENTS = [
  'voice_transcription', 'voice_no_speech', 'voice_error', 'command_complete',
  'chat_assistant_message', 'voice_busy', 'prompt_switch',
  'dictation_typed', 'dictation_mode', 'voice_cancelled', 'voice_awake', 'voice_sleeping',
  'voice_restored', 'voice_dismissed', 'privacy_mode', 'agent_progress',
];

let messageCount = 0;
const nextId = () => `m${Date.now()}-${++messageCount}`;

/** A one-line note for server events that aren't replies. */
function eventNote(msg) {
  switch (msg.type) {
    case 'dictation_typed':
      return msg.error ? `⚠ ${msg.message}` : `✏️ Typed: ${msg.text}`;
    case 'voice_cancelled':
      return 'Stopped.';
    case 'dictation_mode':
    case 'voice_awake':
    case 'voice_sleeping':
    case 'voice_restored':
    case 'voice_dismissed':
    case 'privacy_mode':
      return msg.say || null;
    case 'agent_progress':
      if (msg.phase === 'plan') return `Plan: ${(msg.steps || []).map((step, i) => `${i + 1}. ${step.do}`).join('  ')}`;
      if (msg.phase === 'step') return `Step ${msg.index + 1} of ${msg.total}: ${msg.step?.do || ''}`;
      if (msg.phase === 'check' && !msg.ok) return `Step ${msg.index + 1} didn't work: ${msg.why || ''}`;
      if (msg.phase === 'replan') return `Trying another way: ${msg.why || ''}`;
      return null;
    default:
      return null;
  }
}

export default function Chat() {
  const { on, wsRef } = useWebSocket();
  const { data: status } = useQuery({ queryKey: ['status'], queryFn: api.getStatus, refetchInterval: 3000 });
  const [messages, setMessages] = useState([
    { id: 'welcome', role: 'assistant', text: 'Hi, I am AbleSpeak. How can I help you today?', time: new Date() }
  ]);
  const [inputText, setInputText] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [voiceState, setVoiceState] = useState('idle'); // idle | listening | processing
  const [processing, setProcessing] = useState(false);
  const feedRef = useRef(null);
  const inputRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const streamRef = useRef(null);
  const silenceTimerRef = useRef(null);
  const analyserRef = useRef(null);
  const animFrameRef = useRef(null);
  const audioCtxRef = useRef(null); // Reuse single AudioContext (Fix #7)

  // Nothing is spoken from this page. The overlay speaks every reply, in the
  // same voice, so two voices never talk at once.

  // ── Send command via WebSocket ──
  const sendCommand = useCallback((text) => {
    if (!text) return;

    setMessages(prev => [...prev, {
      id: nextId(),
      role: 'user',
      text,
      time: new Date()
    }]);
    setProcessing(true);

    if (wsRef?.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'chat_command',
        text
      }));
    } else {
      fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });
    }
  }, [wsRef]);

  // ── Send audio to server for transcription ──
  const sendAudio = useCallback((audioBlob) => {
    if (!wsRef?.current || wsRef.current.readyState !== WebSocket.OPEN) {
      console.warn('[Voice] WebSocket not connected');
      setVoiceState('idle');
      return;
    }

    setVoiceState('processing');

    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(',')[1]; // Remove data:audio/webm;base64, prefix
      wsRef.current.send(JSON.stringify({
        type: 'voice_audio',
        source: 'dashboard',
        audio: base64,
        mimeType: audioBlob.type || 'audio/webm',
      }));
    };
    reader.readAsDataURL(audioBlob);
  }, [wsRef]);

  // ── Silence detection using AnalyserNode ──
  const startSilenceDetection = useCallback((stream) => {
    // Reuse a single AudioContext to prevent Chrome's ~6 context limit (Fix #7)
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
      audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    }
    const audioCtx = audioCtxRef.current;
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.3;
    source.connect(analyser);
    analyserRef.current = { audioCtx, source, analyser };

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    let silenceStart = null;
    const SILENCE_THRESHOLD = 15; // Volume level below which we consider silence
    const SILENCE_DURATION = 2000; // ms of silence before auto-stop

    const checkSilence = () => {
      analyser.getByteFrequencyData(dataArray);
      const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;

      if (avg < SILENCE_THRESHOLD) {
        if (!silenceStart) silenceStart = Date.now();
        if (Date.now() - silenceStart > SILENCE_DURATION) {
          // Silence detected — stop recording
          console.log('[Voice] Silence detected, stopping');
          stopListening();
          return;
        }
      } else {
        silenceStart = null; // Reset on speech
      }

      animFrameRef.current = requestAnimationFrame(checkSilence);
    };

    animFrameRef.current = requestAnimationFrame(checkSilence);
  }, []);

  // ── Start Listening ──
  const startListening = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 16000,
        }
      });

      streamRef.current = stream;
      audioChunksRef.current = [];

      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm',
      });

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: mediaRecorder.mimeType });

        // Only send if we have meaningful audio (> 1KB)
        if (audioBlob.size > 1000) {
          sendAudio(audioBlob);
        } else {
          setVoiceState('idle');
        }

        // Cleanup
        if (streamRef.current) {
          streamRef.current.getTracks().forEach(t => t.stop());
          streamRef.current = null;
        }
        // Disconnect source node but keep AudioContext alive for reuse (Fix #7)
        if (analyserRef.current?.source) {
          try { analyserRef.current.source.disconnect(); } catch {}
          analyserRef.current = null;
        }
        if (animFrameRef.current) {
          cancelAnimationFrame(animFrameRef.current);
          animFrameRef.current = null;
        }
      };

      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start(250); // Collect data every 250ms
      setIsListening(true);
      setVoiceState('listening');

      // Start silence detection
      startSilenceDetection(stream);

    } catch (err) {
      console.error('[Voice] Mic access error:', err);
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system',
        text: err.name === 'NotAllowedError'
          ? 'Microphone access denied. Please allow microphone access in your system settings.'
          : `Microphone error: ${err.message}`,
        time: new Date()
      }]);
      setVoiceState('idle');
    }
  }, [sendAudio, startSilenceDetection]);

  // ── Stop Listening ──
  const stopListening = useCallback(() => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    setIsListening(false);
  }, []);

  // ── Toggle Mic ──
  const toggleListening = () => {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  };

  // ── Handle incoming WebSocket messages ──
  // Subscribed per event, so two events arriving together are both handled.
  const handleServerMessage = useCallback((msg) => {

    if (msg.type === 'voice_transcription') {
      // Show what was heard
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'user',
        text: msg.text,
        source: 'voice',
        time: new Date()
      }]);
      setProcessing(true);
    }

    if (msg.type === 'voice_no_speech') {
      setVoiceState('idle');
      setProcessing(false);
    }

    if (msg.type === 'voice_error') {
      setVoiceState('idle');
      setProcessing(false);
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system',
        text: `Voice error: ${msg.error}`,
        time: new Date()
      }]);
    }

    if (msg.type === 'command_complete') {
      setProcessing(false);
      setVoiceState('idle');
      const result = msg.result;
      let responseText = '';

      if (typeof result === 'string') {
        responseText = result;
      } else if (result?.text) {
        responseText = result.text;
      } else if (result?.status) {
        responseText = result.status === 'success' ? '✓ Command executed successfully.' : result.status;
      } else if (result) {
        responseText = JSON.stringify(result, null, 2);
      }

      if (responseText) {
        setMessages(prev => [...prev, {
          id: nextId(),
          role: 'assistant',
          text: responseText,
          tool: msg.tool,
          latency: msg.latency_ms,
          time: new Date()
        }]);
      }
    }

    if (msg.type === 'chat_assistant_message') {
      setProcessing(false);
      setVoiceState('idle');
      // Empty text should still tell the user what happened
      let displayText = msg.text;
      if (!displayText?.trim()) {
        const calls = msg.toolCalls || [];
        const failed = calls.filter(tc => tc.result?.status === 'error');
        if (failed.length > 0) {
          displayText = `⚠ ${failed[0].result?.message || failed[0].result?.error || 'Action failed'}`;
        } else if (calls.length > 0) {
          // Show the tool's actual outcome (e.g. "Spotify is now playing: ...")
          const lastMsg = [...calls].reverse().find(tc => tc.result?.message)?.result?.message;
          displayText = lastMsg ? `✓ ${lastMsg}` : '✓ Done';
        } else {
          displayText = '(no action taken)';
        }
      }
      setMessages(prev => [...prev, {
        id: msg.id || nextId(),
        role: 'assistant',
        text: displayText,
        error: msg.error,
        provider: msg.provider,
        model: msg.model,
        latency: msg.latency,
        toolCalls: msg.toolCalls,
        source: msg.source,
        time: new Date()
      }]);
    }

    // What the overlay says or shows for these, so a typed test shows it too.
    const note = eventNote(msg);
    if (note) {
      if (msg.type !== 'agent_progress') {
        setProcessing(false);
        setVoiceState('idle');
      }
      setMessages(prev => [...prev, { id: nextId(), role: 'system', text: note, time: new Date() }]);
    }

    // Handle voice pipeline busy (concurrent command guard)
    if (msg.type === 'voice_busy') {
      setVoiceState('idle');
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system',
        text: 'Still processing your previous command. Please wait a moment.',
        time: new Date()
      }]);
    }

    if (msg.type === 'prompt_switch') {
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'system',
        text: `Switched to ${msg.prompt} mode`,
        time: new Date()
      }]);
    }
  }, []);

  useEffect(() => {
    const offs = SHOWN_EVENTS.map(type => on(type, handleServerMessage));
    return () => offs.forEach(off => off());
  }, [on, handleServerMessage]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [messages, voiceState, processing]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
      }
      // Close AudioContext only on unmount
      if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
        audioCtxRef.current.close();
      }
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
    };
  }, []);

  const handleTextSubmit = (e) => {
    e.preventDefault();
    if (!inputText.trim()) return;
    sendCommand(inputText.trim());
    setInputText('');
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleTextSubmit(e);
    }
  };

  return (
    <div className="as-chat-page">
      {/* Chat container */}
      <div className="as-chat-container" ref={feedRef} role="log" aria-label="Voice conversation" aria-live="polite">
        {messages.map(msg => (
          <ChatBubble key={msg.id} message={msg} />
        ))}

        {/* Voice state indicators */}
        {voiceState === 'listening' && (
          <div className="as-bubble-row user">
            <div className="as-bubble user interim voice-listening">
              <span className="voice-pulse" />
              Listening...
            </div>
          </div>
        )}

        {voiceState === 'processing' && (
          <div className="as-bubble-row user">
            <div className="as-bubble user interim">
              Transcribing...
            </div>
          </div>
        )}

        {/* Processing / thinking indicator */}
        {processing && (
          <div className="as-thinking">
            <div className="as-thinking-line" />
          </div>
        )}
      </div>

      {/* Bottom input bar — mic + text + send */}
      <div className="as-chat-input-bar">
        <button
          className={`as-mic-btn ${isListening ? 'active' : ''} ${voiceState === 'processing' ? 'processing' : ''}`}
          onClick={toggleListening}
          disabled={voiceState === 'processing'}
          aria-label={isListening ? 'Stop listening' : 'Start listening'}
          title={isListening ? 'Stop listening' : 'Click to speak'}
        >
          {isListening ? <MicOff size={20} /> : <Mic size={20} />}
        </button>

        <form onSubmit={handleTextSubmit} className="as-chat-form">
          <input
            ref={inputRef}
            type="text"
            className="as-chat-input"
            placeholder="Voice is primary — use Ctrl+Shift+A or click mic"
            value={inputText}
            onChange={e => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            aria-label="Type a message (voice input is primary — use the microphone button or Ctrl+Shift+A)"
          />
          <button
            type="submit"
            className="as-send-btn"
            disabled={!inputText.trim()}
            aria-label="Send message"
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}

function ChatBubble({ message }) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';

  if (isSystem) {
    return (
      <div className="as-system-msg">
        <AlertCircle size={14} />
        {message.text}
      </div>
    );
  }

  return (
    <div className={`as-bubble-row ${isUser ? 'user' : 'assistant'}`}>
      <div className={`as-bubble ${isUser ? 'user' : 'assistant'} ${message.error ? 'error' : ''}`}>
        <span className="as-bubble-text">{message.text}</span>
        {message.source === 'voice' && isUser && (
          <span className="as-voice-tag">🎙️</span>
        )}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="as-bubble-tools">
            {message.toolCalls.map((tc, i) => {
              const isError = tc.result?.status === 'error' || tc.result?.error;
              return (
                <span key={i} className="as-tool-tag" title={isError ? (tc.result?.message || tc.result?.error) : 'succeeded'}>
                  {isError ? '⚠' : '🔧'} {tc.tool || tc.name}{isError ? ' failed' : ''}
                </span>
              );
            })}
          </div>
        )}
        {(message.latency || message.provider) && (
          <span className="as-bubble-meta">
            {message.provider && <span>🤖 {message.model || message.provider}</span>}
            {message.latency && <span>⚡ {message.latency}ms</span>}
          </span>
        )}
      </div>
    </div>
  );
}
