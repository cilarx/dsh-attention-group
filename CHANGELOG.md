# Changelog

All notable changes to `dsh-attention-group`. Versions follow `package.json`; dates are the
commit dates.

## 0.1.4 — 2026-10-22

**Cheap catch-up: the summary now actually shrinks what a member has to read.**

- `attention_history` gains `compact: true`: return the latest summary plus ONLY the messages
  after it, and say how far the summary reaches. Full mode is unchanged.
- The wake-up message carries the latest summary (≤1200 chars) before the triggering message,
  so a woken member does not need to pull history at all. New per-room switch `wakeSummary`
  (default ON).
- The panel shows the stored summary text (settings → 群史摘要), and adds the
  「唤醒时附上摘要」 switch.

## 0.1.3 — 2026-10-21

- **Direct summary without a 群管理**: the panel button asks the deployment's own model service
  (`ctx.llm` + `agentDefaultModel`) for one completion and stores the result. No session is woken,
  no API key is shipped by the plugin (the adapter holds the credentials).
- **Transcript-size dashboard**: read model reports `stats {messages, chars, estTokens}` per room
  and `estTokens` per list row; the panel labels every number 「估算」 (heuristic, not a bill).

## 0.1.2 — 2026-10-20

- A room can be given a **群管理** from the panel (new host action `memberKind`). Promoting a
  non-session id is refused: a summary is written by that session's own model and recorded with
  its own tool call.
- An unknown panel action is refused instead of falling through to "post a message as the human".
- Member kinds render in Chinese; the summary refusal now names where to click.

## 0.1.1 — 2026-10-19

- The speaker is a blue label at the base font size instead of a small grey one.
- The room list folds to a 26px strip so the transcript gets the width.
- Scrolling back through history is no longer undone by the 5s poll; unseen arrivals blink a
  「jump to latest」 circle instead of moving the view.

## 0.1.0 — 2026-10-18

First public release.

- Durable JSONL message log, attention routing (mention / broadcast / keyword / rules), durable
  unread counts, cross-workspace membership, conclusions sunk to Markdown, digest/summary tools,
  directed liaison links with loop protection, a panel for rooms/members/switches, and 14 tools.
