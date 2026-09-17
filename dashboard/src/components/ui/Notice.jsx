import { CircleCheck, TriangleAlert, CircleX, Info } from 'lucide-react';

const ICONS = { success: CircleCheck, warning: TriangleAlert, error: CircleX, info: Info };

/**
 * A message block with an icon and a coloured edge. Errors are announced
 * straight away (role="alert"); everything else politely.
 */
export default function Notice({ tone = 'info', icon, title, className = '', children, ...rest }) {
  const Icon = icon || ICONS[tone] || Info;
  return (
    <div
      className={`notice notice-${tone} ${className}`.trim()}
      role={tone === 'error' ? 'alert' : 'status'}
      {...rest}
    >
      <Icon size={20} aria-hidden="true" className="notice-icon" />
      <div className="notice-body">
        {title && <p className="notice-title">{title}</p>}
        {children}
      </div>
    </div>
  );
}
