# Token efficiency: what ruri spends, and how to spend less

Written 2026-10-22 for Justin, by ruri's lead. Q1 (the cost ledger) is built; nothing else here is yet. Goal: keep weekly Claude usage under a hard 80%.

## The headline

1. **ruri's own cost figures are wrong, 7–10× too high.** `server/sessions.ts:2078` stores the CLI's `total_cost_usd` as each turn's cost. For a long-running CLI process that number is the running total of the whole process. Each turn records the total again, and the ledger (`~/.config/ruri/ledger.json`) adds them up. Checked on this lead's last six turns: the transcript tokens match exactly, and the recorded "costs" climb $2.97 → $3.10 → $3.16 → $3.26 → $3.40 → $4.49 while the real per-turn costs were $0.03–$1.09. That is where "$15–18 per Lead turn" and "Leads + Liaisons ≈ 55%" come from: leads are the longest-lived processes, so their running totals are the largest.
2. **Measured from the transcripts instead, the teammates are the cost, not the Leads.** Teammates are 80% of spend, Leads 9%, Liaisons 0.3%.
3. **What makes a teammate expensive is the size of its context, not what it writes.** Teammates average 223k tokens of context on every model call, and a turn makes about 15 calls. 93% of all tokens are cache reads of that history.

## Re-based (after midna's correction, 15:00)

midna re-counted today from ruri's event logs, summing each session's increments, and got about $221. The transcripts give more: **$535 for ruri's chats on Oct 22 through 15:01**. By project: cobalt $187, mira $140, ambrosia $138 (the "Files app" teammate alone was $103), ucscmsa.com $34, neeko $15, toji $9, ruri $7, midna $4. The event logs undercount for two reasons: they keep only each chat's recent events, and the first result of every process has no increment to take. The conclusion is the same either way: **the Leads are not the cost.** Ranked, the drivers are:

1. **Long worker sessions:** about 223k of history is re-read on every model call (about 15 calls a turn), and re-cached after every idle hour. This is about half of worker spend. Fixes: Q2, S1.
2. **Fan-out and agent wakes:** 68% of worker turns are started by another agent, at $0.74 median and $1.71 mean each, mostly to re-read history. Cobalt woke 7 teammates at once for small sequential items. Fixes: Q3, Q6, S3.
3. **Polling:**
   - midna's own about 168 wakeups a day (about $79/day by midna's count; not on this Mac's transcripts, and midna is fixing it);
   - Leads woken for every "later" report, each a re-cache after idle.

   Fix: event-driven wakeups only (Q6), and nothing on a timer.
4. **Opus at high effort everywhere:** 99% of worker spend is Opus, and ruri runs at `xhigh`. Fixes: Q5, S2.

ruri's own figures: every cost the app shows (the Statistics page, the project rows, the home board's "done · $", the hooks' `costUsd`) comes from each turn's result or from the ledger, both of which Q1 fixed at the source (adb8780). Nothing else in ruri adds the running totals up. Result lines already in old transcripts keep the running-total figure they were recorded with.

## What it costs (measured)

Source: every Claude Code transcript on this Mac (`~/.claude/projects/**.jsonl`), Oct 15–22. Each model call is counted once, priced at list price (Opus 5.5: $4 in, $20 out, $0.20 cache read; cache writes 1.25× for 5 minutes and 2× for 1 hour; Sonnet 5.5 $2/$10/$0.20; Haiku 5.5 $0.10/$0.50), and matched to ruri's chats through `~/.config/ruri/sessions/*.json`. Scripts: `/tmp/tokaudit/`. Not counted: usage on tenet, on claude.ai and in Codex. Those draw on the same weekly % (Justin's login is on tenet too), so the % climbs faster than this Mac's numbers show.

**By day** (API-price equivalent): Oct 19 $640 · Oct 20 $882 · **Oct 21 $1,269** · Oct 22 $500 (to 14:40). 7-day total: about $3.75k. ruri's ledger says $27k for the same days.

**By role, 7 days:**

