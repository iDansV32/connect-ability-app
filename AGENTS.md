# Connect Ability — Codex Instructions

This file governs how Codex (cowork) behaves when managing SDR agents in this project.
It is read automatically at the start of every session.

---

## Browser Execution Mode — Always Headed

All browser-based actions must run in headed/visible mode. Never run LinkedIn or
other browser automation headlessly. When a script supports `--visible`, always
pass it. If a browser action cannot be run headed, stop and tell the user instead
of falling back to headless execution.

---

## Quick Commands — LinkedIn Profile Search & Engage

When the user asks to **find N profiles by title, like their content, and return a list**, execute
`scripts/search-screenshot-like.js` directly — no follow-up questions needed.

### How to run

```bash
LINKEDIN_EMAIL=you@example.com \
LINKEDIN_SEARCH_TERM="Head of People" \
PROFILE_COUNT=5 \
node scripts/search-screenshot-like.js
```

- `LINKEDIN_SEARCH_TERM` — the title/keyword to search (e.g. "Head of People", "VP Sales")
- `PROFILE_COUNT` — how many matching profiles to return (default 5)
- `TITLE_KEYWORDS` — comma-separated words the headline must contain to count as a match;
  defaults to `LINKEDIN_SEARCH_TERM`. Use this to add variants, e.g.
  `TITLE_KEYWORDS="head of people,people lead,people director"`
- `SCREENSHOT_DIR` — where to save screenshots (default `/tmp/connect-screenshots`)
- `MAX_SEARCH_PAGES` — how many LinkedIn search pages to scan (default 3)

The script:
1. Logs in via the stored session for the configured account
2. Runs the search and filters for People tab results
3. Visits each candidate — **skips profiles whose headline doesn't contain the title keyword**
4. Takes a viewport screenshot of each matching profile
5. Likes their latest post via `processActivityPageDetailed`
6. Emits a `--- RESULTS JSON ---` block at the end

### After the script finishes

1. Read each `screenshotPath` file with the Read tool to see the profile visually
2. Extract name, title, company, location from the screenshot (DOM selectors are currently broken)
3. Present results as a table: Name | Title | Company | Location | Like | LinkedIn URL

### LinkedIn account

The account is whichever LinkedIn account is configured in the app. To find it:

- Email / account ID: Settings -> LinkedIn accounts, or `list_linkedin_accounts` via MCP
- Session file: `~/Library/Application Support/Connect Ability/sessions/linkedin-storage-state-<email-slug>.json`
  (macOS; the app writes one session file per configured account)

---

## Quick Commands — Bulk Connect to a List of Profiles

When the user provides (or just got) a list of LinkedIn profile URLs and says
something like *"connect with these"*, *"send connection requests to all of them"*,
*"connect with the profiles above"*, etc., use `scripts/connect-profiles.js`.

The script visits each profile in one browser session, extracts the recipient's
name from the page, and calls the canonical `sendConnectionRequestDetailed` —
which has the safety gate that refuses to click without a matching aria-label
(prevents accidental clicks on right-rail "More profiles for you" Connect buttons).

### How to run (file-based, preferred for >2 URLs)

```bash
# 1. Write the URLs to a temp file (one per line; blank lines and # comments OK)
cat > /tmp/connect-batch.txt <<'EOF'
https://www.linkedin.com/in/jordan-avery-8f21c40/
https://www.linkedin.com/in/sam-okonkwo/
# Riley is BD not People — skip
# https://www.linkedin.com/in/riley-nakamura/
EOF

# 2. Run the script visibly, with ~25-75s random delay between profiles
node scripts/connect-profiles.js --visible --urls-file /tmp/connect-batch.txt
```

### How to run (stdin)

```bash
printf "https://www.linkedin.com/in/foo/\nhttps://www.linkedin.com/in/bar/\n" \
  | node scripts/connect-profiles.js --visible
```

### Optional flags

- `--note "..."` — connection invite note (max 300 chars)
- `--visible` — show the browser window; required for every run
- `--min-delay <sec>` / `--max-delay <sec>` — pacing between profiles (defaults 25 / 75)
- `--max-profiles <N>` — hard cap; useful for sampling first
- `--account <accountId>` — only needed if multiple accounts exist

### Output

Streams JSONL (one line per profile) plus a final summary line, e.g.:

```
{"index":1,"profileUrl":"...","recipientName":"Jordan Avery","outcomeType":"completed",...}
{"index":2,"profileUrl":"...","recipientName":"Sam Okonkwo","outcomeType":"completed",...}
{"summary":true,"attempted":2,"completed":2,"alreadyConnected":0,...}
```

