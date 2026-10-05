/**
 * Test console, built from the Stitch "Test console" screen
 * (docs/design/stitch/test-console.html, its <main> only): the voice state
 * bar, the live transcript beside one-click commands, and a bar to speak or
 * type. Styled with the shared constants in lib/ui.js, like Home.
 *
 * A typed command goes to the server as `chat_command` and is handled
 * exactly like speech. Nothing is spoken from this page: the overlay speaks
 * every reply, in one voice, so two voices never talk at once.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useWebSocket } from '../hooks/useWebSocket';
import { api } from '../lib/api';
import {
  TITLE, SECTION, MUTED, BODY, PAGE, CARD, WELL, DIVIDER,
  PRIMARY, QUIET, DANGER, SMALL_QUIET, FIELD, DOT, INK,
} from '../lib/ui';

// Phrases the server handles directly (fast-commands.js and the voice
// controls in ws-proxy.js), so each one does something real.
const TRY_COMMANDS = [
  { phrase: 'scroll down', kind: 'Navigation' },
  { phrase: 'go back', kind: 'History' },
  { phrase: 'open a new tab', kind: 'Browser' },
  { phrase: 'start dictation', kind: 'Mode' },
  { phrase: 'stop dictating', kind: 'Mode' },
  { phrase: 'undo that', kind: 'Correction' },
  { phrase: 'go to sleep', kind: 'Overlay state' },
  { phrase: 'wake up', kind: 'Overlay state' },
  // Stops AbleSpeak looking at the screen; the mic stays on.
  { phrase: 'privacy mode', kind: 'Screen privacy' },
];

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
      return msg.error ? `Couldn't type that: ${msg.message}` : `Typed: ${msg.text}`;
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
      if (msg.phase === 'plan') return `Plan: ${(msg.steps || []).map((step, i) => `${i + 1}. ${step.do}`).join('   ')}`;
      if (msg.phase === 'step') return `Step ${msg.index + 1} of ${msg.total}: ${msg.step?.do || ''}`;
      if (msg.phase === 'check' && !msg.ok) return `Step ${msg.index + 1} didn't work: ${msg.why || ''}`;
      if (msg.phase === 'replan') return `Trying another way: ${msg.why || ''}`;
      return null;
    default:
      return null;
  }
}

/** Whether an event note is about something that went wrong. */
const noteIsProblem = msg =>
  (msg.type === 'dictation_typed' && !!msg.error) || (msg.type === 'agent_progress' && msg.phase === 'check' && !msg.ok);

const clock = time => time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

const toolFailed = tc => tc.result?.status === 'error' || !!tc.result?.error;

// ── Icons, as the Stitch screen draws them ──
const svgProps = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };

const MicIcon = ({ className, strokeWidth = 2.2 }) => (
  <svg className={className} {...svgProps} strokeWidth={strokeWidth}>
    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <line x1="12" x2="12" y1="19" y2="22" />
    <line x1="8" x2="16" y1="22" y2="22" />
  </svg>
);
const StopIcon = ({ className }) => (
  <svg className={className} {...svgProps} strokeWidth="2.4">
    <polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2" />
    <rect x="9" y="9" width="6" height="6" fill="currentColor" />
  </svg>
);
const WaveIcon = ({ className }) => (
  <svg className={className} {...svgProps} strokeWidth="2.5">
    <path d="M12 2v20" />
    <path d="M17 6v12" />
    <path d="M22 10v4" />
    <path d="M7 6v12" />
    <path d="M2 10v4" />
  </svg>
);
const KeyboardIcon = ({ className }) => (
  <svg className={className} {...svgProps} strokeWidth="2.5">
    <rect width="20" height="16" x="2" y="4" rx="2" />
    <path d="M6 8h.01" />
    <path d="M10 8h.01" />
    <path d="M14 8h.01" />
    <path d="M18 8h.01" />
    <path d="M8 12h.01" />
    <path d="M12 12h.01" />
    <path d="M16 12h.01" />
    <path d="M7 16h10" />
  </svg>
);
const TrashIcon = ({ className }) => (
  <svg className={className} {...svgProps} strokeWidth="2">
    <path d="M3 6h18" />
    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
  </svg>
);
const InfoIcon = ({ className }) => (
  <svg className={className} {...svgProps} strokeWidth="2">
    <circle cx="12" cy="12" r="10" />
    <line x1="12" x2="12" y1="16" y2="12" />
    <line x1="12" x2="12.01" y1="8" y2="8" />
  </svg>
);
const WarnIcon = ({ className, strokeWidth = 2.5 }) => (
  <svg className={className} {...svgProps} strokeWidth={strokeWidth}>
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
    <line x1="12" x2="12" y1="9" y2="13" />
    <line x1="12" x2="12.01" y1="17" y2="17" />
  </svg>
);
const WrenchIcon = ({ className }) => (
  <svg className={className} {...svgProps} strokeWidth="2">
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  </svg>
);
const FailedIcon = ({ className }) => (
  <svg className={className} {...svgProps} strokeWidth="2">
    <circle cx="12" cy="12" r="10" />
    <line x1="15" x2="9" y1="9" y2="15" />
    <line x1="9" x2="15" y1="9" y2="15" />
  </svg>
);
const CheckIcon = ({ className }) => (
  <svg className={className} {...svgProps} strokeWidth="2">
    <circle cx="12" cy="12" r="10" />
    <path d="m9 12 2 2 4-4" />
  </svg>
);
const CloseIcon = ({ className }) => (
  <svg className={className} {...svgProps} strokeWidth="2">
    <line x1="18" x2="6" y1="6" y2="18" />
    <line x1="6" x2="18" y1="6" y2="18" />
  </svg>
);
const SendIcon = ({ className }) => (
  <svg className={className} {...svgProps} strokeWidth="2.5">
    <line x1="22" x2="11" y1="2" y2="13" />
    <polygon points="22 2 15 22 11 13 2 9 22 2" />
  </svg>
);

