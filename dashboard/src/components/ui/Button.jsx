import { OctagonX } from 'lucide-react';

/**
 * Buttons from DESIGN.md "Components → Buttons".
 *   primary   — amber, 56px tall; the one main action in a section
 *   secondary — glass surface, 48px; everything else
 *   danger    — coral outline; removing or deleting something
 *   stop      — coral outline with the stop icon and the word STOP
 *   ghost     — no surface until hovered; for actions inside a row
 */
export default function Button({
  variant = 'secondary',
  icon: Icon,
  iconOnly = false,
  block = false,
  className = '',
  children,
  type = 'button',
  ...rest
}) {
  const classes = ['btn', `btn-${variant}`, iconOnly && 'btn-icon', block && 'btn-block', className]
    .filter(Boolean)
    .join(' ');
  const Glyph = variant === 'stop' && !Icon ? OctagonX : Icon;

  return (
    <button type={type} className={classes} {...rest}>
      {Glyph && <Glyph size={20} aria-hidden="true" />}
      {variant === 'stop' ? <span>{children || 'STOP'}</span> : children}
    </button>
  );
}