`outcomeType` values to expect:
- `completed` — connection request sent ✓
- `skipped_already_connected` — already 1st-degree
- `skipped_invite_pending` — invite already outstanding
- `skipped_quota_exceeded` — daily connection quota hit (script respects per-account quotas)
- `skipped_name_missing` — name couldn't be read; safety gate refused (rare; check the URL)

### When NOT to run automatically

If the list contains profiles that obviously don't match the user's stated target
(e.g., the user asked for "Heads of People" but the list contains a Sales Director
or a BD person), flag those and ask before sending. Otherwise just run.

---

## MCP Server

The Connect Ability MCP server must be running before using any `connect-ability` tools.
Start it with: `npm run mcp:server`

The server exposes MCP tools for managing agents, workflows, prospects, groups, Apollo sync,
scheduled posts, analytics, notifications, account health, runtime logs, and daily activity reports.

---

## Rule 0 — Never Claim an Action Executed Unless a Run Was Queued

`save_workflow_template` only saves a template definition. It does **not** send any messages,
open any browsers, or queue any LinkedIn actions. Never tell the user a LinkedIn action was
performed or will be performed as a result of calling `save_workflow_template`.

To actually execute a LinkedIn action against a profile, use `run_linkedin_action`.
Only after calling `run_linkedin_action` (which returns `status: "queued"`) may you tell the user
that the action has been queued and will execute within ~15 seconds.

---

## Canonical Automation Path

`main.js:startDueDurableWorkflowJobs()` is the canonical automation entry point.
All new durable workflow execution work must go through:

`startDueDurableWorkflowJobs` → `executeDurableWorkflowJob`

The following files are legacy compatibility paths and must not receive new automation features:
- `automation.js`

---

## Offline Test Boundary

`npm test` must remain fully offline. Unit tests under `tests/` must not:
- call LinkedIn
- read `LINKEDIN_EMAIL` / `LINKEDIN_PASSWORD`
- launch Playwright browsers
- make outbound HTTP requests

Credentialed probes and any live LinkedIn validation belong in `tests-live/` and run only via `npm run test:live`.

---

## Rule 1 — Agent Persona Workflow

**Every time you create or update an SDR agent** (i.e., after calling `save_agent`):

1. Check the returned `personaStatus` field.
2. If `personaStatus.hasPersona` is `false` (new agent, no persona files yet):
   - Tell the user the agent was created successfully.
   - Then ask: *"[Agent name] is ready. Would you like to define their persona?
     I can help you craft their soul, personality, writing style, and boundaries —
     these become the guardrails for everything they say and how they say it."*
3. If the user says yes, guide them through each file **one at a time** in this order:
   `soul.md` → `personality.md` → `writing-style.md` → `boundaries.md`
4. For each file: ask the questions below, draft the file from their answers,
   show it to them, refine until approved, then call `write_agent_persona` to save it.
5. If `personaStatus.complete` is `false` on an existing agent (some files missing):
   - Mention which files are missing and offer to fill them in.

---

## Rule 2 — Always Read Persona Before Generating Content

Before generating **any agent-voiced text** — DM templates, connection notes, post content,
follow-up messages, reply suggestions — always:

1. Call `read_agent_persona` with the agent's ID.
2. Read and internalize all four files (or as many as exist).
3. Write content that matches the soul, personality, and writing style exactly.
4. Enforce every rule in `boundaries.md` without exception.
5. If no persona files exist, note this and ask if the user wants to define them before proceeding.

**Persona files override everything.** If the user's quick instruction conflicts with a
rule in `boundaries.md`, flag the conflict and ask how they want to resolve it.

---

## Rule 3 — Generating Posts

When asked to create scheduled posts for an agent:

1. Read the agent's persona files first (Rule 2).
2. Use `contentPillars` from the agent record as topic guidance.
3. Use `contentTone` from `agent.metadata` (e.g., `["professional", "funny", "witty"]`).
4. Apply the writing style from `writing-style.md` to every post.
5. Call `list_scheduled_posts` first to see existing posts, then call `save_scheduled_posts`
   with the merged list (existing + new) to avoid overwriting.
6. Distribute posts across requested dates, one per `scheduledDate`/`scheduledTime`.

---

## Rule 3b — Scheduling Posts via the CLI script

When the user asks to **schedule** a single post (one-off, with a specific date/time)
— including posts crafted via the `madison-crane-linkedin-voice` skill or any other
voice/persona skill — use `scripts/schedule-post.js` directly instead of the
`save_scheduled_posts` MCP tool.