// What the voice status shows in each state: a word, a line, and a tone
// (a dot and a word, like every other page).
const VOICE_STATES = {
  listening: { word: 'Listening', detail: 'Speak now. It stops when you pause.', tone: 'ok' },
  transcribing: { word: 'Working', detail: 'Turning your speech into text…', tone: 'warn' },
  working: { word: 'Working', detail: 'Working on it…', tone: 'warn' },
  offline: { word: 'Offline', detail: 'Not connected to AbleSpeak.', tone: 'bad' },
  hidden: { word: 'Hidden', detail: 'Say or send “come back”.', tone: 'idle' },
  asleep: { word: 'Asleep', detail: 'Say or send “wake up”.', tone: 'idle' },
  dictating: { word: 'Dictating', detail: 'What you send is typed.', tone: 'warn' },
  ready: { word: 'Ready', detail: 'Press Speak, or type a command.', tone: 'ok' },
};

// A literal command or tool name: small, muted monospace
const CODE = 'font-mono text-[12px] leading-4 text-[#c9b8a5]';

// A 48px target around a control drawn smaller, without moving anything.
const HIT = "relative before:absolute before:-inset-2 before:content-['']";

export default function TestConsole() {
  const { on, wsRef, connected } = useWebSocket();
  const { data: status } = useQuery({ queryKey: ['status'], queryFn: api.getStatus, refetchInterval: 3000 });
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false); // a recording is with the server
  const [processing, setProcessing] = useState(false); // waiting for a reply
  const feedRef = useRef(null);
  const inputRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const streamRef = useRef(null);
  const analyserRef = useRef(null);
  const animFrameRef = useRef(null);
  const audioCtxRef = useRef(null); // one AudioContext, reused (Chrome allows only a few)

  const addMessage = useCallback((message) => {
    setMessages(prev => [...prev, { time: new Date(), ...message, id: nextId() }]);
  }, []);

  // ── Server events ──
  // Subscribed per event type, so events arriving together are all handled.
  const handleServerMessage = useCallback((msg) => {
    if (msg.type === 'voice_transcription') {
      // What was heard
      addMessage({ role: 'user', text: msg.text, source: 'voice' });
      setTranscribing(false);
      setProcessing(true);
    }

    if (msg.type === 'voice_no_speech') {
      setTranscribing(false);
      setProcessing(false);
    }

    if (msg.type === 'voice_error') {
      setTranscribing(false);
      setProcessing(false);
      addMessage({ role: 'system', text: `Voice error: ${msg.error}`, problem: true });
    }

    if (msg.type === 'command_complete') {
      setProcessing(false);
      setTranscribing(false);
      const result = msg.result;
      let responseText = '';
      if (typeof result === 'string') responseText = result;
      else if (result?.text) responseText = result.text;
      else if (result?.status) responseText = result.status === 'success' ? 'Done.' : result.status;
      else if (result) responseText = JSON.stringify(result, null, 2);

      if (responseText) {
        addMessage({
          role: 'assistant',
          text: responseText,
          toolCalls: msg.tool ? [{ tool: msg.tool, result: typeof result === 'object' ? result : undefined }] : undefined,
          latency: msg.latency_ms,
        });
      }
    }

    if (msg.type === 'chat_assistant_message') {
      setProcessing(false);
      setTranscribing(false);
      const calls = msg.toolCalls || [];
      // Empty text should still say what happened
      let displayText = msg.text;
      if (!displayText?.trim()) {
        const failed = calls.filter(tc => tc.result?.status === 'error');
        if (failed.length > 0) {
          displayText = failed[0].result?.message || failed[0].result?.error || 'Action failed';
        } else if (calls.length > 0) {
          // The tool's own outcome, e.g. "Spotify is now playing: …"
          const lastMsg = [...calls].reverse().find(tc => tc.result?.message)?.result?.message;
          displayText = lastMsg || 'Done.';
        } else {
          displayText = '(no action taken)';
        }
      }
      addMessage({
        role: 'assistant',
        text: displayText,
        error: !!(msg.error || (!msg.text?.trim() && calls.some(tc => tc.result?.status === 'error'))),
        provider: msg.provider,
        model: msg.model,
        latency: msg.latency,
        toolCalls: msg.toolCalls,
      });
    }

    // What the overlay says or shows for these, so a typed test shows it too
    const note = eventNote(msg);
    if (note) {
      if (msg.type !== 'agent_progress') {
        setProcessing(false);
        setTranscribing(false);
      }
      addMessage({ role: 'system', text: note, problem: noteIsProblem(msg) });
    }

    // A recording sent while the last command is still being handled
    if (msg.type === 'voice_busy') {
      setTranscribing(false);
      addMessage({ role: 'system', text: 'Still processing your previous command. Please wait a moment.' });
    }

    if (msg.type === 'prompt_switch') {
      addMessage({ role: 'system', text: `Switched to ${msg.prompt} mode` });
    }
  }, [addMessage]);

  useEffect(() => {
    const offs = SHOWN_EVENTS.map(type => on(type, handleServerMessage));
    return () => offs.forEach(off => off());
  }, [on, handleServerMessage]);

  // ── Send a typed command: handled exactly like speech ──
  const sendCommand = useCallback((text) => {
    if (!text) return;
    addMessage({ role: 'user', text, source: 'typed' });
    setProcessing(true);

    if (wsRef?.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'chat_command', text }));
      return;
    }
    // No live connection: the REST route answers with the reply itself
    fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
      .then(res => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then(result => handleServerMessage({ ...result, type: 'chat_assistant_message' }))
      .catch(() => {
        setProcessing(false);
        addMessage({ role: 'system', text: "Couldn't reach AbleSpeak. Check that it's running.", problem: true });
      });
  }, [wsRef, addMessage, handleServerMessage]);

  // ── Send a recording to the server to be heard ──
  const sendAudio = useCallback((audioBlob) => {
    if (!wsRef?.current || wsRef.current.readyState !== WebSocket.OPEN) {
      console.warn('[Voice] WebSocket not connected');
      setTranscribing(false);
      return;
    }
    setTranscribing(true);

    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(',')[1]; // drop the "data:audio/webm;base64," prefix
      wsRef.current.send(JSON.stringify({
        type: 'voice_audio',
        source: 'dashboard',
        audio: base64,
        mimeType: audioBlob.type || 'audio/webm',
      }));
    };
    reader.readAsDataURL(audioBlob);
  }, [wsRef]);

  // ── Stop recording ──
  const stopListening = useCallback(() => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    setIsListening(false);
  }, []);

  // ── Stop by itself after a pause ──
  const startSilenceDetection = useCallback((stream) => {
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
    const SILENCE_THRESHOLD = 15; // volume below which it counts as silence
    const SILENCE_DURATION = 2000; // ms of silence before stopping

    const checkSilence = () => {
      analyser.getByteFrequencyData(dataArray);
      const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;

      if (avg < SILENCE_THRESHOLD) {
        if (!silenceStart) silenceStart = Date.now();
        if (Date.now() - silenceStart > SILENCE_DURATION) {
          console.log('[Voice] Silence detected, stopping');
          stopListening();
          return;
        }
      } else {
        silenceStart = null;
      }
      animFrameRef.current = requestAnimationFrame(checkSilence);
    };

    animFrameRef.current = requestAnimationFrame(checkSilence);
  }, [stopListening]);

  // ── Start recording ──
  const startListening = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 },
      });
      streamRef.current = stream;
      audioChunksRef.current = [];

      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm',
      });

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };

      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: mediaRecorder.mimeType });
        // Only send a clip with real sound in it (> 1 KB)
        if (audioBlob.size > 1000) sendAudio(audioBlob);

        if (streamRef.current) {
          streamRef.current.getTracks().forEach(t => t.stop());
          streamRef.current = null;
        }
        // Let go of the source, but keep the AudioContext for next time
        if (analyserRef.current?.source) {
          try { analyserRef.current.source.disconnect(); } catch { /* already gone */ }
          analyserRef.current = null;
        }
        if (animFrameRef.current) {
          cancelAnimationFrame(animFrameRef.current);
          animFrameRef.current = null;
        }
      };

      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start(250); // a chunk every 250 ms
      setIsListening(true);
      startSilenceDetection(stream);
    } catch (err) {
      console.error('[Voice] Mic access error:', err);
      addMessage({
        role: 'system',
        text: err.name === 'NotAllowedError'
          ? 'Microphone access denied. Please allow microphone access in your system settings.'
          : `Microphone error: ${err.message}`,
        problem: true,
      });
    }
  }, [sendAudio, startSilenceDetection, addMessage]);

  const speakBlocked = !isListening && (transcribing || !connected);
  const toggleListening = () => {
    if (isListening) stopListening();
    else if (!speakBlocked) startListening();
  };

  // Keep the newest line in view
  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [messages]);

  // Leaving the page: drop any recording without sending it
  useEffect(() => () => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = null;
      try { recorder.stop(); } catch { /* already stopped */ }
    }
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') audioCtxRef.current.close();
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
  }, []);

  const handleTextSubmit = (e) => {
    e.preventDefault();
    const text = inputText.trim();
    // Nothing typed yet: put the cursor where the command goes
    if (!text) { inputRef.current?.focus(); return; }
    if (!connected) return;
    sendCommand(text);
    setInputText('');
    inputRef.current?.focus();
  };

  // The voice state bar: this page's mic first, then a reply being worked
  // on, then what the gateway says voice is doing.
  const voice = status?.voice;
  const stateKey = isListening ? 'listening'
    : transcribing ? 'transcribing'
    : processing ? 'working'
    : !connected ? 'offline'
    : voice?.dismissed ? 'hidden'
    : voice?.sleeping ? 'asleep'
    : voice?.dictationMode ? 'dictating'
    : 'ready';
  const state = VOICE_STATES[stateKey];
  const eventCount = messages.length;

  return (
    <div className={`${PAGE} h-full flex flex-col gap-5 min-h-0 overflow-hidden`}>

      {/* Page header: title, and what voice is doing */}
      <header className="flex flex-col lg:flex-row lg:items-end justify-between gap-3 shrink-0">
        <div className="min-w-0">
          <h1 className={TITLE}>Test console</h1>
          <p className={`${MUTED} text-[14px] mt-1`}>Type or say what a user would say. It’s handled exactly as if they said it.</p>
        </div>

        <div role="status" className="flex items-center gap-2 min-w-0 shrink-0">
          <span className={`w-2 h-2 rounded-full shrink-0 ${DOT[state.tone]}`} aria-hidden="true" />
          <span className={`text-[14px] font-medium ${INK[state.tone]}`}>{state.word}</span>
          <span className={`${MUTED} whitespace-nowrap`}>· {state.detail}</span>
        </div>
      </header>

      {/* What happened, beside the commands to try */}
      <div className="flex-1 flex gap-5 min-h-0 overflow-hidden">

        <section className={`${CARD} flex-1 min-w-0 flex flex-col overflow-hidden`} aria-labelledby="transcript-heading">
          <div className={`px-5 py-4 border-b ${DIVIDER} flex items-center justify-between gap-3 shrink-0`}>
            <div className="flex items-baseline gap-3 min-w-0">
              <h2 id="transcript-heading" className={`${SECTION} whitespace-nowrap`}>What happened</h2>
              <span className={`${MUTED} truncate tabular-nums`}>
                {eventCount} {eventCount === 1 ? 'event' : 'events'} in this test
              </span>
            </div>
            <div className="flex items-center gap-4 shrink-0">
              <span className="flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full ${connected ? DOT.ok : DOT.bad}`} aria-hidden="true" />
                <span className={`text-[13px] ${connected ? INK.ok : INK.bad}`}>{connected ? 'Connected' : 'Offline'}</span>
              </span>
              <button type="button" onClick={() => setMessages([])} className={SMALL_QUIET}>
                <TrashIcon className="w-3.5 h-3.5" />
                <span>Clear log</span>
              </button>
            </div>
          </div>

          <div
            ref={feedRef}
            role="log"
            aria-live="polite"
            aria-label="Transcript"
            tabIndex={0}
            className="flex-1 p-5 overflow-y-auto space-y-3 focus-visible:!outline-offset-[-3px]"
          >
            {messages.length === 0
              ? <EmptyTranscript />
              : messages.map(message => <TranscriptItem key={message.id} message={message} />)}
          </div>
        </section>

        {/* Real phrases, sent as if the student said them */}
        <aside className={`${CARD} w-80 flex flex-col shrink-0 overflow-hidden`} aria-labelledby="try-heading">
          <div className={`px-5 pt-5 pb-4 border-b ${DIVIDER} shrink-0`}>
            <h2 id="try-heading" className={SECTION}>Try a command</h2>
            <p className={`${MUTED} mt-1`}>One click runs a common user command on this computer.</p>
          </div>

          <ul className="flex-1 overflow-y-auto divide-y divide-white/[0.06]">
            {TRY_COMMANDS.map(({ phrase, kind }) => (
              <li key={phrase}>
                <button
                  type="button"
                  onClick={() => sendCommand(phrase)}
                  disabled={!connected}
                  className="w-full min-h-[44px] px-5 py-2.5 text-left flex items-center justify-between gap-3 hover:bg-[#18202d] transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                >
                  <span className={BODY}>
                    <span className="sr-only">Send </span>“{phrase}”
                  </span>
                  <span className={`${MUTED} shrink-0`}>{kind}</span>
                </button>
              </li>
            ))}
          </ul>

          <div className={`px-5 py-4 border-t ${DIVIDER} shrink-0 flex items-start gap-2 ${MUTED}`}>
            <CheckIcon className="w-4 h-4 text-[#68d9c3] shrink-0 mt-0.5" />
            <span>These are sent exactly as if the user said them.</span>
          </div>
        </aside>

      </div>

      {/* Speak, type, send */}
      <form onSubmit={handleTextSubmit} className={`${CARD} shrink-0 p-3 flex items-center gap-3`}>
        <button
          type="button"
          onClick={toggleListening}
          aria-disabled={speakBlocked}
          aria-label={isListening ? 'Stop listening' : 'Speak a command'}
          className={`${isListening ? DANGER : QUIET} shrink-0 aria-disabled:opacity-50 aria-disabled:cursor-not-allowed`}
        >
          {isListening
            ? <StopIcon className="w-4 h-4" />
            : <MicIcon className="w-4 h-4 text-[#68d9c3]" strokeWidth={2} />}
          <span>{isListening ? 'Stop' : 'Speak'}</span>
        </button>

        <div className="flex-1 relative flex items-center min-w-0">
          <label htmlFor="test-command" className="sr-only">Command</label>
          <input
            ref={inputRef}
            id="test-command"
            type="text"
            value={inputText}
            onChange={e => setInputText(e.target.value)}
            placeholder="Type a command, or speak with the Speak button"
            autoComplete="off"
            className={`${FIELD} pr-11`}
          />
          {inputText && (
            <button
              type="button"
              onClick={() => { setInputText(''); inputRef.current?.focus(); }}
              aria-label="Clear the text"
              title="Clear text"
              className={`${HIT} !absolute right-2 w-7 h-7 rounded-md text-[#c9b8a5] hover:text-[#dae3f4] hover:bg-[#222a37] flex items-center justify-center transition-colors`}
            >
              <CloseIcon className="w-4 h-4" />
            </button>
          )}
        </div>

        <button type="submit" disabled={!connected} className={`${PRIMARY} shrink-0`}>
          <span>Send</span>
          <SendIcon className="w-4 h-4" />
        </button>
      </form>
    </div>
  );
}

