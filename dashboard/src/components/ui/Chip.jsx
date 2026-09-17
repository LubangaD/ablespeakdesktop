import { CircleCheck } from 'lucide-react';

/**
 * A filter chip that can be switched on and off. When selected it shows
 * a check mark as well as the teal fill, so selection never relies on
 * colour alone.
 */
export default function Chip({ selected = false, count, children, className = '', ...rest }) {
  return (
    <button
      type="button"
      className={`chip${selected ? ' selected' : ''} ${className}`.trim()}
      aria-pressed={selected}
      {...rest}
    >
      {selected && <CircleCheck size={16} aria-hidden="true" />}
      <span>{children}</span>
      {count != null && <span className="chip-count">{count}</span>}
    </button>
  );
}
