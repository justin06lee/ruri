import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./chat/Icon";

/**
 * A question with two answers, in the app's own card instead of the
 * browser's dialog: `confirm()` resolves true on the primary button and
 * false on cancel, Escape, or a click outside. With `cancel: null` it is
 * a notice — one button, always resolves true.
 */
export interface ConfirmOptions {
  title: string;
  /** The thing the question is about, quoted. */
  quote?: string;
  body?: ReactNode;
  ok?: string;
  /** Destructive actions use the system red button. */
  destructive?: boolean;
  /** The cancel button's label; null for a notice with no cancel at all. */
  cancel?: string | null;
}

/** The notice for files too big to attach, the names in one line. */
export function tooBigNotice(files: File[]): ConfirmOptions {
  const names = files.map((file) => file.name).join(", ");
  return {
    title: "Too big to attach",
    body: `${names} ${files.length === 1 ? "is" : "are"} over 25MB.`,
    cancel: null,
  };
}

interface Pending {
  opts: ConfirmOptions;
  resolve: (answer: boolean) => void;
}

/** Ask through the card: `confirm` opens it, `card` is what to render. */
export function useConfirm(): { confirm: (opts: ConfirmOptions) => Promise<boolean>; card: ReactNode } {
  const [pending, setPending] = useState<Pending | null>(null);
  const live = useRef<Pending | null>(null);
  const confirm = useCallback((opts: ConfirmOptions) => {
    // a second question while one stands answers the first with no
    live.current?.resolve(false);
    return new Promise<boolean>((resolve) => {
      const next = { opts, resolve };
      live.current = next;
      setPending(next);
    });
  }, []);
  const answer = useCallback((yes: boolean) => {
    live.current?.resolve(yes);
    live.current = null;
    setPending(null);
  }, []);
  // whoever asked is gone: the answer is no
  useEffect(() => () => live.current?.resolve(false), []);
  const card = pending ? <ConfirmCard opts={pending.opts} onAnswer={answer} /> : null;
  return { confirm, card };
}

function ConfirmCard({ opts, onAnswer }: { opts: ConfirmOptions; onAnswer: (yes: boolean) => void }) {
  const notice = opts.cancel === null;
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onAnswer(notice);
        return;
      }
      if (e.key !== "Tab") return;
      const buttons = dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
      const first = buttons?.[0];
      const last = buttons?.[buttons.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    const trigger = returnFocus.current;
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (trigger?.isConnected) trigger.focus();
    };
  }, [notice, onAnswer]);
  // on the body, so a row's own click handlers never see the answer
  return createPortal(
    <div
      className="confirm-overlay"
      onClick={(e) => {
        e.stopPropagation();
        onAnswer(notice);
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div
        className="confirm-card"
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <button className="icon-button confirm-close" aria-label="Close" onClick={() => onAnswer(notice)}>
          <Icon d="M6 6l12 12M18 6L6 18" />
        </button>
        <div className="confirm-symbol" aria-hidden>
          <Icon
            d={
              opts.destructive
                ? "M12 3l10 18H2L12 3zM12 9v5M12 17h.01"
                : "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 10v6M12 7h.01"
            }
          />
        </div>
        <div className="confirm-title" id={titleId}>
          {opts.title}
        </div>
        {opts.quote && <div className="confirm-quote">{opts.quote}</div>}
        {opts.body && <div className="confirm-body">{opts.body}</div>}
        <div className="confirm-actions">
          {!notice && (
            <button className="ghost" onClick={() => onAnswer(false)}>
              {opts.cancel ?? "Cancel"}
            </button>
          )}
          <button
            className={`primary${opts.destructive ? " destructive" : ""}`}
            autoFocus
            onClick={() => onAnswer(true)}
          >
            {opts.ok ?? "OK"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