/** The transcript before anything has been tried: says what will show here. */
function EmptyTranscript() {
  return (
    <div className="h-full min-h-[200px] flex flex-col items-center justify-center text-center px-6 gap-2">
      <WaveIcon className="w-5 h-5 text-[#8b95a7]" />
      <p className={`${MUTED} max-w-sm`}>
        No commands tried yet. Press Speak or type a command below, and what AbleSpeak heard and did will show here.
      </p>
      <p className={`${MUTED} flex items-center gap-1.5`}>
        <InfoIcon className="w-3.5 h-3.5 shrink-0" />
        <span>Commands run for real on this computer.</span>
      </p>
    </div>
  );
}

/** A quiet note for events that aren't replies (a plan, a step, a problem). */
function SystemNote({ text, problem }) {
  return (
    <div className={`flex items-start gap-2 px-3 py-2 ${MUTED}`}>
      {problem
        ? <WarnIcon className={`w-4 h-4 shrink-0 mt-0.5 ${INK.bad}`} strokeWidth="2" />
        : <InfoIcon className="w-4 h-4 shrink-0 mt-0.5" />}
      <span className={`whitespace-pre-wrap break-words ${problem ? INK.bad : ''}`}>{text}</span>
    </div>
  );
}

function TranscriptItem({ message }) {
  if (message.role === 'system') return <SystemNote text={message.text} problem={message.problem} />;

  const iso = message.time.toISOString();
  const shown = clock(message.time);

  if (message.role === 'user') {
    const spoken = message.source === 'voice';
    const Icon = spoken ? WaveIcon : KeyboardIcon;
    return (
      <div className="flex flex-col items-end">
        <div className={`${WELL} max-w-[75%] px-4 py-3`}>
          <div className={`flex items-center justify-end gap-1.5 mb-1 ${MUTED}`}>
            <Icon className="w-3.5 h-3.5" />
            <span>{spoken ? 'You said' : 'You typed'}</span>
            <time dateTime={iso} className="ml-2 tabular-nums">{shown}</time>
          </div>
          <div className={`${BODY} whitespace-pre-wrap break-words`}>“{message.text}”</div>
        </div>
      </div>
    );
  }

  // AbleSpeak's reply
  const calls = message.toolCalls || [];
  const meta = [
    message.model || message.provider,
    Number.isFinite(message.latency) ? `${message.latency} ms` : null,
  ].filter(Boolean).join(' · ');
  const hasFooter = calls.length > 0 || !!meta;

  return (
    <div className="flex flex-col items-start">
      <div className={`max-w-[80%] rounded-lg border ${DIVIDER} px-4 py-3`}>
        <div className="flex items-center gap-2 mb-1">
          <span className={`w-2 h-2 rounded-full shrink-0 ${message.error ? DOT.bad : DOT.ok}`} aria-hidden="true" />
          <span className={`text-[13px] font-medium ${message.error ? INK.bad : 'text-[#dae3f4]'}`}>
            {message.error ? 'AbleSpeak (didn’t work)' : 'AbleSpeak'}
          </span>
          <time dateTime={iso} className={`${MUTED} tabular-nums`}>{shown}</time>
        </div>

        <div className={`${BODY} ${hasFooter ? 'mb-2.5' : ''} whitespace-pre-wrap break-words`}>{message.text}</div>

        {hasFooter && (
          <div className={`flex flex-wrap items-center gap-x-4 gap-y-1.5 pt-2.5 border-t ${DIVIDER}`}>
            {calls.map((tc, i) => {
              const name = tc.tool || tc.name || 'tool';
              if (!toolFailed(tc)) {
                return (
                  <span key={i} className="inline-flex items-center gap-1.5">
                    <WrenchIcon className="w-3.5 h-3.5 text-[#8b95a7]" />
                    <span className={CODE}>{name}</span>
                  </span>
                );
              }
              const reason = tc.result?.error || tc.result?.message;
              const showReason = typeof reason === 'string' && reason && !message.text?.includes(reason);
              return (
                <span key={i} className="contents">
                  <span className="inline-flex items-center gap-1.5">
                    <FailedIcon className={`w-3.5 h-3.5 ${INK.bad}`} />
                    <span className={CODE}>{name}</span>
                    <span className={`text-[13px] ${INK.bad}`}>failed</span>
                  </span>
                  {showReason && <span className={`${MUTED} break-words`}>{reason}</span>}
                </span>
              );
            })}
            {meta && <span className={`${MUTED} tabular-nums`}>{meta}</span>}
          </div>
        )}
      </div>
    </div>
  );
}
