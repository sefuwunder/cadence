# Cadence as a 9P tree

Cadence served over 9P2000, for the executive desk: playbooks, runs,
steps, Today, KPIs, Activity, contacts, and the staging shelf where
run drafts wait for approval.

## Run

```
bun src/ninep-server.ts
```

Environment: `CADENCE_DATA_DIR` (default `<repo>/data`, where
`cadence.db` lives and `staging/` is created), `NINEP_PORT` (default
9040). Loopback only. The HTTP server is untouched; this is an
additional surface over the same database (writes use a busy timeout,
so both servers can run at once).

## Tree

```
templates/<id>/{name, description, weeks}
runs/<id>/{name, playbook, start_date, status,
           steps/<task>/{title, role, week, done, links/<link>/{kind, ref, label}}}
today
kpis/<id>/{name, unit, targets, entries/<entry>/{date, value, note}}
activity
contacts/<email>/{name, last_used}
staging/<draft>/{template, thread, contact, excerpt, created, status, result, approve, reject}
```

`today` is computed the same way the dashboard does: current week of
each active run, open tasks only. `activity` is the events table,
newest first. `playbook` on a run is the playbook id.

## Writes

- A step's `done` file takes `1` or `0` and updates the task row
  (`done_at` set or cleared). Anything else is an error.
- Staging is file-backed, not a database table. A draft is a
  directory of field files. Writing a playbook id — or empty, to use
  the draft's `template` file — to `approve` creates the run from
  that template, logs an event, and records `status=approved` plus
  the run id in `result`. Writing anything to `reject` marks it
  rejected. The draft directory stays as the audit record.
- Everything else is read-only.

## v1 limits

No authentication: run on loopback only. No `Twstat`. File writes
replace the whole value and must start at offset 0; there is no
append semantics. The 9P library itself lives in `src/ninep.ts` and
is vendored verbatim into relay, outpost, and translator — do not
fork it per app.