### What the script does

By **default** the script launches Playwright, reuses the stored LinkedIn session
for the account, opens the LinkedIn feed composer, types the post content, picks
the date and time in LinkedIn's native scheduling UI, clicks Schedule, and then
persists the post locally with the returned LinkedIn resource key.

Always pass `--visible` so the LinkedIn scheduling browser runs headed. Do not
use the script's headless default. While it types, avoid closing the browser or
stealing focus, since that can interrupt the Playwright flow. Pass `--local-only`
only when the user explicitly asks to skip LinkedIn and write to the local store.

### Why not save_scheduled_posts MCP

- `save_scheduled_posts` requires the MCP server be started with
  `CONNECT_STDIO_PLATFORM_WRITES=1`, which is **not** the default for stdio MCP
  clients.
- The script auto-picks the LinkedIn account when only one exists; no prompt needed.
- It preserves all existing posts (this account + others) — no merge logic for Codex to manage.

### How to run

For **multi-line content** (LinkedIn posts almost always are), write the draft to a
file and use `--content-file`. Do not pass multi-line text through `--content "..."` —
literal `\n` escapes leak through and break the post.

```bash
# 1. Write the draft to a temp file (preserves blank lines and formatting)
cat > /tmp/post-draft.txt <<'EOF'
First beat.

Second beat after a blank line.

Closing question?
EOF

# 2. Schedule it
node scripts/schedule-post.js \
  --visible \
  --content-file /tmp/post-draft.txt \
  --date 2026-05-18 \
  --time 09:00
```

Optional flags:
- `--visibility public|connections|private` (default `public`)
- `--account <accountId>` — only needed if multiple LinkedIn accounts exist
- `--agent <agentId>` — optional metadata
- `--timezone <IANA tz>` — optional metadata

The script prints a JSON receipt with the new post's ID. The Connect Ability app's
scheduler picks up `status: pending` posts and publishes them at their scheduled time.

### Confirmation rule

- When the user's request explicitly says **"schedule"** (e.g., "draft a post and
  schedule it for Monday 9 AM"), run the script directly — no extra confirmation
  turn. The scheduling consent is in that same message.
- When the user only says **"draft"** or **"write"** a post, show the draft for
  review first and wait for an explicit "schedule it" before running the script.

### Date math

Compute the target date in the user's local timezone (or the timezone they specify).
For "next Monday at 9 AM" from today, use `date -v +1w -v +Mon +%Y-%m-%d` on macOS or
plain JS `new Date()` arithmetic — do not ask the user to confirm the date.

---

## Rule 4 — Workflow Campaigns

When setting up a LinkedIn outreach sequence:

1. Ask which agent this is for, then read their persona.
2. Use the DM template from the agent record as the base for `send_dm` steps,
   refined by `writing-style.md` and constrained by `boundaries.md`.
3. For prospect discovery (search + enqueue), suggest the agent's `personaTitles`
   and `searchKeywords` as the starting search query.
4. Default sequence unless otherwise specified:
   view_profile → delay 24h → view_profile → delay 24h → like_posts → delay 24h → send_dm

---

## Rule 5 — Apollo Sequence Sync

When the user asks to add prospects, workflows, or groups to Apollo:

1. Confirm Apollo is configured by calling `get_apollo_integration`.
2. If there is no API key, ask the user for it before proceeding and then call `configure_apollo_integration`.
3. Use `list_apollo_sequences` to identify the destination sequence unless the user gives a specific sequence ID.
4. Prefer `dryRun: true` first when the user is syncing a large workflow or group.
5. Use the narrowest tool that matches the user intent:
   - specific prospects or profiles → `sync_prospects_to_apollo_sequence`
   - one workflow → `sync_workflow_to_apollo_sequence`
   - one group → `sync_group_to_apollo_sequence`
6. After syncing, report back:
   - how many prospects were attempted
   - how many were enrolled
   - how many were skipped or failed
   - the main reasons for skips/failures
7. If the user wants this mapping to be reusable, save it with `save_apollo_binding`.

If the user needs Apollo-native data or actions outside the existing sync flow:

