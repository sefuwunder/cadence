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

The `email-imap` connector adds a fourth source: **GNOME Online Accounts**.
When no explicit host/user/pass is configured anywhere, it reads mail-enabled
accounts from goa-daemon over D-Bus (`src/goa.ts` — busctl, no D-Bus library).
Account selection: `goa_account` in the connector config (or
`CADENCE_GOA_ACCOUNT` env / `imap.json`) matching email or GOA id, else the
first account. OAuth2 accounts use SASL XOAUTH2, password accounts use LOGIN.
GOA credentials are fetched on demand per sync/thread search and never
persisted — only the selected account id is stored. `goaAvailable()` /
`listGoaMailAccounts()` never throw on an absent GOA; they report it.

**Sending (Assign from feed).** `src/connectors/email-smtp.ts` is a sender
library (not a sync connector — `index.ts` skips it): EHLO → STARTTLS (587) or
implicit TLS (465) → AUTH LOGIN / AUTH XOAUTH2 → MAIL FROM / RCPT TO / DATA →
QUIT, over an injectable `SmtpLineIO` (mock it in tests). Config resolution
mirrors IMAP: connector config → `CADENCE_SMTP_*` env
(`CADENCE_SMTP_HOST/PORT/USER/PASS/SECURE`, SECURE is `ssl`|`starttls`) →
`data/imap.json` `smtp_*` keys → GOA SMTP of the *same* selected account
(OAuth2 → XOAUTH2, password → AUTH LOGIN with the stored SMTP password,
falling back to the IMAP one). After a successful send the message is
APPENDed to the auto-detected Sent folder (see `appendToSent` in
email-imap.ts) so it appears in sent-mail and in later thread searches, the
recipients are upserted into `email_contacts` (most-recently-used first), and
a `task_links` row (`source: email-imap, kind: thread`, ref = normalized
subject) is created. Sending is always user-initiated from the task feed —
the Send button is the confirmation; nothing auto-sends anywhere.

## The four built-ins

| id | mode | notes |
|----|------|-------|
| `manual` | no-op | Metrics entered by hand; `sync()` returns `[]`. |
| `email-imap` | poll + thread search + **send** | Counts Sent-folder messages per day; also powers email-thread feed linking (`GET /api/connectors/email-imap/threads?q=…`, normalized-subject grouping) and Assign-from-feed sending (`POST /api/connectors/email-imap/send`). Config: host/port/user/pass via connector config, `CADENCE_IMAP_*` env, `data/imap.json` (gitignored), or GNOME Online Accounts (`goa_account` selection; OAuth2 → XOAUTH2, creds never stored). Read-only, except Sent-filing after a send. |
| `webhook` | inbound | External systems `POST /api/hooks/:key` with `{kpi_id, date, value, note}`. Keys live in its connector config: `{keys: {"<uuid>": {"label": "..."}}}`. `sync()` is a no-op. |
| `calendar-ical` | poll | Counts events per day from an iCal URL whose SUMMARY matches `query` (empty query = all events). Config: `url` (masked in the UI) via connector config, `CALENDAR_ICAL_URL` env, or `data/calendar.json` (gitignored); optional `query`/`CALENDAR_QUERY`. Minimal zero-dep VEVENT parse (UID, SUMMARY, DTSTART/DTEND as UTC/floating/all-day; ICS parser ported from docket's `src/ical.js`). **RRULE is not expanded in v1** — recurring events contribute only their base instance. Powers the Meeting pill in the task feed (`GET /api/connectors/calendar-ical/events?from=&to=[&q=]`). |

## Testing a new connector

Add cases to `tests/api.test.ts`:

1. `sync()` against a stub (never a live service in tests).
2. Config-missing error message is human-readable.
3. Returned rows validate: `date` matches `^\\d{4}-\\d{2}-\\d{2}$`, `value` is finite.

## Inbound thread sync (`email-imap`)

`syncThread({ link: { ref, label, meta }, config, fetchMessages? })` pulls replies into a linked thread: SUBJECT-searches INBOX + Sent (read-only `EXAMINE`), fetches headers + a body snippet, and diffs MESSAGE-IDs against `meta.seen_ids`. The first sync seeds `seen_ids` silently (old mail isn't "new"); later syncs accumulate `meta.unseen` and refresh `last_from`/`last_date`/`last_snippet`/`count`. Pass `fetchMessages` in tests to avoid the network; `createApp` accepts a `threadFetcher` override for the same reason. Routes: `POST /api/runs/:id/tasks/:taskId/sync-feed`, `POST /api/runs/:id/sync-feeds` (cap 20, most-recently-active first), `POST /api/runs/:id/tasks/:taskId/feed/read` (zeroes `unseen`).
