import { useEffect, useRef, useState } from "react";

export interface DropdownOption {
  value: string;
  label: string;
}

/** Manga-styled replacement for a native <select>: trigger + ink-bordered menu. */
export function Dropdown({
  value,
  options,
  onSelect,
  title,
}: {
  value: string;
  options: DropdownOption[];
  onSelect(value: string): void;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = options.find((o) => o.value === value) ?? options[0];

  return (
    <div className="dropdown" ref={ref}>
      <button
        className={`dropdown-trigger ${open ? "open" : ""}`}
        title={title}
        onClick={() => setOpen(!open)}
      >
        <span className="dropdown-label">{current?.label ?? ""}</span>
        <svg
          className="dropdown-chevron"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="dropdown-menu" role="listbox">
          {options.map((option) => (
            <button
              key={option.value}
              role="option"
              aria-selected={option.value === value}
              className={`dropdown-item ${option.value === value ? "selected" : ""}`}
              onClick={() => {
                onSelect(option.value);
                setOpen(false);
              }}
            >
              <svg
                className="dropdown-check"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M20 6L9 17l-5-5" />
              </svg>
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
