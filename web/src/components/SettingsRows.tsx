import { useState, type ReactNode } from "react";

/**
 * The pieces a settings panel is made of, for the editors that are more
 * than a row or two (BandEditor.tsx, HeroEditor.tsx): a labelled row, and a
 * number field that can be typed into.
 */

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="settings-row">
      <span className="settings-label">{label}</span>
      <div className="settings-value">{children}</div>
    </div>
  );
}

/** A number typed in: what is being typed stays as typed ("-", "1.") until
 *  it is a number, rather than the field snapping back to the last one. */
export function NumField({
  label,
  value,
  onChange,
  places = 0,
}: {
  label: string;
  value: number;
  onChange(n: number): void;
  /** Decimal places kept; whole numbers unless said. */
  places?: number;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const f = 10 ** places;
  return (
    <label className="bandedit-num">
      <input
        type="number"
        step={1 / f}
        value={draft ?? String(value)}
        onChange={(e) => {
          setDraft(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value.trim() !== "" && Number.isFinite(n)) onChange(Math.round(n * f) / f);
        }}
        onBlur={() => setDraft(null)}
      />
      <span>{label}</span>
    </label>
  );
}
