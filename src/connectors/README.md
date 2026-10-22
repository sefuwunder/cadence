# Cadence connectors

Connectors feed metric actuals into KPIs from outside systems (email, CRMs,
APIs). They are auto-loaded: **a future connector is one new file** in this
directory exporting a `connector` object. No registry edits, no restarts beyond
the server reload.

## Interface

```ts
// src/connectors/my-source.ts
export const connector = {
  id: "my-source",          // unique; stored as metric_entries.source
  name: "My Source",        // display name in the UI
  description: "One line on what it measures.",

  async sync({ from, to, config }: {
    from: string;           // "YYYY-MM-DD", inclusive
    to: string;             // "YYYY-MM-DD", inclusive
    config: any;            // saved config for this connector (connector_cfg)
  }): Promise<Array<{ date: string; value: number; note?: string }>> {
    // ... fetch, aggregate, return one row per day ...
    return [{ date: "2026-10-22", value: 12, note: "12 outreach emails" }];
  },
};
```

Rules:

- **Return one row per calendar day** (`YYYY-MM-DD`). The server sums rows
  into KPI weeks. Aggregate server-side when the source is chatty.
- **Throw plain `Error`s with human messages** on failure (bad creds,
  unreachable host). The sync endpoint surfaces them as 502s; the UI shows
  the message.
- **Never log credentials.** Config may hold secrets — treat `config` as
  opaque, never `console.log` it.
- **Keep it dependency-free.** Bun + stdlib only (`Bun.connect`, `fetch`,
  `fs`, `crypto`). No npm packages.
- **Read-only by default.** Prefer read-only access modes (IMAP EXAMINE,
  GET endpoints). If a connector must write to the source system, say so in
  its `description`.
- Filenames don't matter; `id` does. `index.ts` is the loader, not a connector.

## Config

Per-connector config lives in the `connector_cfg` table (edited in the UI via
`POST /api/connectors/:id`). Convention for secrets: connector config first,
then `CADENCE_<ID>_*` env vars, then a gitignored JSON file under
`$CADENCE_DATA_DIR/`. Document the fields in your connector's `description`
or a comment block.

## The three built-ins

| id | mode | notes |
|----|------|-------|
| `manual` | no-op | Metrics entered by hand; `sync()` returns `[]`. |
| `email-imap` | poll + thread search | Counts Sent-folder messages per day; also powers email-thread evidence linking (`GET /api/connectors/email-imap/threads?q=…`, normalized-subject grouping). Config: host/port/user/pass via connector config, `CADENCE_IMAP_*` env, or `data/imap.json` (gitignored). Read-only. |
| `webhook` | inbound | External systems `POST /api/hooks/:key` with `{kpi_id, date, value, note}`. Keys live in its connector config: `{keys: {"<uuid>": {"label": "..."}}}`. `sync()` is a no-op. |

## Testing a new connector

Add cases to `tests/api.test.ts`:

1. `sync()` against a stub (never a live service in tests).
2. Config-missing error message is human-readable.
3. Returned rows validate: `date` matches `^\d{4}-\d{2}-\d{2}$`, `value` is finite.
