import { useWebSocket } from '../hooks/useWebSocket';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useState, useEffect, useRef, useCallback } from 'react';
import { Mic, MicOff, Send, AlertCircle } from 'lucide-react';

export default function Chat() {
  const { lastMessage, wsRef } = useWebSocket();
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
  const hasGreetedRef = useRef(false);

  // ── TTS: Speak text aloud ──
  const speak = useCallback((text) => {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;
    // Try to pick a good English voice
    const voices = window.speechSynthesis.getVoices();
    const preferred = voices.find(v => v.name.includes('Microsoft Zira') || v.name.includes('Google') || v.lang.startsWith('en'));
    if (preferred) utterance.voice = preferred;
    window.speechSynthesis.speak(utterance);
    return utterance;
  }, []);

  // ── Send command via WebSocket ──
  const sendCommand = useCallback((text) => {
    if (!text) return;

    setMessages(prev => [...prev, {
      id: Date.now(),
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
        audio: base64,
        mimeType: audioBlob.type || 'audio/webm',
      }));
    };
    reader.readAsDataURL(audioBlob);
  }, [wsRef]);

  // ── Silence detection using AnalyserNode ──
  const startSilenceDetection = useCallback((stream) => {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.3;
    source.connect(analyser);
    analyserRef.current = { audioCtx, analyser };

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
      // Greet on first mic activation
      if (!hasGreetedRef.current) {
        hasGreetedRef.current = true;
        const utterance = speak('Hi, I am AbleSpeak. How may I assist you today?');
        if (utterance) {
          // Wait for greeting to finish before starting recording
          await new Promise(resolve => {
            utterance.onend = resolve;
            // Safety timeout in case onend doesn't fire
            setTimeout(resolve, 4000);
          });
        }
      }

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
        if (analyserRef.current?.audioCtx) {
          analyserRef.current.audioCtx.close();
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
        id: Date.now(),
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
  useEffect(() => {
    if (!lastMessage) return;

    if (lastMessage.type === 'voice_transcription') {
      // Show what was heard
      setMessages(prev => [...prev, {
        id: Date.now(),
        role: 'user',
        text: lastMessage.text,
        source: 'voice',
        time: new Date()
      }]);
      setProcessing(true);
    }

    if (lastMessage.type === 'voice_no_speech') {
      setVoiceState('idle');
      setProcessing(false);
    }

    if (lastMessage.type === 'voice_error') {
      setVoiceState('idle');
      setProcessing(false);
      setMessages(prev => [...prev, {
        id: Date.now(),
        role: 'system',
        text: `Voice error: ${lastMessage.error}`,
        time: new Date()
      }]);
    }

    if (lastMessage.type === 'command_complete') {
      setProcessing(false);
      setVoiceState('idle');
      const result = lastMessage.result;
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
          id: Date.now(),
          role: 'assistant',
          text: responseText,
          tool: lastMessage.tool,
          latency: lastMessage.latency_ms,
          time: new Date()
        }]);
      }
    }

    if (lastMessage.type === 'chat_assistant_message') {
      setProcessing(false);
      setVoiceState('idle');
      setMessages(prev => [...prev, {
        id: lastMessage.id || Date.now(),
        role: 'assistant',
        text: lastMessage.text,
        error: lastMessage.error,
        provider: lastMessage.provider,
        model: lastMessage.model,
        latency: lastMessage.latency,
        toolCalls: lastMessage.toolCalls,
        source: lastMessage.source,
        time: new Date()
      }]);
    }

    if (lastMessage.type === 'prompt_switch') {
      setMessages(prev => [...prev, {
        id: Date.now(),
        role: 'system',
        text: `Switched to ${lastMessage.prompt} mode`,
        time: new Date()
      }]);
    }
  }, [lastMessage]);

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
      if (analyserRef.current?.audioCtx) {
        analyserRef.current.audioCtx.close();
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
            placeholder="Type a message..."
            value={inputText}
            onChange={e => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            aria-label="Type a message"
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
            {message.toolCalls.map((tc, i) => (
              <span key={i} className="as-tool-tag">🔧 {tc.tool}</span>
            ))}
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
