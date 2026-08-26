# Pending request panel — known problems

**RESOLVED 2026-08-26** — every item below was root-caused against the live
service and verified fixed in the running UI. Root causes (details in git
history "Fix pending-request panel"):

1. **Disappears / chip-only / focus loss** — three stacked defects:
   - `refreshQueues` read `st.status` off `GET …/form/{id}/state`, but the
     engine wraps responses in a `{location, data}` envelope → every queue
     tick deleted every pending question-form.
   - The refresh applied arrays built from pre-await state snapshots, so a
     tick in flight when `form.created` landed erased the new request
     (show/hide within one frame). Apply-time union by id fixed it.
   - `/form/{id}/state` 404s transiently right after creation; treating that
     as "resolved" killed newborns. Now gated behind a 60s newborn grace.
2. **Reply dead** — two modes: the form had already been wiped by (1) so the
   lookup silently returned; and multiselect questions were answered with a
   STRING because the projection/reply keyed on a `multiple` boolean that no
   engine field carries — multiplicity is the FIELD TYPE (`multiselect`
   vs `string`). Wrong shape → 400 FormInvalidAnswerError.
3. **Answered elsewhere** — events (`form.replied`/`form.cancelled`) were
   already correct; masked by (1). Verified live after the fix.
4. **Round 2**: under load the GLOBAL form listing can omit a pending
   question-form indefinitely (measured 45s+ while the panel was on screen),
   so tabs that missed the SSE event never backfilled. refreshQueues now also
   polls per-session listings for mounted sessions and unions them by id.

Known follow-ups, deliberately not done here: idle tabs reconnect their SSE
every ~30s (watchdog) which multiplies across many open tabs — consider
backoff/jitter; and while a question pends on the focused session there is NO
free-text path (composer is replaced by design) — an optional "reply with a
message instead" escape hatch could soften that.

Contract facts captured by `scripts/uitest/probe-*.ts` (kept for regression):
listings lag reality on BOTH add and remove (state endpoint is authoritative);
multiselect replies take arrays of option values + custom strings; single
fields take exactly one string; Esc/cancel → 204 + `form.cancelled`.

---

Original report:

Short spec of how the question/permission popup **should** behave, and what
actually happens today. One section per problem, as reported during testing.

---

## 1. It disappears on its own

**Spec:** once a question or permission pops up, it stays on screen until I
answer it, reject it, or cancel it myself.

**Problem:** the panel shows for a few seconds and then goes away by itself,
even though nothing was answered and nothing was pressed.

## 2. The Reply button doesn't submit

**Spec:** picking option(s) (and/or typing a custom answer) and pressing
Reply sends the answer to the agent, closes the panel, and the agent
continues.

**Problem:** pressing Reply does nothing visible. The agent never receives
the answer, so the run stays blocked until the answer is given somewhere else
(e.g. the TUI).

## 3. The text field keeps losing focus

**Spec:** while typing a custom answer, focus stays in that text box no
matter what happens in the background.

**Problem:** every few seconds the text field loses focus mid-typing.

## 4. It only appears via the corner chip

**Spec:** if a session has a pending request, opening that session — from
the sidebar, from a link, or because it was already open — always shows the
panel. Arriving via the corner chip is just one of several ways in.

**Problem:** the panel only shows right after clicking the corner chip from
another session. Opening the same session from the sidebar shows nothing.
A session that was already open doesn't get the panel either.

## 5. Answering elsewhere doesn't close it here

**Spec:** once a question is answered anywhere (web UI, TUI, anywhere), the
panel closes in the web UI too — everywhere, in every open tab.

**Problem:** after answering in the TUI, the web UI keeps showing the
question as if it were still waiting.

## 6. Esc should dismiss it

**Spec:** pressing Esc rejects/cancels the pending request and closes the
panel.

**Problem:** reported as a requirement; not confirmed working yet.

---

## Required test coverage

Whatever fix lands, it must be verified against ALL of these question shapes,
not just one:

- **Choice questions** — option buttons; more than one option can be selected
  at the same time, and every chosen option must reach the agent.
- **Multiple questions in one popup** — two or more questions listed together;
  each can be answered independently; Reply only enables when every question
  has an answer.
- **Text (free-form) answers** — a text box instead of options; Reply sends
  what was typed.
- **Mixed** — one popup combining choices + text; both parts must reach the
  agent.
- Each shape above must also survive: leaving it open >30 seconds, switching
  sessions and coming back, and answering it from another surface while the
  web UI shows it.

---

## What works

- The small corner chip ("N waiting in other sessions") appears when another
  session needs input, and clicking it jumps to the right session.
- When the panel does show, options render as buttons and custom answers
  have a text box.
