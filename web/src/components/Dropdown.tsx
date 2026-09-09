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
  up = false,
}: {
  value: string;
  options: DropdownOption[];
  onSelect(value: string): void;
  title?: string;
  /** Open the menu above the trigger (for triggers near the bottom edge). */
  up?: boolean;
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
        <div className={`dropdown-menu ${up ? "up" : ""}`} role="listbox">
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

/** A second list that opens off a row of the first — the menu's own
 *  "effort level ›", with the levels beside it. */
export interface DropdownSub {
  key: string;
  label: string;
  value: string;
  options: DropdownOption[];
  onSelect(value: string): void;
}

const CHECK = (
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
);

/**
 * The composer's three pickers as one, for a box too narrow to hold them
 * side by side: the models as the list, and under them a row per other
 * setting that opens its choices in a flyout beside the menu. The trigger
 * reads the model, since that is the pick that changes what answers.
 */
export function ComboDropdown({
  value,
  options,
  onSelect,
  subs,
  title,
  up = false,
}: {
  value: string;
  options: DropdownOption[];
  onSelect(value: string): void;
  subs: DropdownSub[];
  title?: string;
  up?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState<string | null>(null);
  /** The flyout opens to the right unless the window ends there. */
  const [flip, setFlip] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (sub) setSub(null);
      else setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, sub]);

  useEffect(() => {
    if (!open) setSub(null);
  }, [open]);

  const showSub = (key: string) => {
    const menu = menuRef.current?.getBoundingClientRect();
    setFlip(Boolean(menu && menu.right + 190 > window.innerWidth));
    setSub(key);
  };

  const current = options.find((o) => o.value === value) ?? options[0];

  return (
    <div className="dropdown combo" ref={ref}>
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
        <div className={`dropdown-menu ${up ? "up" : ""}`} role="listbox" ref={menuRef}>
          {options.map((option) => (
            <button
              key={option.value}
              role="option"
              aria-selected={option.value === value}
              className={`dropdown-item ${option.value === value ? "selected" : ""}`}
              onMouseEnter={() => setSub(null)}
              onClick={() => {
                onSelect(option.value);
                setOpen(false);
              }}
            >
              {CHECK}
              {option.label}
            </button>
          ))}
          {subs.length > 0 && <div className="dropdown-rule" />}
          {subs.map((entry) => {
            const picked = entry.options.find((o) => o.value === entry.value);
            return (
              <div key={entry.key} className={`dropdown-sub ${sub === entry.key ? "open" : ""}`}>
                <button
                  className="dropdown-item sub-row"
                  aria-haspopup="listbox"
                  aria-expanded={sub === entry.key}
                  onMouseEnter={() => showSub(entry.key)}
                  onClick={() => (sub === entry.key ? setSub(null) : showSub(entry.key))}
                >
                  <span className="sub-label">{entry.label}</span>
                  <span className="sub-value">{picked?.label ?? entry.value}</span>
                  <svg
                    className="sub-chevron"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d="M9 6l6 6-6 6" />
                  </svg>
                </button>
                {sub === entry.key && (
                  <div className={`dropdown-flyout ${flip ? "left" : ""}`} role="listbox">
                    {entry.options.map((option) => (
                      <button
                        key={option.value}
                        role="option"
                        aria-selected={option.value === entry.value}
                        className={`dropdown-item ${option.value === entry.value ? "selected" : ""}`}
                        onClick={() => {
                          entry.onSelect(option.value);
                          setOpen(false);
                        }}
                      >
                        {CHECK}
                        {option.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
