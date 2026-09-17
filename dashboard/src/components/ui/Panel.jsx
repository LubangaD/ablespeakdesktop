/**
 * A surface from DESIGN.md "Elevation & Depth".
 *   level 1 — docks and long lists
 *   level 2 — cards and panels (the default)
 *   level 3 — anything floating above the page
 * An optional header shows an icon, a title and something on the right.
 */
export default function Panel({
  as: Tag = 'section',
  level = 2,
  title,
  titleId,
  icon: Icon,
  aside,
  flush = false,
  className = '',
  children,
  ...rest
}) {
  const classes = ['panel', `surface-${level}`, flush && 'panel-flush', className].filter(Boolean).join(' ');
  return (
    <Tag className={classes} aria-labelledby={title && titleId ? titleId : undefined} {...rest}>
      {title && (
        <header className="panel-header">
          {Icon && <Icon size={20} aria-hidden="true" className="panel-icon" />}
          <h3 id={titleId} className="panel-title">{title}</h3>
          {aside && <div className="panel-aside">{aside}</div>}
        </header>
      )}
      <div className="panel-body">{children}</div>
    </Tag>
  );
}
