import { useEffect, useRef, useState } from 'react';

/**
 * The turning AbleSpeak globe (src/lib/globeScene.js), as a decoration: the
 * flat logo shows until it is ready, and stays if the computer cannot draw
 * 3D. Three.js loads only when this is on screen, so the rest of the
 * dashboard does not carry it. Hidden from screen readers; drag to spin it.
 */
export default function AbleSpeakGlobe({ className = '' }) {
  const host = useRef(null);
  const stage = useRef(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let dispose = null;
    let cancelled = false;
    import('../lib/globeScene')
      .then(({ mountGlobe }) => {
        if (cancelled || !stage.current) return;
        dispose = mountGlobe(stage.current, host.current);
        if (dispose) setReady(true);
      })
      .catch(() => { /* the flat logo stays */ });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);

  return (
    <div
      ref={host}
      aria-hidden="true"
      className={`relative select-none touch-pan-y ${ready ? 'cursor-grab data-[dragging=true]:cursor-grabbing' : ''} ${className}`}
    >
      <div ref={stage} className="absolute -inset-x-10 -inset-y-6" />
      {!ready && (
        <img
          src="/ablespeak-logo.png"
          alt=""
          draggable="false"
          className="absolute inset-0 m-auto w-[45%] max-w-[220px] aspect-square rounded-full shadow-[0_24px_60px_rgba(245,166,35,0.25)]"
        />
      )}
    </div>
  );
}
