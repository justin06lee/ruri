/**
 * The page the window shows when the computer it is onto can't be reached
 * (desktop/remote.ts): which computer, what is being tried, and the way
 * back to this one. Plain HTML from a data: URL — there is no server here
 * to serve the real page from. Its buttons go to the shell (desktop/preload.ts).
 */

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** What the window shows for the moment it takes to move to another
 *  computer — this computer's server is closing behind it. */
export function movingPage(name: string): string {
  return offlinePage({ name, detail: "", addresses: [], unpaired: false, moving: true });
}

export function offlinePage(opts: {
  name: string;
  detail: string;
  addresses: string[];
  unpaired: boolean;
  /** Not a failure: the window on its way there. */
  moving?: boolean;
}): string {
  const { name, detail, addresses, unpaired, moving = false } = opts;
  const heading = moving
    ? `Moving to ${escape(name)}…`
    : unpaired
      ? `${escape(name)} doesn't know this device any more`
      : `Can't reach ${escape(name)}`;
  const line = moving
    ? "This computer's chats are closing down; the window opens on the other one in a moment."
    : unpaired
      ? escape(detail)
      : `Still trying — this window picks up again by itself the moment ${escape(name)} answers.`;
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>ruri</title>
<style>
  :root { --bg:#f6f1e6; --ink:#2b2620; --soft:#7a7064; --line:#e2d9c8; --accent:#b4532a; }
  html,body { height:100%; margin:0; background:var(--bg); color:var(--ink);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif; }
  body { display:grid; place-items:center; -webkit-app-region: drag; }
  main { max-width: 420px; padding: 32px; text-align:center; -webkit-app-region: no-drag; }
  .mark { width:10px; height:10px; border-radius:50%; background:var(--accent); margin:0 auto 18px;
    animation: pulse 1.6s ease-in-out infinite; }
  .mark.still { animation:none; opacity:.5; }
  @keyframes pulse { 50% { opacity:.25; transform: scale(.8); } }
  h1 { font-size:18px; font-weight:600; margin:0 0 6px; }
  p { margin:0 0 6px; color:var(--soft); }
  .where { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; color:var(--soft); margin-top:10px; }
  .where span { white-space:nowrap; }
  .row { display:flex; gap:8px; justify-content:center; margin-top:22px; }
  button { font:inherit; padding:7px 14px; border-radius:8px; border:1px solid var(--line); background:transparent; color:var(--ink); cursor:pointer; }
  button:hover { border-color: var(--soft); }
  button.primary { background:var(--ink); color:var(--bg); border-color:var(--ink); }
</style></head>
<body><main>
  <div class="mark${unpaired ? " still" : ""}"></div>
  <h1>${heading}</h1>
  <p>${line}</p>
  <div class="where">${addresses.map((a) => `<span>${escape(a)}</span>`).join(" · ")}</div>
  ${
    moving
      ? ""
      : `<div class="row">
    ${unpaired ? "" : `<button onclick="window.ruriShell.retry()">Try now</button>`}
    <button class="primary" onclick="window.ruriShell.use(null)">Use this computer instead</button>
  </div>`
  }
</main></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
