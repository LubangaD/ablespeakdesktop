/**
 * One number with its label. Numbers use tabular figures so they don't
 * shift sideways as they change (DESIGN.md "Numerics").
 */
export default function StatTile({ label, value, detail, tone, className = '' }) {
  return (
    <div className={`stat-tile ${className}`.trim()}>
      <div className="stat-tile-label">{label}</div>
      <div className={`stat-tile-value tabular${tone ? ` tone-${tone}` : ''}`}>{value}</div>
      {detail && <div className="stat-tile-detail">{detail}</div>}
    </div>
  );
}
