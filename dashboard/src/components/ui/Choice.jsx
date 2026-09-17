/**
 * Checkbox and radio button from DESIGN.md "Checkboxes & Radio Switches".
 * The whole row is the click target (at least 48px tall); the box itself
 * is 24px. A checked box is teal with a check mark; a chosen radio is an
 * amber dot inside a ring, so the two never look alike.
 */
function Choice({ type, label, hint, className = '', ...rest }) {
  return (
    <label className={`choice ${className}`.trim()}>
      <input type={type} className={`choice-${type}`} {...rest} />
      <span className="choice-text">
        <span className="choice-label">{label}</span>
        {hint && <span className="choice-hint">{hint}</span>}
      </span>
    </label>
  );
}

export function Checkbox(props) {
  return <Choice type="checkbox" {...props} />;
}

export function Radio(props) {
  return <Choice type="radio" {...props} />;
}