- use `list_apollo_api_capabilities` to see the supported Apollo public API categories
- use `search_apollo_contacts` to check whether someone already exists as an Apollo contact
- use `search_apollo_people` to run Apollo People API searches with prompt-friendly filters
- use the first-class Apollo tools for common objects before falling back to raw API calls:
  - accounts: `search_apollo_accounts`, `get_apollo_account`, `create_apollo_account`, `update_apollo_account`
  - deals: `search_apollo_deals`, `get_apollo_deal`, `create_apollo_deal`, `update_apollo_deal`, `list_apollo_deal_stages`
  - tasks: `search_apollo_tasks`, `create_apollo_task`, `bulk_create_apollo_tasks`
  - contacts admin: `list_apollo_contact_stages`, `update_apollo_contact_stages`, `update_apollo_contact_owners`, `bulk_create_apollo_contacts`, `bulk_update_apollo_contacts`
  - workspace metadata: `list_apollo_users`, `list_apollo_labels`, `list_apollo_fields`
  - calls: `create_apollo_call_record`, `search_apollo_calls`, `update_apollo_call_record`
  - sequence admin: `update_apollo_sequence_contact_status`, `activate_apollo_sequence`
- use `call_apollo_api` for other Apollo public REST endpoints under `/api/v1`

When using `call_apollo_api`:

1. Prefer dedicated MCP tools first when they already cover the request.
2. Keep the request tightly scoped to the single Apollo endpoint needed.
3. Pass only the minimum query/body fields needed for the task.
4. If the user asks for an Apollo UI feature that does not appear to have a public API endpoint, say that clearly rather than guessing.

---

## Persona File Questions

Use these when guiding the user through persona creation.

### soul.md questions

Ask the user:
- "Who is this agent at their core — what do they fundamentally believe about their niche?"
- "What's their mission for every person they reach out to, beyond making the sale?"
- "What makes their perspective unique? What do they see that others miss?"
- "If an ideal prospect described them in three words after a great conversation, what would those words be?"

Draft `soul.md` from their answers using the template below.

### personality.md questions

Ask the user:
- "How do they show up in a conversation? Pick the vibe: warm/measured, direct/empathetic, high-energy/calm authority, or describe it."
- "When — if ever — do they use humor? What kind? Dry wit? Self-deprecating? Warm jokes?"
- "What topics make them light up? What bores or irritates them?"
- "Do they lead with questions or statements? Do they share opinions freely or hold back?"

Draft `personality.md` from their answers using the template below.

### writing-style.md questions

Ask the user:
- "Short punchy sentences or longer narrative? Or a mix?"
- "Any words or phrases they reach for naturally? Any they'd never write? (e.g., 'synergy', 'leverage', 'circle back')"
- "How do they open a cold DM? How do they close — question, soft CTA, or just a statement?"
- "Emoji: yes / no / sparingly? Line breaks between every sentence or just paragraphs?"
- "Rate on a 1–10 scale: Formal↔Casual, Reserved↔Expressive, Serious↔Playful."

Draft `writing-style.md` from their answers using the template below.

### boundaries.md questions

Pre-fill the compliance rules from the template below, then ask:
- "Any topics that are completely off-limits for this agent?"
- "Any claims they will never make? (e.g., ROI guarantees, specific outcome promises)"
- "How should they respond to 'not interested'? To 'remove me'?"
- "Any industry-specific compliance rules we should add?"

Draft `boundaries.md` with your pre-fill + their additions using the template below.

---

## Persona File Templates

Use these as scaffolds. Fill in the placeholders from the user's answers.
Show the completed draft to the user before calling `write_agent_persona`.

### soul.md

```markdown
# Soul — {Agent Name}

## Identity
{Who is this agent? What do they fundamentally believe about their niche?}

## Values
- {Value 1}
- {Value 2}
- {Value 3}

## Mission
{What are they trying to accomplish for every person they connect with — beyond making the sale?}

## Unique perspective
{What do they see that others miss? What's their contrarian or distinctive take?}

## In three words
{How would an ideal prospect describe them after a great conversation?}
```

### personality.md

```markdown
# Personality — {Agent Name}

## Energy
{How do they show up? e.g., "Warm and measured — never rushed, never pushy."}

## Communication traits
- {Trait 1: e.g., "Leads with curiosity — asks before asserting."}
- {Trait 2}
- {Trait 3}

## Humor
{When and how they use it. e.g., "Dry wit, sparingly — only when the other person opens the door first."}

## What they love talking about
- {Topic 1}
- {Topic 2}

## What they find boring or avoid
- {Topic 1: e.g., "Industry jargon and buzzwords"}
- {Topic 2}
```

### writing-style.md

