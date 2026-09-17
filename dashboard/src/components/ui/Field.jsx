import { useRef } from 'react';
import { X } from 'lucide-react';

/**
 * Form fields from DESIGN.md "Input Fields": 56px tall, a 1.5px outline
 * that turns amber on focus.
 *
 * <Field> wraps any control with its label and hint:
 *   <Field id="x" label="Name" hint="…"><input id="x" className="field-input" /></Field>
 *
 * <TextField> is a text input with a built-in 48×48 clear button, so
 * nobody has to press Backspace over and over to empty it.
 */
export function Field({ id, label, hint, className = '', children }) {
  return (
    <div className={`field ${className}`.trim()}>
      {label && <label htmlFor={id} className="field-label">{label}</label>}
      {children}
      {hint && <p id={`${id}-hint`} className="field-hint">{hint}</p>}
    </div>
  );
}

export function TextField({ id, label, hint, value, onChange, onClear, inputRef: outerRef, className = '', inputClassName = '', ...rest }) {
  const inputRef = useRef(null);
  const setRef = el => {
    inputRef.current = el;
    if (outerRef) outerRef.current = el;
  };
  const name = label || rest['aria-label'] || 'this field';
  const clear = () => {
    if (onClear) onClear();
    else onChange?.({ target: { value: '' } });
    inputRef.current?.focus();
  };

  return (
    <Field id={id} label={label} hint={hint} className={className}>
      <div className="field-wrap">
        <input
          ref={setRef}
          id={id}
          className={`field-input has-clear ${inputClassName}`.trim()}
          value={value}
          onChange={onChange}
          aria-describedby={hint ? `${id}-hint` : undefined}
          {...rest}
        />
        {value ? (
          <button type="button" className="field-clear" onClick={clear} aria-label={`Clear ${typeof name === 'string' ? name : 'this field'}`}>
            <X size={20} aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </Field>
  );
}
