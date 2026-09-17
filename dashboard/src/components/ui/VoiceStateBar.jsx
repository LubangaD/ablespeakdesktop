import { MicOff, LoaderCircle, Volume2, Moon, PenLine } from 'lucide-react';

/**
 * The voice state from DESIGN.md "Voice State Bar": each state has its own
 * colour, icon and word, so it can be read without seeing colour.
 */
const STATES = {
  idle: { label: 'MIC OFF', icon: MicOff },
  listening: { label: 'LISTENING', icon: null }, // animated bars instead
  processing: { label: 'PROCESSING', icon: LoaderCircle },
  speaking: { label: 'SPEAKING', icon: Volume2 },
  dictating: { label: 'DICTATING', icon: PenLine },
  sleeping: { label: 'SLEEPING', icon: Moon },
};

export default function VoiceStateBar({ state = 'idle', detail, className = '' }) {
  const { label, icon: Icon } = STATES[state] || STATES.idle;
  return (
    <div className={`voice-state voice-${state} ${className}`.trim()} role="status" aria-live="polite">
      {Icon ? (
        <Icon size={20} aria-hidden="true" className="voice-state-icon" />
      ) : (
        <span className="voice-bars" aria-hidden="true"><i /><i /><i /><i /></span>
      )}
      <span className="voice-state-label">{label}</span>
      {detail && <span className="voice-state-detail">{detail}</span>}
    </div>
  );
}