| Role | Spend | Share | Cache reads | Cache writes | Output | Avg context per call | Woken by an agent |
|---|---|---|---|---|---|---|---|
| Teammates | $2,998 | 80% | 48% | 34% | 18% | 223k | 68% of their prompts |
| Outside ruri's chats* | $417 | 11% | 23% | 55% | 23% | 25k | — |
| Leads | $326 | 9% | 24% | 66% | 10% | 241k | 62% of their prompts |
| Liaisons | $13 | 0.3% | 10% | 77% | 13% | 64k | 91% |

\*Outside ruri's chats: ruri's background small-model calls (45% Opus, 30% Sonnet, 25% Haiku; 37k tiny prompts) and other Claude sessions on this Mac. I didn't split these further.

**By project, 7 days:** mira $1,429 (38%) · cobalt $468 (12%) · ucscmsa.com $325 (9%) · ambrosia $287 (8%) · midna $247 (7%) · ruri $184 (5%) · the rest under 3% each.

**Per turn, Oct 21–22:**

| Turn | Count | Mean | Median | p90 | Model calls |
|---|---|---|---|---|---|
| Teammate, woken by an agent | 660 | $1.71 | $0.74 | $4.53 | 14.9 |
| Teammate, woken by the user | 243 | $1.27 | $0.15 | $4.29 | 17.2 |
| Lead, woken by the user | 230 | $0.46 | $0.20 | $1.51 | 2.0 |
| Lead, woken by a teammate's report | 349 | $0.15 | $0.11 | $0.25 | 1.5 |

- **Teammate context:** contexts sit near 220–290k and peak at about 500k, because self-compaction triggers at 500k. Every tool call re-reads all of it. 250k of cache reads costs $0.05 a call, so the history costs about $0.75 a turn before the agent has done anything.
- **Lead cost is mostly re-caching:** 55% of what Leads spend is cache rewrites of 30k tokens or more. A Lead sits idle for over an hour, its cache expires, and the next report rewrites its whole 240k history at the 1-hour write price of $8 per million.
- **Model mix:** teammates ran 99% on Opus, and the ruri project is set to `xhigh` effort.
- **Fan-out:** sending one message to 7 cobalt teammates means 7 wakes at about $0.74–1.71 each, mostly re-reading history, for small items that one agent could do in sequence.
- **Tool output:** tool results going into teammates came to about 29 MB in two days (about 7M tokens). Each one is then re-read on every later call until compaction.

## What the research says (short)

