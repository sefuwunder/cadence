# Cadence

A C-suite playbook execution tracker. Run 30-day execution playbooks (sales sprints,
product launches, operating cadences): weekly task checklists per role (CEO / CRO /
CTO / COO), KPI targets vs actuals, and an evidence feed — with actuals fed by an
extensible connector framework (manual entry, email, webhooks, …).

Bun + zero npm dependencies + SQLite. Binds `127.0.0.1` only. Mobile-first UI that
opens into a two-pane layout on tablet (≥900px).

## Run it

```bash
cd cadence
bun install   # no-op: zero dependencies, but keeps bun happy
bun start     # → http://127.0.0.1:3040
bun test      # 22 tests, all green
```

Data lives in `data/cadence.db` (created on first run). Override with `CADENCE_DATA_DIR`.

On first launch the seed template **"30-Day Sprint — $60k & 20 SQLs"** is installed.
Hit **+** in the top bar to start a run from it.

## Tabs

- **Today** — this week's tasks grouped by role, checkboxes; KPI glance for the week.
- **Playbook** — week selector (W1–W4), role swimlanes with completion counts.
- **KPIs** — cards with per-week target/actual bars, manual log, per-connector sync,
  and a Connectors section for setup.
- **Activity** — evidence feed: task completions + metric entries with source badges.

## Task evidence

Any source of truth can be mapped to an individual playbook task: tap the 🔗 on a
task row to open its evidence sheet — linked items (email threads, manual notes,
webhook records) with source badges, plus unlink buttons.

- **Email threads** — search your mail by subject/from/text; results are grouped
  into threads by normalized subject (Re:/Fwd:/[tags] stripped, case-insensitive —
  no JWZ). Linking a thread stores one row (`kind: thread`, ref = the normalized
  subject, meta carries from/date/message count). One row per thread, manual
  linking only (no auto-rules in v1).
- **Manual note** — free-text note linked as `source: manual, kind: note`.
- **Webhook** — any system can link evidence: `POST /api/hooks/:key`
  `{ "task_id", "kind", "ref", "label", "meta"? }`.

`task_links` table: `id, task_id, source, kind, ref, label, meta_json, created_at`.
`source` is the connector id (also the UI badge); `kind` is
`thread`/`message`/`note`/`record`; `ref` is the source's identifier.

## Connectors

A connector feeds KPI actuals from an outside system. Drop one file in
`src/connectors/` exporting:

```ts
export const connector = {
  id: "my-source",            // unique, lowercase-hyphen; becomes metric_entries.source
  name: "My Source",
  description: "One line for the UI.",
  async sync({ from, to, config }) {
    // from/to: "YYYY-MM-DD". config: stored JSON from connector_cfg (or {}).
    // Return ONE ROW PER DAY: [{ date: "YYYY-MM-DD", value: 12, note: "…" }]
    // Throw a human-readable Error on failure — it surfaces in the UI.
  },
};
```

Rules: **one row per calendar day** (Cadence sums rows into week buckets), never log
credentials, read-only by default (inbound webhooks are the exception), zero
dependencies, pure Bun/Node APIs. Full guide: `src/connectors/README.md`.

Built-ins:

| id | kind | config |
|----|------|--------|
| `manual` | no-op (manual entry is native) | none |
| `email-imap` | counts messages in the Sent folder per day via `INTERNALDATE` | env `CADENCE_IMAP_HOST/PORT/USER/PASS/FOLDER`, or `data/imap.json` (gitignored), or the in-app setup form |
| `webhook` | **inbound**: `POST /api/hooks/:key` `{kpi_id, date, value, note?}` | keys managed in the in-app connector setup; invalid key → 401 |

The IMAP client is read-only (`EXAMINE`, never `SELECT`), opens one TLS connection
per sync, and resolves the Sent folder by `LIST` name matching (`*sent*`, `*gesendet*`,
…), falling back to `INBOX` only if nothing matches.

## API

```
GET/POST            /api/playbooks            POST/PUT/DELETE /api/playbooks/:id
GET/POST            /api/runs                 POST/PUT/DELETE /api/runs/:id
GET                 /api/runs/:id             → dashboard payload (weeks, tasks by
                                              role/week, kpis w/ targets + weekly
                                              actuals, overall %, activity feed)
POST                /api/runs/:id/tasks/:taskId/toggle
POST                /api/runs/:id/tasks/:taskId/links  {source?, kind?, ref?, label, meta?} → 201
DELETE              /api/links/:linkId                → 204
                      (tasks in the dashboard payload carry links[])
GET                 /api/connectors/email-imap/threads?q=…[&folder=…]
                      → { threads: [{ thread_key, subject, from, date, count }] }
                      (400 when IMAP is unconfigured)
POST                /api/kpis/:kpiId/entries  {date, value, note?}   (source: manual)
DELETE              /api/kpis/:kpiId/entries/:entryId
GET/POST            /api/connectors           (list; save config)
GET                 /api/connectors/:id
POST                /api/connectors/:id/sync  {kpi_id, from, to}
POST                /api/hooks/:key           {kpi_id, date, value, note?}   (metric)
POST                /api/hooks/:key           {task_id, kind?, ref?, label, meta?}  (task link)
```

Weeks are UTC date ranges `[start + 7·(w-1), start + 7·w)`; the "current week" is
clamped to `1..N` so future/past runs still render.

## Project layout

```
src/server.ts            REST API + static serving (createApp({dbPath}) for tests)
src/db.ts                schema + seedIfEmpty
src/seed.ts              "30-Day Sprint — $60k & 20 SQLs" template
src/connectors/          auto-loaded connector modules + README.md
public/                  index.html · styles.css · app.js (vanilla, no build step)
tests/api.test.ts        bun test suite
data/                    sqlite db + imap.json (gitignored)
```
