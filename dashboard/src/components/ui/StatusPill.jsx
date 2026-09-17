import { CircleCheck, TriangleAlert, CircleX, Info, Circle } from 'lucide-react';

const ICONS = {
  success: CircleCheck,
  warning: TriangleAlert,
  error: CircleX,
  info: Info,
  neutral: Circle,
};

/**
 * A live status chip. Always an icon and a word, never colour alone
 * (DESIGN.md "Zero Ambiguity"). Labels are one or two words; they are
 * shown in capitals by CSS, so screen readers read the words normally.
 */
export default function StatusPill({ tone = 'neutral', icon, label, className = '', ...rest }) {
  const Icon = icon || ICONS[tone] || Circle;
  return (
    <span className={`status-pill status-${tone} ${className}`.trim()} {...rest}>
      <Icon size={14} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}