- **Context size drives cost.** Every request resends the whole conversation, re-read at the cache rate. Clear between unrelated tasks; a long-open session uses far more than the work suggests ([Claude Code: manage costs](https://code.claude.com/docs/en/costs), "Why usage climbs in a long session").
- **Cache discipline.** Caching matches on the prefix: any byte change invalidates everything after it, so keep timestamps and volatile text out of the early prompt. The first message after an idle longer than the cache lifetime reprocesses the full context ([prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching); same costs page).
- **Multi-agent costs a lot.** Agents use about 4× the tokens of chat, and multi-agent systems about 15×. It pays only when the task is valuable and genuinely parallel. "Most coding tasks involve fewer truly parallelizable tasks than research", and work needing shared context fits poorly ([Anthropic: multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)). Claude Code's own agent teams use about 7× a standard session in plan mode. Its advice: Sonnet for teammates, small teams, focused spawn prompts, and shut teammates down when done (costs page, "Agent team token costs").
- **Subagents return summaries.** Workers keep verbose output in their own context and hand back only the distilled result (same two sources).
- **Route by model.** Sonnet handles most coding; keep Opus for hard architecture and reasoning, and use Haiku for simple subagent jobs (costs page). On this price list, Sonnet 5.5's cache reads cost the same as Opus 5.5's ($0.20), so switching models cuts writes and output in half but does nothing for history reads. Shrinking the context is the bigger lever.
- **Effort and thinking.** Thinking is billed as output. Lower the effort for simpler work (costs page).
- **Trim tool output.** Filter test and log output to the failures with a hook, prefer grep and limits over cat, and push verbose operations into subagents (costs page).
- **Don't poll.** Scheduled tasks, cross-session messages and check-ins each start a full-context turn while idle (costs page). In ruri that is every "later" relay that wakes a Lead.

## Changes, ranked

Savings are a share of total spend, estimated from the mix above, so they overlap rather than add. Quick wins come first.

### Quick wins (safe, local)

| # | Change | Est. saving | Risk | Kind |
|---|---|---|---|---|
| Q1 | **Fix the cost ledger:** record each turn's delta of the CLI's running total, or price the turn's tokens directly. Fix the ledger history by rebuilding it from transcripts. | 0% by itself; every budget below depends on it | Low | Quick bug fix |
| Q2 | **Self-compact teammates at about 150k, not 500k** (the pref or env var already exists). | 20–30% | More compactions, a little lost continuity. Sheets and notes carry the rest. | Quick setting |
| Q3 | **No fan-out of small sequential items:** a Lead gives a series of small jobs to one agent, never seven at once. One Lead-prompt rule. | 5–10% on days like cobalt's | Slower for genuinely parallel work, which can still be split on purpose | Quick prompt change |
| Q4 | **Trim tool output:** a PreToolUse hook that cuts test, build and log output to failures and the last lines; teammates told to use grep and `head`, not cat. | 3–8% | A hidden line is occasionally needed; the agent can rerun unfiltered | Quick hook |
| Q5 | **Effort `high` instead of `xhigh`** for ruri's project, and `medium` for routine teammate work. | 5–8% | Slightly weaker on hard problems; hard jobs can set it higher | Quick setting |
| Q6 | **Quiet relays to Leads:** a teammate's "done" goes into a digest the Lead reads at its next real turn, instead of waking it. Only questions and blockers wake it. | 3–5% (Lead rewrites) | Updates arrive later | Small change |

Applying Q1–Q6 together: about **35–45% less**.

### Structural (need Justin's yes)

| # | Change | Est. saving | Risk | Kind |
|---|---|---|---|---|
| S1 | **Ephemeral workers instead of persistent teammates.** Each task starts a fresh session with a short brief (the task, the layer sheet, the catch-up) and ends with a summary of 2k tokens or less written to a task ledger. The process then exits. | 40–60% of teammate spend → **30–50% total** | Each task pays a cold start (about 30–60k of brief, about $0.25–0.50). A worker knows less than a long-lived teammate, but ruri's sheets, notes and recall exist to carry exactly that. | Structural |
| S2 | **Route models by task:** workers default to Sonnet 5.5. Opus only for hard calls (architecture, tricky bugs, reviews), escalating when a worker is stuck. Haiku 5.5 for mechanical jobs (summaries, relays, git chores, background calls). | 15–25% | Quality on hard work. Mitigated by escalation and by sampling results. | Medium |
| S3 | **A shared task ledger instead of chat relays:** tasks, status and results in one file per project that Leads, midna and the phone read. Nothing is relayed through a Lead's conversation. | 5–10% (most of the Lead and liaison spend) | Less "conversation", more reading a list | Medium |
| S4 | **A usage guard** (below) | Enforces the 80% ceiling | Paused work | Medium |

### Keep the teammate system, or retire it?

**My recommendation: retire persistent teammates, and keep a slim version.**
- **The expensive part is the teammates' long contexts, not coordination.** Leads are about 9% of spend and Liaisons 0.3%. The persistent teammate is the problem: a 220k history re-read 15 times a turn, re-cached after every idle hour, and woken by agents for 68% of its prompts.
- **The slim version:**
  - One Lead per project, on a short context: a fresh session per day or per big job, compacting at about 100k.
  - It hands each task to an ephemeral worker (S1) on Sonnet by default (S2), with at most 2 workers per project at once.
  - Results go to the task ledger (S3), not into the Lead's conversation.
  - The Lead is woken only for questions and blockers, and the usage guard (S4) sits on top.
- **Why not retire the system entirely:**
  - Ephemeral workers keep big reads, test runs and failed attempts out of the Lead's context, which is the main thing Anthropic's guidance says multi-agent setups are good for.
  - The layer sheets and notes already hold what persistent teammates were supposed to remember.
- **Why not keep it as it is:** at today's mix, the week's spend is about 80% persistent-teammate history.

Expected result with Q1–Q6 plus S1–S3: roughly **55–70% less** for the same work.

## Usage guard (proposal)

- **Real numbers first:** do Q1, then show each project's spend today, this week, and as a share of the weekly %. Put it on the project row, the home board, the team page and the phone's status. ruri already reads the plan's 5-hour and weekly % into `usage.json`, so the guard works from the real % (which includes tenet and claude.ai), not only from this Mac's own count.
- **Per-project budgets:** Justin ranks the projects and gives each a weekly share. The default is equal shares, with starred projects first. A project over its share drops to Sonnet and lower effort, and then queues instead of running.
- **Thresholds on the weekly %:**
  - **60%:** a notice. Unstarred projects move to Sonnet and `medium` effort, and nothing new fans out.
  - **70%:** low-ranked projects pause. Their current turn finishes, new work waits in the queue, and the row shows "paused: budget".
  - **80%:** everything pauses except Justin's own direct prompts and the projects he has marked as must-run, with a one-tap override that is logged.
  - **Weekly reset:** paused work resumes at the reset.
- **The 5-hour window gets the same treatment,** at 85%.
- **Never silent:** every pause or downgrade says why and when it lifts, in the app and to midna.

## Not measured, or uncertain

- **Codex, tenet and claude.ai** don't appear in this Mac's transcripts.
- **The weekly % is not linear in API dollars**, because plan limits weight usage their own way. The shares and ratios above hold; exact $→% doesn't.
- **"Outside ruri's chats" (11%) isn't broken down further.**
- **Haiku 5.5's cache-read price** is assumed at 10% of its input price.

## The new design (approved by Justin, 2026-10-22 15:06)

One Lead per project on a short context. The Lead never keeps a team in conversation: it writes each task to the project's task list and hands it to a **worker**, a fresh session that does that one task and exits. Workers run on Sonnet by default and Opus only for hard work, with at most two at once per project. A usage guard watches the week's % across everything.

```
  Justin / midna
        │ prompt
        ▼
  ┌──────────────────┐   1. writes the task     ┌───────────────────────────┐
  │ Lead (Opus)      │ ───────────────────────▶ │ Task list (one per        │
  │ short context:   │                          │ project): id · worker ·   │
  │ compacts at 100k │ ◀── 4. reads results ─── │ model · status · result · │
  └────────┬─────────┘     at its next prompt   │ cost                      │
           │ 2. starts                          └─────────────▲─────────────┘
           ▼                                                  │ 3. writes its
  ┌──────────────────┐  fresh session, brief =  ┌─────────────┴─────────────┐   report and
  │ Charter          │  charter + layer sheet   │ Worker: Sonnet, or Opus   │   exits
  │ (name, duty,     │  + catch-up + the task   │ for hard work; at most 2  │
  │ layers): what    │ ───────────────────────▶ │ per project; medium effort│
  │ teammates were   │                          └───────────────────────────┘
  └──────────────────┘
  Usage guard (weekly %): 60% → models step down · 70% → low-ranked projects pause · 80% → everything stops
```

**What changes:**
- **Teammates become charters.** Each teammate's name, duty and layers stay as a charter: a reference the Lead hands to a worker. A charter keeps no conversation. Every task starts a fresh session whose brief is the charter, its layer sheets, the project's catch-up and the task. A worker's follow-up questions within its task stay in that task's session. When it reports, its process closes and the next task starts fresh. What workers learn goes where it always should have: the sheets, notes and recall.
- **Models:**
  - Workers run on Sonnet 5.5 at `medium` effort.
  - A Lead marks a task as hard to give it Opus.
  - Leads keep Opus and compact at 100k.
  - At most 2 workers run at once per project; the rest wait in line.
- **The task list replaces chat relays.** A task is written when the Lead hands it on, marked working when its worker starts, and marked done, blocked or failed, with the worker's report and its cost, when the worker finishes. A finished report doesn't wake the Lead (Q6); a question or a blocker does. The Lead, midna, the app's team page and later the phone all read the same list.
- **The usage guard** reads the plan's weekly % (`usage.json`):
  - **60%:** workers drop to Sonnet with no Opus tasks, and Leads drop to Sonnet.
  - **70%:** projects ranked low (unstarred, or below the line in the rank list) pause. Their running turns finish; new agent work waits; the row says "paused: budget".
  - **80%:** all agent work stops. Only prompts Justin types himself still go, with a one-tap override that is logged.
  - **Lifting:** each step lifts by itself when the % falls (the weekly reset). Each project's row shows its spend today and this week.

**Migration:** project by project, mira first. A project switches to workers only while its chats are idle, and every teammate's job in flight finishes the old way. Nothing restarts mid-turn, so mira's Oct 28 work is never interrupted. Its teammates' duties are kept as its charters.

### As built (2026-10-22, 113027e, d7e615c)

- **Workers** (`server/workers.ts`): a project with `workers: true` treats its members as charters. A letter to one that starts a task (`dispatch` → `beginTask`) closes its process, drops its session ids, sets its gauge to empty and its model to the task's, and its first prompt carries a short `<ruri:task>` brief instead of the conversation (`handoff.ts` → `takeFreshBrief`). Charter, sheets and catch-up already ride in the system prompt. A follow-up while the task is open, an answer, a carried prompt and the user's own words all go on in the same session.
- **The task list** (`server/tasks.ts`, `~/.config/ruri/tasks/<project>.json`, newest 300 kept): a task is made when a letter reaches a worker with nothing open (`sendLetter` → `handOff`). A letter to a worker that already has a task open joins that task. It goes queued → working (its first prompt) → done, blocked (the report ends on a question or starts with BLOCKED:) or failed, with the report (6,000 characters at most) and the sum of its turns' costs. Read it with the leads' `tasks` tool, `{"do": "tasks"}`, `ruri tasks [id]`, or on the team page. A finished report reaches the lead with its next prompt, cut to 1,500 characters, and points to the list for the rest.
- **Models:** `sonnet` by default (`ruri-worker-model`), `opus` when the lead says `hard: true` (`ruri-hard-model`); effort stays `medium` (Q5). At most 2 at once per project (`ruri-worker-max`), counted in `hasSlot`; a job beyond that waits in the worker's line for a slot. Leads and liaisons of worker projects compact at 100k (`LEAD_COMPACT_AT`).
- **The usage guard** (`server/usageGuard.ts`): it reads the Claude weekly % from the usage gauges and ignores any reading older than 3 hours. Past 60%, `channelProject` steps every project chat's Opus or Fable down to Sonnet (Home is left alone), and live sessions switch between their turns. Past 70%, projects that are neither starred nor named in `ruri-guard-keep` pause. Past 80%, every project pauses. Pausing parks other agents' messages to that project's chats (`deliver`), and they go in again when the % falls. The user's own prompts always go. `ruri-usage-steps` moves the steps, `"ruri-usage-guard": "off"` turns it off, and each step is logged to `~/.config/ruri/guard.log`. The project rows show today's spend and "paused"; the Projects label shows the step.
- **The usage reading** had been blank for hours: ruri's quick retries kept the endpoint answering 429. Now ruri leaves it alone for 5 minutes after a 429, asks at most once a minute, and keeps the last good reading (`server/usage.ts`, `server/gauges.ts`).
- **The switch** (`migrateStep`, every 30 s): projects named in `ruri-workers-first` switch first (just `mira` by default), each only while it is quiet: no turn, line, slot wait or retry, and no message out to or from it. After that, every quiet project left switches. At the switch, the charters are written to `~/.config/ruri/charters/<project>.md`, the flag is set, and the idle sessions are let go so they read the new words. New projects start on workers. `"ruri-workers-migrate": "off"` stops the switch, and `workers: false` keeps a project on teammates.
- **Not built:** a one-tap override of the 80% stop in the window (the preference is the override for now), and counting messages that wait on the guard as work in the project hooks (so midna hears "idle" while a project is paused).

