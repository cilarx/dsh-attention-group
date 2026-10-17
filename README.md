# dsh-attention-group

**A multi-agent group chat for DSH that decides who is worth waking.**

A durable room for several DSH sessions — plus your own — where a message is written down
first, routed second, and only then allowed to wake anyone. An irrelevant message costs
**zero turns**.

---

## Why this is not another group chat

Every group chat spends its budget at delivery time: it wakes everyone, and each woken
member then discovers the message was not for them. That is N turns for one message nobody
needed.

This plugin moves the decision *before* the wake. Posting a message returns a routing plan

```
routing: SILENT — nobody matched, zero turns spent
```

or

```
routing: 1 recipient(s) — plan only, nothing woken
  room-admin	mention	not-woken (dry run)
```

Waking is a second, explicit step, and it needs **two** switches to agree (see
[Two switches](#waking-is-two-switches)).

Three consequences that are design rules here, not accidents:

- **Creating a room, adding members, reading history and posting never wake anybody.**
- **Clicking anything in the panel wakes nobody** — with one deliberate exception,
  「生成群史摘要」, which asks the room's manager to write a summary, and only while the room's
  「唤醒」 switch is on (see [Room-history summaries](#room-history-summaries-r9)). A person typing
  in their own panel is not an event; a person asking for a summary is.
- **Nothing calls another plugin.** Rooms, transcripts, conclusions and exports are plain
  files, so this works on a bare DSH and survives this plugin being uninstalled.

---

## Quick start

### What you need

- DSH **0.2.1-rc.2** (this is the version every interface here was last verified against; it was
  first built against 0.2.0-rc.2, re-verified on 0.2.1-rc.1, and re-checked on 0.2.1-rc.2).
- A profile to install into. The examples below use `--profile desktop`.

### Install

```bash
dsh plugin --profile desktop add github:cilarx/dsh-attention-group
```

That is the whole install. It was **verified end to end from a clean profile** on 2026-10-17:
the command exits 0, DSH initializes the profile, and the package lands with all seven
source files, its bundle patch and its `cordis.patch.yml`.

The bare-name form `dsh plugin --profile desktop add dsh-attention-group` does **not** resolve
yet, because there is no npm release. Use the `github:` form above.

Any of a directory path, a tarball, or a git URL works, because `dsh plugin` **is** package
management: it delegates to `pnpm` in the profile directory (run `dsh plugin --profile <name>`
with no subcommand and pnpm's own help comes back). What makes the package a *plugin* is that
`package.json` declares `dsh.bundle.patch`.

A fresh profile gets **both halves** of the contract written for it automatically — the
dependency *and* the bundle layer — which is what makes the plugin actually load rather than
merely be installed:

```json
{ "dependencies": { "dsh-attention-group": "github:cilarx/dsh-attention-group" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-attention-group"] } } }
```

### Offline / from a checkout

Installing by path works too, and a packed tarball is verified end to end:

```bash
npm pack --pack-destination /tmp
dsh plugin --profile some-fresh-name add /tmp/dsh-attention-group-0.1.0.tgz
# → dsh: initialized profile some-fresh-name at ~/.dsh/profiles/some-fresh-name
```

Afterwards the new profile's `package.json` contained **both** halves of the contract on its
own — the dependency *and* the bundle layer:

```json
{ "dependencies": { "dsh-attention-group": "file:...tgz" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-attention-group"] } } }
```

and importing the installed copy from inside that profile succeeded, resolving
`@deepseek-ai/dsh-tools` from the shared `~/.dsh/profiles/node_modules`. So **a brand-new
profile can load this plugin** — that is what "works on a bare DSH" means here.

**A `link:` dependency and a directory junction both fail** (`unverified` for your machine,
measured here on 2026-10-16). Node resolves imports from a module's *real* path, so a linked
copy outside the profile resolves `@deepseek-ai/dsh-tools` outside the profile too:

```
attention-group (dsh-attention-group): failed to import
ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-tools'
```

Installing a real copy inside the profile is what fixes it.

### Verify the install registered

Two places in `~/.dsh/profiles/<profile>/package.json` must name the package — a package
that is only in `dependencies` is installed but **is not a profile layer**, and nothing will
happen:

```json
{
  "dependencies": { "dsh-attention-group": "..." },
  "dsh": { "profile": { "bundles": [ "...", "dsh-attention-group" ] } }
}
```

### Restart DSH — this step is not optional

Host-side code (`src/index.js` and friends) is loaded once, at startup. Toggling the plugin
in the plugin panel does **not** re-import it; measured here, a newly added tool stayed
`unknown tool` across a toggle and appeared only after a restart. Install, then restart, then
look for the 「群聊」 entry in the sidebar.

### Development loop (source tree → live profile)

Because of the real-path rule above, editing this checkout edits nothing that DSH loads.
`tools/sync-plugin.ps1` copies the package into the profile and then *imports the copy* to
prove it still loads:

```powershell
pwsh -File tools/sync-plugin.ps1
```

### First 60 seconds

1. Sidebar → 「群聊」 → 「＋」 → name the room.
2. Settings → turn 「唤醒」 on only when you actually want group messages to be able to start
   turns.
3. Settings → add a member: **click the id box** and a list of this machine's sessions appears
   (title, workspace, last activity, most recent first) — click one and both the id and the
   `@` name are filled in. Pasting an id (`session-<uuid>` **or** a bare `<uuid>`) still works,
   and any stable id with kind `user` / `admin` / `bot` / `liaison` makes it a name in the room.
4. Ask the agent in that session to call `attention_group_list`, then `attention_send` with
   `wake` left off — you get the plan, and nobody is disturbed.

### Confirm the runtime is healthy

Call the `attention_probe` tool. It reports the data root, how many rooms exist, which live
agents are visible, which optional services this deployment offers, the last five wake-up
attempts with the path each one took, the status of the panel route (`registered`, or the
exact reason it is not), and whether the unread prompt line registered (`promptContext` — a
deployment with no prompt service loses that nudge, and this says so). A missing panel that
reads as "you have no rooms" is the failure this line exists to prevent.

---

## Core concepts

### Room

A room is a record in a JSON ledger plus one append-only JSONL transcript. It has an id
derived from its title (`插件工程协调-fpab`), a title, a charter, a member list, a routing
mode, one group-wide reasoning-effort knob, four sink settings, and a list of outgoing
liaisons.

### Member kinds

| kind | What it is | Can it be woken? |
|---|---|---|
| `session` | A DSH session, identified by its session id. | Yes — live or cold-resumed. |
| `user` | The human. The panel acts as this member. | No — recorded only. |
| `admin` | The room's built-in administrator. «总结今天»-style requests default to the first enabled `admin`. | No — recorded only, unless it is also a session id. |
| `bot` | Any non-session automated participant. | No — recorded only. |
| `liaison` | A reserved kind for an inter-room courier (see [Liaisons](#liaisons-r10)). | No — recorded only. |

**Both session-id shapes are real**: `session-<uuid>` and a bare `<uuid>`. Measured 2026-10-16
against the live runtime, `008bda70-4811-4349-a1a5-d6c6ff54d7d1` is a stored, resumable session
with a resolvable route — and most sessions on the machine this was developed on look like that.
An earlier version of this plugin required the `session-` prefix, which quietly made roughly
seventy real sessions unwakeable; the guard now accepts both.

Only ids that look like session ids are wakeable; the panel labels each row 「可唤醒」 or
「只记录」 so a member that can never be resumed is never offered a switch that does nothing.
Waking a session means: a live session gets a follow-up; a **stored** session is cold-resumed
with **its own** provider/model and **its own** member preset. The preset matters — resuming
without it silently swaps the session's toolset for the deployment default (measured, and the
reason the cold path reads the session's `agentPreset` projection first). Reasoning effort is
the room's to decide: the member's own `wakeEffort` wins, then the room's `defaultEffort`, and
only if neither is set does the session's own last-used effort survive.

### Charter

Free text on the room. It is carried into the message a woken member receives, and it is
prepended to transcript exports and quoted in digests. Empty by default.

### Attention routing

| Mode | Panel label | What it does |
|---|---|---|
| `rules` | 规则 | Rules only: an `@name` mention or a subscription keyword. **No match = nobody woken.** This is the default. |
| `classify` | 语义 | Rules first; whatever they could not decide comes back in the tool result as a `greyZone`, for the **caller** — the model that asked — to judge. The router never silently turns the grey zone into a broadcast, and never spends a model call of its own. |
| `broadcast` | 全体 | Rules, then fall back to waking every enabled member. The most expensive mode; the old group-chat behaviour. |

Reasons a member is chosen (`reason` in every routing plan): `mention` (named), `keyword`
(a subscription term matched — plain substring, case-insensitive, or `/regex/flags`),
`broadcast` (mode fallback, or an `@所有人` address), `summary` (a direct assignment from
`attention_summarize`, which bypasses relevance matching but still respects the wake switch).

A sender is never woken by its own message, and a member is woken at most once per message
even when several rules match.

### Addressing everyone: `@所有人`

A message can address the whole room with `@所有人` (`@全体成员`, `@全体`, `@all`,
`@everyone` work too). It is gated **twice**, and both gates belong to the room:

- **`允许 @所有人` (off by default).** With it off the phrase is ordinary text: the
  message is still posted, and the tool result tells the sender which gate refused it.
  A room where every member can wake everyone is a room nobody can afford.
- **Who may say it.** The human and the room's admins. A regular member's `@所有人`
  stays plain text even when the switch is on.

Even when it takes effect, waking still needs `wake=true` **and** the room's own wake
switch: `@所有人` decides *who the message addresses*, never whether anyone is woken.
The boundary rules are the same Unicode ones as member names, so `@所有人啊` and
`@allison` are not broadcasts.

### Waking is two switches

A wake-up happens only when **both** are true:

1. The call asked for it — `wake=true` on `attention_send` / `attention_summarize`, or
   `wake` on a liaison.
2. The target room has it enabled — 「唤醒」 in the panel (`wakeEnabled`), off by default.

A relayed message needs its link's `wake` **and** the target room's `wakeEnabled`. When it
does not happen, the result says which switch was missing rather than leaving you to guess.

Two operations are deliberately outside the wake system entirely: `attention_conclude` and
`attention_export` write files and record a message, and wake nobody — *sinking is not
speaking*.

The panel's 「生成群史摘要」 button is also not a routed message: it is a **direct request** to one
named member. It is the one click in the panel that can start a turn, and it still needs the
room's 「唤醒」 switch — with waking off it refuses and says so (see
[Room-history summaries](#room-history-summaries-r9)).

### Unread in the system prompt (R6)

Waking reaches a member that is **not** running. The other half of "offline members do not miss
messages" is the member that **is** running for some unrelated reason: three messages may be
waiting in a room it has no reason to look at. Turning on 「未读写进系统提示」 ("unread in the
system prompt") — `promptUnread`, **off by default** — publishes one line into that member's
system prompt on every step, whether or not this room is why it is running:

```
群聊未读：「插件工程协调」3 条。用 attention_history 读，attention_send 回复。
```

What keeps it cheap and honest:

- **Counts only, never text.** The message body stays in the room; the member decides whether the
  count is worth a call to `attention_history`.
- **At most three rooms**, so the line cannot grow with the number of rooms.
- A room the member has **never read** says 有未读 rather than inventing a number.
- **Silence when there is nothing to say.** No unread, no line — this plugin's whole claim is that
  it shuts up.
- It is published through the runtime-context channel (`systemPrompt.context()`), which the
  harness **re-projects after compaction**, so the nudge does not vanish when the conversation is
  summarised.
- The count is cached in memory for **5 seconds**, and the cache key carries the member's
  `lastReadAt`, so a step costs one map lookup — not a scan of a long room's JSONL. Reading the
  room invalidates the cache immediately.

It is a per-room switch because it is a per-step cost, paid in every step of every member of that
room.

### Room-history summaries (R9+)

Two things, and only one of them can cost a turn:

- **A reminder you may ignore.** 「群史摘要提醒」 ("room-history summary reminder"; `summaryEvery`:
  关 / 200 / 500 / 2000, default **500**). Once a room has that many messages that no summary
  covers, the panel shows one line:

  ```
  提醒：这个群已有 612 条消息没摘要（阈值 500 条）。要不要摘要由你决定 —— 插件不会自己压缩，也不会删任何历史。
  ```

  It wakes nobody, writes no file, changes no history and generates nothing. It is a nudge, not a
  policy.
- **A summary you ask for.** The panel's 「生成群史摘要」 button ("generate a room-history
  summary"). Generating one spends a model turn in someone else's session, so it happens **only
  when a person clicks** — never on a schedule, and never on its own.

What one click does:

1. The plugin packs the messages posted **since the last stored summary** into the request.
2. It wakes the room's manager — the member whose `kind` is `admin` — through **that member's own**
   provider and model, spending whoever installed this plugin's quota.
3. The manager writes the prose in its turn and calls `attention_record_summary`.
4. The room record gains a snapshot: the message number it covers (`upToSeq`), the time, who wrote
   it, and the text.

Delivery into another session is **one-way** — the plugin hands over a message and never sees the
answer — which is exactly why step 3 is a tool the member has to call itself.

**No message is deleted.** The transcript is the record; a summary is a *projection* of it that is
easier to read. A summarised room still has every original line, and `attention_history` still
reads them.

Because the flow is asynchronous, clicking does not produce a summary immediately. The panel
reports what it actually did — 「已请求，等待群管理写回」 ("requested, waiting for the room manager
to write back") — and the snapshot appears once the manager records it. The request also tells the
manager exactly how to hand the summary back (`groupId`, `text`, `upToSeq`), because a summary that
is never recorded is a summary lost.

Three things can stop a click, and each one is refused **by name** instead of silently doing
nothing: the room has no usable manager (a `kind=admin` member that is itself a DSH session), the
room's 「唤醒」 switch is off, or nothing has been posted since the last summary. A click can never
turn a silent room noisy by accident.

### Liaisons (R10)

A liaison is a **directed** link living on the sending room: "when something happens in this
room, carry it into that room". Modes: `conclusion` (default — only messages sunk as
conclusions), `keyword`, `mention`, `all` (a firehose, use deliberately).

Loops are the whole design problem, so a forwarded message carries the trail of rooms it has
passed through, and every guard is a pure function with a name:

- the target is already in the trail → refused,
- the message came from the target → refused,
- the trail reached the link's `maxHops` (default 3) → refused,
- a room cannot link to itself.

So A→B→A cannot happen, however the links are arranged. Refusals are always reported with
their reason.

---

## Tools

**14 tools** are registered by the host half.

| Tool | What it does | Key parameters |
|---|---|---|
| `attention_probe` | Runtime diagnosis: data root, room count, live agents, optional services, the last 5 wake-up attempts, and the panel route's status. | *(none)* |
| `attention_probe_session` | Whether one session can be woken: live or stored, its stored route, and what a wake-up would do. Read-only unless you ask for a real resume. | `sessionId` (required), `resume` (boolean, default false — **costs tokens**, it starts a real agent loop) |
| `attention_group_create` | Create a room. Written to disk immediately; nothing is woken; the creating session joins. | `title` (required), `charter`, `wakeEnabled` (default false) |
| `attention_group_list` | The rooms this session belongs to, each with this session's unread count and a preview of the newest message. Groups keep their own transcripts; nothing is pushed into your session. | *(none)* |
| `attention_group_join` | Add a member, or update an existing one. Refusal here is a permission answer, not a bug: the room's `joinPolicy` decides. | `groupId` (required), `memberId` (required), `memberName`, `kind`, `subscribe`, `wakeEffort` |
| `attention_send` | Post a message: append to the durable log, route, return the plan. Wakes nobody unless `wake=true` **and** the room has waking enabled. | `groupId` (required), `text` (required), `wake` (boolean, default false) |
| `attention_history` | Read a room's log oldest-first and mark the reading session caught up. | `groupId` (required), `limit` (default 20, clamped to 200) |
| `attention_conclude` | Sink one conclusion into the room's own Markdown file and append it to the room record. Never wakes anybody. | `groupId` (required), `text` (required), `author` |
| `attention_export` | Write a time range of a room's transcript to a Markdown file and report the real path. Never overwrites an existing file, never wakes anybody. | `groupId` (required), `since`, `until` (ISO-8601), `limit`, `path` |
| `attention_digest` | Summarise a range with **no model and no wake-up**: counts, who spoke how often, which conclusions were sunk, and the messages. The free half of summarising. | `groupId` (required), `range` (`today` / `24h` / `all`, default `all`), `since`, `until`, `limit` (default 50, capped at 180) |
| `attention_summarize` | Ask a member — by default the room's first enabled `kind=admin` — to write a summary. The ready-made digest travels **inside** the request, so the woken member answers in one turn. | `groupId` (required), `range` / `since` / `until`, `limit` (default 80), `memberId`, `wake` (default false) |
| `attention_record_summary` | Store a room-history summary snapshot in the room record: the message number it covers, when, who wrote it, and the text. The write-back half of 「生成群史摘要」 — delivery is one-way, so the manager has to hand its summary back itself. Deletes nothing and wakes nobody. | `groupId` (required), `text` (required — the summary itself), `upToSeq` (optional — the last message it covers; omitted means the newest) |
| `attention_link` | Manage the room's liaisons. Call with `to` omitted to list them. Directed, loop-proof, and records-only by default. | `groupId` (required), `to`, `mode` (`conclusion` default / `keyword` / `mention` / `all`), `keywords`, `wake`, `enabled`, `maxHops` (default 3), `remove` |
| `attention_effort` | Set the room's one effort knob, or one member's override — and, with `live: true`, change the LIVE sessions now. | `groupId` (required), `effort` (required: `off` / `low` / `high` / `max` / `""`), `memberId`, `live` (default false) |

`range: "today"` is **local** midnight to now, not UTC, because "today" is what a person
means. Explicit `since`/`until` always overrule `range`.

Every tool result is bounded: a tool result is replayed into every later request of the
session that asked for it, so projections are capped at **200 lines, 2000 characters per
line, and 60000 characters in total** — and they say so when they truncate (the newest
lines are kept). The durable logs themselves are never truncated — only what the model sees.

---

### The keyboard entrance: `/group`

You do not have to open the panel to talk to a room. Type `/group` in the composer:

```
/group list                rooms, with your unread count
/group say <room> <text>   speak as yourself — nothing is woken
/group today <room>        local tally of today's traffic (no model call)
```

A typed command **never starts a turn**: it writes the message and records its
mentions, and waking still needs the room's own switch. Wrong room names come back
as a list of the rooms that exist, not as a silent failure.

## Panel

A global 「群聊」 entry in the sidebar (id `attention-group`, order 40) opens the panel. The
browser half owns no state: it asks the host on open and every 5 seconds, so two windows
cannot disagree about a room.

**Room list (left column):** total rooms and messages, total unread, 「＋」 to create a room,
and one row per room with its unread badge, member/message counts, whether waking is on, and
the newest message's author and preview. **A failed read is reported as a failure** where the
list would be — it is never rendered as "you have no rooms".

**Chat tab:** the charter, the message stream (newest last, auto-scrolled, capped at the
newest 300 messages), a 「总结今天」 / 「最近24小时」 / 「全部」 digest bar that answers without
waking anybody (and a 「收起」 button), and a **multi-line** composer that speaks as 「用户」:
**Enter sends, Shift+Enter makes a newline** (an Enter that is merely committing a Chinese IME
candidate never sends), and typing `@` opens a completion list — every member name plus
「所有人」 (`↑`/`↓` to move, `Enter`/`Tab` to fill, `Esc` to dismiss, or just click a row).
The panel's own post never wakes anyone.

**Settings tab:** 「群名称」, 「唤醒」, 「推理强度（群统一）」 (a slider), 「路由模式」, 「自省」,
「未读写进系统提示」, 「群史摘要提醒」 (关 / 200 条 / 500 条 / 2000 条), 「群规」,
「拉人权限」, 「结论沉淀」 (switch, real conclusion-file path, counts, sink folder,
「导出这个群的记录」, 「同时写任务记忆」), 「沟通员（对外转发）」 (per-link mode, 「停用」/「启用」,
「改为只记录」/「改为叫醒」, 「移除」, and a target picker), 「成员」 (per-member 「休眠」/「启用」,
「移出」 with a confirm step, subscription terms, per-member effort), and 「这个群的记录在哪」.

**Add members by clicking, not by copying ids.** After 「＋ 拉人进群」, click the id box (or press
「选会话」) and the panel lists this machine's sessions with **title, workspace and last-activity
time**, most recently active first. All three are needed, because sessions genuinely share or
nearly share titles and the title alone cannot tell them apart. Clicking a row fills the session
id, and — unless you already typed a name — fills the `@` name from the session's title (a name
an existing member already answers to gets a suffix instead of a twin). Rows are tagged 「在线」
(running) and 「已在群里」 (already in this room). Pasting an id still works: the picker is an
extra path, never a replacement.

The list shows **at most 40 rows** (`MAX_CANDIDATES` in `src/sessions.js`). That is a *readability*
ceiling, not a cost one — the whole query is one session listing plus 40 zero-I/O cache reads — and
a list that scrolls past forty rows is worse than typing an id. When it applies, the panel says
「只显示最近 40 个（这个部署共有 N 个会话）」 instead of hiding the rest silently. The number is
documented in the code comment and in both READMEs.

> **Where the rows and titles come from: one shipped API call, not a hand-rolled cache read.**
> Both come from DSH's own `sessionController.list()` — the call the sidebar uses. It returns each
> session's `updatedAt`, `running`, `cwd` and its **already-resolved cached title**
> (`projections.values.title`) in one pass. That is not laziness: calling
> `sessionProjectionCache.cachedSnapshot(...)` directly means hard-coding that method's EXACT
> signature, and it differs between DSH versions — `cachedSnapshot(meta, keys?)` in the running
> 0.2.1-rc.2, but `cachedSnapshot(meta, inheritedEventCount, keys?)` in the older 0.1.5-rc.1 tree
> that still sits in `~/.dsh/profiles/node_modules`. Guessing the slots wrong does not fail
> politely: it throws, **every title disappears, and every test stays green** — which is exactly
> how this feature broke on a real machine on 2026-10-17. Delegating to the shipped list call puts
> that signature with the code that owns it, so the picker does not have to track DSH versions. A
> session with no cached title shows 「（无标题会话）」, and the panel says how many such rows there
> are — it never puts an id where a title belongs.
>
> **Why not fold the title out of the session log:** doing that (`readTitleSnapshots`) means
> decompressing and replaying tens of megabytes per click on this machine (the 40 newest logs total
> 67 MB; one is 11 MB), stalling the whole GUI behind a single click.

**The one click that can start a turn** is 「生成群史摘要」 (a direct request to the room's manager,
never a scheduled job, and only while the room's 「唤醒」 switch is on). It reports what it actually
did — 「已请求，等待群管理写回」 ("requested, waiting for the room manager to write back") — because
the summary is written later, in the manager's own turn, and comes home through
`attention_record_summary`. The reminder setting generates nothing; it only counts.

**Opening a room joins the human and marks it read.** The panel POSTs
`{"action":"read"}` on open; the host adds the `user` member if needed and stamps
`lastReadAt`. Speaking also advances your own read mark, so your badge does not grow every
time you talk.

---

## Configuration

Every knob is per room, stored in `groups.json`, and settable from the panel or from a tool.

| Setting | Default | Values | Meaning |
|---|---|---|---|
| `title` | — (required) | any text | Display name. Renaming does not change the room id or its history. |
| `charter` | `''` (empty) | any text | Shown to every member when it is woken. |
| `routeMode` | `rules` | `rules` / `classify` / `broadcast` | How much work goes into deciding who is relevant. |
| `wakeEnabled` | `false` | `true` / `false` | The room's wake-up master switch. Off means routing is still computed and reported, but no turn is ever started. |
| `selfReflect` | `true` | `true` / `false` | Tells a woken member to decide cheaply whether it needs to speak, and to answer with one line if not. |
| `promptUnread` | `false` | `true` / `false` | Publish a one-line unread notice into every member's system prompt (counts only, at most three rooms, cached for 5 s so a step costs one lookup). Off by default because it is a per-step cost. |
| `summaryEvery` | `500` | `0` (off) / `200` / `500` / `2000` | How many messages without a summary it takes before the panel starts reminding you. A reminder only: it wakes nobody, writes nothing, and generates nothing. |
| `joinPolicy` | `members` | `open` / `members` / `user` / `nobody` | Who may add members. The human id always passes — a person who locks themselves out of their own room has been failed by design. |
| `defaultEffort` | `''` | `''` / `off` / `low` / `high` / `max` | The room's **one** reasoning-effort knob (R4b). `''` means the room has no opinion and the woken session's own route wins. |
| `liveEffort` | `false` | `true` / `false` | Whether this room may also change the effort of sessions that are **alive right now**. Off by default: the call behind it also saves the selection as the deployment default model. Needs a deployment with `sessionController`; `attention_probe` reports `liveEffortControl`. |
| `sinkEnabled` | `true` | `true` / `false` | Whether conclusions may be sunk into a file. |
| `sinkDir` | `''` | any path | Where this room's files land. `''` = the plugin's own `sink/` folder; a relative path resolves against the data root, an absolute one is honoured as given. |
| `sinkMemory` | `false` | `true` / `false` | When on, a conclusion's output also *asks the calling agent* to record it in task memory, if that deployment has such a tool. Nothing is called by name. |
| member `name` | first 12 chars of the id | any text | The name `@mentions` use. |
| member `kind` | `session` | `session` / `user` / `admin` / `bot` / `liaison` | What this member is. |
| member `subscribe` | `[]` | list of terms | Wake this member when the text contains any term. Plain text or `/regex/flags`. |
| member `wakeEffort` | *(unset)* | `off` / `low` / `high` / `max` | This member's own override; unset means "use the room's `defaultEffort`". |
| member `enabled` | `true` | `true` / `false` | Off = a sleeping member: not woken, and not counted. |
| link `to` | — (required) | a room id | The room messages are carried into. |
| link `mode` | `conclusion` | `conclusion` / `keyword` / `mention` / `all` | What this liaison is willing to carry. |
| link `keywords` | `[]` | list of terms or names | Keywords for `keyword`, watched names for `mention`. |
| link `wake` | `false` | `true` / `false` | Also wake the routed members *inside* the target room. The target room's wake switch must also be on. |
| link `enabled` | `true` | `true` / `false` | Switch a liaison off without deleting it. |
| link `maxHops` | `3` | positive integer | How many rooms a message may pass through before links stop carrying it. |

---

## Where the data lives

Everything is under `$DSH_HOME/attention-group/` (on a normal install, `~/.dsh/attention-group/`):

```
groups.json                        the room ledger: rooms, members, charters, knobs, links
messages/<groupId>.jsonl           one append-only transcript per room, one JSON record per line
messages/deliveries.jsonl          the wake-up audit: every attempt, the path it took, and why
sink/                              default sink folder
sink/<groupId>.conclusions.md      the room's conclusions, appended, one list item each
sink/<groupId>-<timestamp>.md      transcript exports (never overwriting an existing file)
```

Details that matter:

- The ledger is replaced atomically (write temp, then rename), so a crash cannot leave a
  half-written room list. A **corrupt** ledger is renamed aside as `groups.json.corrupt-<ts>`
  and reported, never silently discarded.
- The transcript is appended with the file closed again after each write.
- The wake-up audit is the third witness: a delivery that reports success while the target's
  log stays empty is the hardest failure to diagnose, so every attempt is recorded with its
  path (`live-followup`, `cold-resume`, `skipped`, `non-session`, `dry-run`) and note.
- A torn final JSONL line is skipped instead of making the whole history unreadable.
- A summary snapshot lives on the room record (`summaries`: `upToSeq`, `at`, `by`, `text`) and is
  written with the same atomic ledger replace as every other room field. Losing one costs a
  re-summary; it never puts a message at risk.

### "Group records never enter anyone's session"

Strictly: **a room's transcript is not part of any session's context.** Messages are appended
to the room's own JSONL, routing is computed from the ledger, and simply posting, reading the
list, or clicking in the panel adds nothing to anyone's conversation. A session sees room
content only when it asks (`attention_history`, `attention_digest`, `attention_group_list`'s
one-line preview), when a wake-up was deliberately delivered to it, or when someone deliberately
asked it for a summary. Nothing arrives because the room exists.

### Why a long room does not blow up the token budget

"Will a new agent be crushed by a year of chat history?" No, and not by luck:

- **History never enters anyone's context on its own.** A new member writes one member record; not
  a single historical message is sent to it. History is read only when asked for, through
  `attention_history` — and that projection is bounded to 200 lines and 2000 characters per line,
  and says how many older lines it left out. The transcript file itself is not touched.
- **A wake-up carries the trigger, not the room.** A woken member receives the one message that
  matched, the charter (at most 2000 characters) and the self-reflection instruction.
- **Storage grows; context does not.** Transcripts are append-only JSONL that the plugin never
  rewrites, and a line is a few hundred bytes (measured 224–494 bytes on real data). Ten thousand
  messages is roughly 2–5 MB on disk — and still zero tokens until someone asks.

The same reasoning is why the unread line publishes counts instead of text, and why a summary is a
projection the room keeps rather than a replacement for its history.

---

## Known limitations

Written down because they are true, not because they are small:

- **DSH version.** Everything here was most recently verified on **DSH 0.2.1-rc.2** (and before that
  re-checked after the 0.2.0-rc.2 → 0.2.1-rc.1 upgrade): every service this plugin reads is still present and
  the session format is still v4. That check was done by reading the running runtime, not by
  assuming — `agents.resume` still takes `{resumeSessionId, agentOptions, setup}`, the message
  `source.kind` rule still accepts any producer-owned kind except the retired `"plugin"`, and the
  tool registry still compiles the inline `required: true` parameter dialect into a standard JSON
  Schema (confirmed through the runtime's own tool-inspection provider). The interface shape is
  only claimed for 0.2.x; a minor DSH release can still move a service it reads.
- **Host-side changes need a restart.** A restart is required after installing or changing
  host code; a plugin-panel toggle does not re-import the module (measured: a new tool stayed
  `unknown tool`). The browser half is served as a **disk snapshot** — its changes need a
  page reload, and a reload can arrive before the host process is restarted, which is why the
  panel degrades gracefully instead of failing.
- **Reasoning effort reaches a live session only if you ask, and only on web-app deployments.**
  A session that is **stored** gets the room's effort for free when it is woken. A session that
  is **live** can also be changed in place — `sessionController.selectModel` exists and does
  work — but it is behind a per-room switch, `liveEffort`, which is **off by default**, because
  that same call also saves the selection as the deployment default model. It takes effect from
  the session's **next step**, not on a request already in flight. And `sessionController` is
  mounted by `@deepseek-ai/dsh-web-app`: a headless deployment does not have it, in which case
  the panel says so rather than pretending the switch works.
  (`unverified`: the call is verified in the sources and covered by tests against a stand-in
  service; it has not yet been exercised against a real live session on this machine.)
- **Cross-workspace waking is implemented but not machine-verified.** Membership takes any
  session id, and a stored session is cold-resumed with its own route and preset — verified
  end to end **for a session in this workspace**. Waking a session that belongs to a
  *different* workspace is not yet verified on a real target (`unverified`); it needs one
  clean target session. If it fails, it fails visibly: `attention_probe_session` reports
  `wouldDo`, and the audit records the path and the reason.
- **A deployment without session persistence loses the cold path.** If `sessionQuery` is
  absent, a stored session's route cannot be read and the wake-up is refused with
  `no route could be resolved` instead of silently doing nothing. Whether a bare-minimum
  profile still loads every other capability is `unverified`; the optional services are
  probed with `ctx.get()`, never declared as hard dependencies, so a missing one can only
  cost its own feature.
- **A summary exists only once the manager writes it back.** Delivery into another session is
  one-way, so the plugin cannot collect the answer itself. If the manager never calls
  `attention_record_summary` — or the click was refused, for any of the three reasons above —
  nothing is stored and the reminder keeps counting. That is the honest outcome, and why the
  panel reports what it did instead of promising a summary.
- **DSB integration is deliberately shelved.** DSB is still changing in destructive ways, so
  no DSB support is implemented; the `liaison` member kind exists as the reserved place for
  it. Nothing else about DSB is claimed.
- **The panel's rendering is only asserted structurally.** Panel tests run the real browser
  bundle against a React stand-in, so which controls exist and what each click sends is
  asserted — pixels, layout and CSS are not, and the panel is not a screenshot-verified UI.

---

## Development

```powershell
pwsh -File tools/run-tests.ps1
```

This runs the whole suite and prints one summary line. **It syncs first**, because the tests
load the *installed profile copy* rather than this source tree — so run it after editing the
source and you are testing what you just wrote. `-NoSync` skips the copy step.

**No DSH installed yet? It still works.** A fresh clone has no profile, so the tests fall back
to this source tree and `node_modules/@deepseek-ai/dsh-tools` — a two-file development shim that
is committed for exactly that reason (`test/support/entry.mjs` decides which copy is
authoritative, and `.gitignore` re-includes that one directory). The script says which copy it
used instead of leaving you to guess:

```
note: no profile at ~/.dsh/profiles/desktop - skipping the sync and testing this source tree
```

Current state: **226/226 passing across the 11 suites** the script lists, both against the
installed copy and against a source tree with no DSH at all (measured on this machine on
2026-10-17, about 7 seconds).

### How this was tested

Most of it was written before an adversarial audit, and that audit earned its keep. Three
independent readers were pointed at the plugin — one hunting crashes with about a thousand
hostile argument sets, one hunting silent wrongness (export races, loop guards, timezone
edges), one hunting panel dishonesty — and they found **31 real problems**, including one in
a test of mine that had enshrined a bug as a contract.

The most expensive one is worth repeating here because it is invisible from the outside:
`@mention` boundaries used `\w`, which is `[A-Za-z0-9_]` and contains no CJK character. A room
holding both `小明` and `小明明` woke **both** from a message naming one of them — measured with
two live sessions. Waking the wrong agent is precisely the cost this plugin exists to remove.
Boundaries are now Unicode property escapes, and the regression test asserts the routed
consequence, not just the regex.

### Smoke test against your own data

```bash
node tools/smoke-real-data.mjs
```

Unit tests build their own fixtures, so they prove the code works on data the tests invented.
This one proves it works on the data **you** have: it copies `$DSH_HOME/attention-group` to a
throwaway directory, points the plugin at the copy, and walks every tool once — routing, a
conclusion, a digest, an export, a liaison, a loop refusal, a summary request, the effort knob,
the history read, a session probe.

**Your real ledger is read-only.** The script hashes it before and after and fails if a single
byte changed, and it prints that check as its last line:

```
40 passed, 0 failed
YOUR DATA IS UNTOUCHED (…\attention-group hash 08c718998427…)
```

Flags: `--empty` starts from an empty ledger instead, `--keep` leaves the temp copy for
inspection. It needs no running DSH — which also makes it the check to run after editing
host-side code, since those changes cannot be exercised through the live runtime until DSH
restarts.

### Check the invite list against your real data

```bash
node tools/check-picker-real-data.mjs
```

It reads only your real files (`~/.dsh/sessions/`, `~/.dsh/storages/session_projcache/`,
`~/.dsh/storages/workspace.json`), reproduces the two DSH services the way their shipped source
behaves, runs the plugin's own `listSessionCandidates()` over them, and then checks every row:
each title must match the projection cache **byte for byte**, no row may invent one, and every
activity time must come from a real log. No DSH running, no restart.

Why it exists as a separate tool: a unit test can only prove the code matches the contract the
test believes. On 2026-10-17 this feature failed twice on the real machine, with every test green
both times: first when the code called the projection cache with the signature from the STALE
0.1.5 copy in `~/.dsh/profiles/node_modules` (every unseeded session threw, so every title
vanished), then again when the "fix" was built against that same stale copy while the deployed
0.2.1 has a different signature — and the doubles had been written to match the code's belief
rather than the runtime. The version discipline this script bakes in: **read contracts from the
DSH that is actually running** (`app.asar`, or the runtime's Inspect providers), never from the
stale profile copy.

The suites are layered on purpose:

| Suite | What it proves |
|---|---|
| `test/router.test.js` | Routing: who is worth waking, and that a plain message wakes nobody. |
| `test/tools.test.js` | Tool contracts: schema-valid output, and `render` returning typed content blocks only. |
| `test/panel-host.test.js` | The real web route: read model, every action, disk round-trips, permission refusals, the invite picker. |
| `test/panel-client.test.js` | The real `client.js` on a React stand-in: which control exists, what each click sends. |
| `test/sessions.test.js` | Invite candidates: real titles/workspaces/activity times, and that no session log is read. |
| `test/sink.test.js` | Conclusions on disk: append-only, never overwriting an export, the memory sentence's two branches. |
| `test/digest.test.js` | Ranges (including the local-midnight boundary), bounding, and the one-turn summary hand-off. |
| `test/relay.test.js` | Liaisons: A→B→A is refused, `maxHops` bounds a chain, nothing is woken by default. |

Node's `fs` is used directly rather than a storage service, so the plugin has **zero runtime
dependencies** beyond the DSH packages it declares as optional peers. There is no build step:
`exports` points straight at the source.

---

## License

MIT. See [LICENSE](./LICENSE).
