import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onAnswer(notice);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
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
      <div className="confirm-card" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-title">{opts.title}</div>
        {opts.quote && <div className="confirm-quote">{opts.quote}</div>}
        {opts.body && <div className="confirm-body">{opts.body}</div>}
        <div className="confirm-actions">
          {!notice && (
            <button className="ghost" onClick={() => onAnswer(false)}>
              {opts.cancel ?? "Cancel"}
            </button>
          )}
          <button className="primary" autoFocus onClick={() => onAnswer(true)}>
            {opts.ok ?? "OK"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