```markdown
# Writing Style — {Agent Name}

## Sentence structure
{e.g., "Short. Punchy. One idea per sentence. Occasional longer sentence for rhythm."}

## Vocabulary
**Reaches for:** {words/phrases they naturally use}
**Never writes:** {off-brand words — e.g., "synergy", "leverage", "circle back", "per my last email"}

## Message anatomy
**Opening:** {how they start a cold DM — e.g., "A specific observation about the prospect's work or title"}
**Body:** {how they build — e.g., "One concrete insight, one question"}
**Close:** {how they end — e.g., "Always ends with an open question, never a yes/no"}

## Formatting
- Emoji: {yes / no / sparingly — and which ones feel on-brand}
- Line breaks: {between every sentence / only between paragraphs / depends on length}
- Lists in DMs: {never / only for 3+ items / freely}

## Tone calibration (1 = left extreme, 10 = right extreme)
- Formal ↔ Casual: {X}/10
- Reserved ↔ Expressive: {X}/10
- Serious ↔ Playful: {X}/10
```

### boundaries.md

```markdown
# Boundaries — {Agent Name}

## Hard limits (never, under any circumstances)
- [ ] Never guarantee outcomes or make specific performance claims
- [ ] Never mention a prospect's personal life unless they raised it first
- [ ] Never send more than one follow-up message after "not interested"
- [ ] Never claim to be human if directly asked
- [ ] {Add agent-specific limits}

## Topics to avoid
- {Topic 1: e.g., "Competitor pricing or direct comparisons"}
- {Topic 2: e.g., "Controversial political or social topics"}
- {Topic 3}

## Compliance rules
- CAN-SPAM / GDPR: honor all opt-out requests immediately — no exceptions, no delays
- No deceptive subject lines or false urgency ("Act now!", "Last chance")
- No misleading claims about the sender's identity or relationship to the prospect
- {Add industry-specific rules}

## Escalation responses

| Prospect says | Agent does |
|--------------|-----------|
| "Not interested" | Acknowledge gracefully ("Totally understood — appreciate you letting me know"), thank them, do not follow up again |
| "Remove me" / "Unsubscribe" / "Stop messaging me" | Stop all outreach immediately. Log the request. No response needed. |
| "How did you get my info?" | Be transparent: explain LinkedIn / public profile / mutual connection. No evasion. |
| "Is this automated?" / "Are you a real person?" | Do not claim to be human. Acknowledge the outreach is assisted by automation. |
| {Add your own} | {Response} |
```

---

## Rule 5 — Activity Reports

When asked for stats, an activity report, or an end-of-day summary for an agent:

1. **Identify the agent** — ask if not specified (e.g. "Which agent — Johnny Bones?").
2. **Identify the period** — "today", "yesterday", a specific date, or a custom range. Default: today in the agent's timezone.
3. **Call `get_daily_report`** with the agent ID, date (YYYY-MM-DD), and timezone.
4. **Present the report** in this structure:
   - **Summary line**: "Johnny Bones — Mar 21: 50 profiles viewed · 5 DMs sent · 2 replies received · 3 connections"
   - **Profiles Viewed** (N): table with Name | Title | LinkedIn URL
   - **DMs Sent** (N): Name | LinkedIn URL | First line of message
   - **DMs Received / Replies** (N): Name | LinkedIn URL | Message text
   - **Posts Published** (N): preview of content
   - **Connections** (N requested, N accepted)
   - **Liked** (N profiles liked by us, N posts liked by others)
   - **Workflows** (N completed, N failed)
5. If the user asks for **all-time or multi-agent stats**, use `get_analytics` instead.
6. If the user asks for **raw events** or wants to filter by event type, use `list_activity_events`.
7. If the user asks to **schedule a daily report**, call `schedule_daily_report` with the agent ID, hour, minute, and timezone.

---

## Tool Reference

Key tools for agent management:

| Tool | When to use |
|------|------------|
| `save_agent` | Create or update an agent. Always check `personaStatus` in response. |
| `read_agent_persona` | Read all persona files before generating any content. |
| `write_agent_persona` | Save a drafted persona file after user approval. |
| `get_agent_persona_status` | Check which persona files exist and which are missing. |
| `list_scheduled_posts` | Read existing posts before saving new ones (avoid overwrite). |
| `save_scheduled_posts` | Replace full post list — always merge with existing. |
| `save_workflow_template` | Create the outreach sequence for a campaign. |
| `get_analytics` | Check campaign performance before reporting to user. |
| `list_notifications` | Check for unread DM replies. |
| `get_daily_report` | Generate structured daily activity report (profiles, DMs, posts, connections). |
| `list_activity_events` | Fetch raw events; filter by eventType, since/until, agentId. |
| `schedule_daily_report` | Create/update a cron schedule for automatic daily reports. |
| `list_report_schedules` | List all report schedules (filter by agentId). |
| `delete_report_schedule` | Remove a scheduled report by schedule ID. |
