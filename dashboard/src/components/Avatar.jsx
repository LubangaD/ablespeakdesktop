/**
 * A person's picture: the photo on their AbleSpeak account (GET
 * /api/account/photo, from its private folder), else their Google photo,
 * else their initials. Decorative: the name always sits beside it.
 */
import { useState } from 'react';

/** "Amina Otieno" → "AO"; "amina@school.ke" → "A". */
export function initialsOf(name = '', email = '') {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (words.length) return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
  return String(email || '?').trim().charAt(0).toUpperCase() || '?';
}

export default function Avatar({ photo, name, email, size = 32, className = '' }) {
  const src = photo?.own ? `/api/account/photo?v=${photo.version || 0}` : photo?.google || null;
  const [failedSrc, setFailedSrc] = useState(null);
  const style = { width: size, height: size, fontSize: Math.max(11, Math.round(size * 0.38)) };
  if (src && failedSrc !== src) {
    return (
      <img
        src={src}
        alt=""
        aria-hidden="true"
        referrerPolicy="no-referrer"
        onError={() => setFailedSrc(src)}
        className={`rounded-full object-cover shrink-0 border border-[var(--line-strong)] ${className}`}
        style={style}
        draggable="false"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`rounded-full shrink-0 bg-[var(--sunken)] border border-[var(--line-strong)] flex items-center justify-center text-[var(--ink-quiet)] font-[640] ${className}`}
      style={style}
    >
      {initialsOf(name, email)}
    </span>
  );
}
