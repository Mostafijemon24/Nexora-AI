import type { ButtonHTMLAttributes, ReactNode } from 'react';

const Corners = () => (
  <>
    <i className="corner tl" /><i className="corner tr" /><i className="corner bl" /><i className="corner br" />
  </>
);

/** Blueprint card: transparent, hairline border, "+" registration marks at all four corners. `tour` names it for the page tour. */
export function Card({ kicker, children, className = '', style, tour }: { kicker?: ReactNode; children: ReactNode; className?: string; style?: React.CSSProperties; tour?: string }) {
  return (
    <div className={`card blueprint ${className}`} style={style} data-tour={tour}>
      <Corners />
      {kicker !== undefined && <div className="card-kicker">{kicker}</div>}
      {children}
    </div>
  );
}

export function CardButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" className="card blueprint" onClick={onClick}>
      <Corners />
      {children}
    </button>
  );
}

/** The one solid object on the board: accent fill, square corners, registration marks. */
export function PrimaryButton({ children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className="btn btn-primary blueprint" {...rest}>
      <Corners />
      {children}
    </button>
  );
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'secondary' | 'ghost'; icon?: boolean };
export function Button({ variant = 'secondary', icon, className = '', ...rest }: BtnProps) {
  return <button type="button" className={`btn btn-${variant}${icon ? ' btn-icon' : ''} ${className}`} {...rest} />;
}

export function Chip({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return <button type="button" className="tag tag-outline" onClick={onClick}>{children}</button>;
}

export function Seg<T extends string>({ value, options, onChange, name, style, wrap, tour }: {
  value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void; name: string; style?: React.CSSProperties; wrap?: boolean; tour?: string;
}) {
  return (
    <div className="seg" role="radiogroup" aria-label={name} style={{ ...(wrap ? { flexWrap: 'wrap' } : null), ...style }} data-tour={tour}>
      {options.map(([id, label]) => (
        <label className="seg-opt" key={id}>
          <input type="radio" name={name} checked={value === id} onChange={() => onChange(id)} />
          <span>{label}</span>
        </label>
      ))}
    </div>
  );
}

export function Switch({ on, onChange, label }: { on: boolean; onChange: () => void; label: string }) {
  return (
    <button
      type="button" role="switch" aria-checked={on} aria-label={label} title={label} className="switch"
      onClick={(e) => { e.stopPropagation(); onChange(); }}
    />
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
    </div>
  );
}

/** Label + text input wired together. */
export function TextField({ label, value, onChange, ...rest }: { label: string; value: string; onChange: (v: string) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'>) {
  return (
    <label className="field">
      <label>{label}</label>
      <input className="input" value={value} onChange={(e) => onChange(e.target.value)} {...rest} />
    </label>
  );
}

export const ErrorText = ({ children }: { children: ReactNode }) => <div className="error" role="alert">{children}</div>;
