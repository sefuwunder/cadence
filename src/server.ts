// Cadence — C-suite playbook execution tracker.
// Bun + zero deps + SQLite. Binds 127.0.0.1:3040.

import { Database } from "bun:sqlite";
import { join, extname, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync, existsSync, mkdirSync } from "fs";
import { initDb, seedIfEmpty } from "./db.ts";
import { getConnector, connectors } from "./connectors/index.ts";
import { keyIsValid } from "./connectors/webhook.ts";
import { searchThreads, appendToSent, normalizeSubject, syncThread, getThreadMessages, type ThreadMessage } from "./connectors/email-imap.ts";
import { sendWithConfig, type SmtpLineIO } from "./connectors/email-smtp.ts";
import { resolveCalConfig, parseIcs, fetchIcs, filterEvents } from "./connectors/calendar-ical.ts";
import { listGoaMailAccounts } from "./goa.ts";
import { askIlliad } from "./illiad/ask.ts";
import { nudgeList } from "./illiad/nudges.ts";
import { programToday } from "./illiad/today.ts";
import { getContactPhoto, syncPhotosFromEDS, saveManualPhoto, deleteContactPhoto } from "./contacts.ts";
import { listSendAccounts, resolveSmtpForAccount, imapConfigForAccount, readImapConfig, writeImapConfig, ownEmails } from "./mail-accounts.ts";

const appRoot = dirname(fileURLToPath(import.meta.url)); // src/
const publicDir = join(appRoot, "..", "public");

const uuid = () => crypto.randomUUID();
const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const err = (status: number, message: string) => json({ error: message }, status);

async function body(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

// ---------- week math (UTC, ISO dates) ----------
function weekRange(startDate: string, week: number): { from: string; to: string } {
  const s = new Date(startDate + "T00:00:00Z").getTime();
  const from = new Date(s + (week - 1) * 7 * 864e5).toISOString().slice(0, 10);
  const to = new Date(s + week * 7 * 864e5).toISOString().slice(0, 10);
  return { from, to }; // [from, to)
}

function currentWeek(startDate: string, weekCount: number): number {
  const days = Math.floor((Date.now() - new Date(startDate + "T00:00:00Z").getTime()) / 864e5);
  return Math.min(weekCount, Math.max(1, Math.floor(days / 7) + 1));
}

// ---------- run instantiation ----------
function instantiateRun(db: Database, playbookId: string, name: string, startDate: string): string {
  const pb: any = db.query("SELECT * FROM playbooks WHERE id = ?").get(playbookId);
  if (!pb) throw new Error("playbook not found");
  const tpl = JSON.parse(pb.weeks_json);
  const runId = uuid();
  db.run("INSERT INTO runs (id, playbook_id, name, start_date, status) VALUES (?, ?, ?, ?, 'active')",
    [runId, playbookId, name, startDate]);
  const insTask = db.prepare(
    "INSERT INTO tasks (id, run_id, week, role, title, done) VALUES (?, ?, ?, ?, ?, 0)");
  tpl.weeks.forEach((w: any, wi: number) => {
    for (const [role, titles] of Object.entries(w.roles || {})) {
      for (const title of titles as string[]) {
        insTask.run(uuid(), runId, wi + 1, role, title);
      }
    }
  });
  const insKpi = db.prepare(
    "INSERT INTO kpis (id, run_id, name, unit, targets_json) VALUES (?, ?, ?, ?, ?)");
  for (const k of tpl.kpis || []) {
    insKpi.run(uuid(), runId, k.name, k.unit || "", JSON.stringify(k.targets || [0, 0, 0, 0]));
  }
  return runId;
}

// ---------- task feed state (unread replies, stall nudges) ----------

/** A task is stalled when incomplete and its latest feed activity
 *  (max of link created_at and thread meta.last_date) is STALL_DAYS or more
 *  old. Pure date math — no AI. STALL_DAYS is a const today; a per-run
 *  setting is the natural next step. */
export const STALL_DAYS = 3;

/** Pure stall math, exported for tests. latestActivityIso may be null
 *  (no feed activity → never stalled by this rule). */
export function stallStatus(done: boolean, latestActivityIso: string | null, nowMs: number): {
  stalled: boolean; days_quiet: number | null;
} {
  if (done || !latestActivityIso) return { stalled: false, days_quiet: null };
  const days = Math.floor((nowMs - Date.parse(latestActivityIso)) / 864e5);
  if (!Number.isFinite(days)) return { stalled: false, days_quiet: null };
  return { stalled: days >= STALL_DAYS, days_quiet: Math.max(0, days) };
}

function taskFeedState(t: any, links: any[]): { unread: boolean; stalled: boolean; days_quiet: number | null } {
  const unread = links.some((l) =>
    l.source === "email-imap" && l.kind === "thread" && (Number(l.meta?.unseen) || 0) > 0);
  let latest: string | null = null;
  for (const l of links) {
    for (const cand of [l.created_at, l.meta?.last_date].filter(Boolean)) {
      if (!latest || cand > latest) latest = cand; // ISO-8601 compares lexicographically
    }
  }
  const { stalled, days_quiet } = stallStatus(!!t.done, latest, Date.now());
  return { unread, stalled, days_quiet };
}

/** "Name <email>" or bare address → { email, name } | null. */
export function parseAddr(s: any): { email: string; name: string } | null {
  const str = String(s || "").trim();
  if (!str) return null;
  const m = str.match(/<([^<>\s@]+@[^<>\s@]+)>/);
  if (m) {
    return { email: m[1].toLowerCase(), name: str.slice(0, m.index).trim().replace(/^["']|["']$/g, "") };
  }
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str) ? { email: str.toLowerCase(), name: "" } : null;
}

/** Harvest raw address strings ("Name <email>" or bare) into email_contacts.
 *  Keeps the first-seen name; always refreshes last_used. */
export function harvestContacts(db: Database, addrs: any[], exclude?: Set<string>) {
  const now = new Date().toISOString();
  const up = db.prepare(
    "INSERT INTO email_contacts (email, name, last_used) VALUES (?, ?, ?) " +
    "ON CONFLICT(email) DO UPDATE SET last_used = excluded.last_used, " +
    "name = CASE WHEN email_contacts.name = '' THEN excluded.name ELSE email_contacts.name END");
  const run = db.transaction((list: any[]) => {
    for (const a of list) {
      const p = parseAddr(a);
      if (!p) continue;
      if (exclude?.has(p.email)) continue; // never harvest the user's own addresses
      up.run(p.email, p.name, now);
    }
  });
  run(addrs || []);
  // Self-healing: own addresses harvested in the past are not contacts.
  if (exclude && exclude.size) {
    const del = db.prepare("DELETE FROM email_contacts WHERE email = ?");
    const clean = db.transaction((emails: string[]) => { for (const e of emails) del.run(e); });
    clean([...exclude]);
  }
}

/** Mundane activity log — one row per small user-initiated action, surfaced
 *  in the Activity pane ("added manual note to …"). Exported so Illiad's
 *  write intents log the same way the routes do. */
export function logEvent(db: Database, runId: string, kind: string, label: string, detail: any = {}) {
  db.run(
    "INSERT INTO events (id, run_id, kind, label, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [uuid(), runId || "", kind, String(label).slice(0, 500),
     JSON.stringify(detail || {}), new Date().toISOString()]);
}

// ---------- stakeholders ----------
// Per-counterparty rollup: threads + tasks involving each email address,
// built from email_contacts and thread-link meta (from/to). Exported so
// Illiad can answer "how's acme?" against the same data as the People tab.
export function getStakeholders(db: Database, runId: string, exclude?: Set<string>): any[] {
  const tasks: any[] = db.query(
    "SELECT id, title, role, week FROM tasks WHERE run_id = ?").all(runId);
  const tById = new Map(tasks.map((t) => [t.id, t]));
  const links: any[] = db.query(
    `SELECT tl.*, t.title AS task_title FROM task_links tl
     JOIN tasks t ON t.id = tl.task_id
     WHERE t.run_id = ? AND tl.source = 'email-imap' AND tl.kind = 'thread'`).all(runId);
  const contacts: any[] = db.query("SELECT email, name, last_used FROM email_contacts").all();
  const cByEmail = new Map(contacts.map((c) => [String(c.email).toLowerCase(), c]));
  const sh = new Map<string, any>();
  const touch = (email: string, name: string, link: any, meta: any) => {
    email = email.toLowerCase();
    if (exclude?.has(email)) return; // the user is not their own stakeholder
    if (!sh.has(email)) {
      sh.set(email, { email, name, last_used: "", threads: [], taskIds: new Set<string>() });
    }
    const s = sh.get(email);
    if (name && !s.name) s.name = name;
    const last = meta.last_date || meta.date || "";
    s.threads.push({
      task_id: link.task_id, task_title: link.task_title, subject: link.label,
      last_date: last, unseen: Number(meta.unseen) || 0,
    });
    s.taskIds.add(link.task_id);
    for (const cand of [last, cByEmail.get(email)?.last_used].filter(Boolean)) {
      if (!s.last_used || cand > s.last_used) s.last_used = cand;
    }
  };
  for (const l of links) {
    const meta = JSON.parse(l.meta_json || "{}");
    const f = parseAddr(meta.from);
    if (f) touch(f.email, f.name, l, meta);
    for (const t of (Array.isArray(meta.to) ? meta.to : [])) {
      const p = parseAddr(t);
      if (p) touch(p.email, p.name, l, meta);
    }
  }
  for (const c of contacts) {
    const email = String(c.email).toLowerCase();
    if (exclude?.has(email)) continue;
    if (!sh.has(email)) {
      sh.set(email, { email, name: c.name || "", last_used: c.last_used || "", threads: [], taskIds: new Set() });
    } else if (c.name && !sh.get(email).name) {
      sh.get(email).name = c.name;
    }
  }
  return [...sh.values()].map((s) => ({
    email: s.email, name: s.name || s.email, last_used: s.last_used,
    threads: s.threads.sort((a: any, b: any) =>
      (a.last_date < b.last_date ? 1 : a.last_date > b.last_date ? -1 : 0)),
    tasks: [...s.taskIds].map((id: string) => {
      const t = tById.get(id);
      return t ? { task_id: t.id, title: t.title, role: t.role, week: t.week } : null;
    }).filter(Boolean),
  })).sort((a, b) =>
    (a.last_used < b.last_used ? 1 : a.last_used > b.last_used ? -1
      : b.threads.length - a.threads.length || (a.email < b.email ? -1 : 1)));
}

// ---------- inbound thread sync (shared by the route and Illiad) ----------
export async function syncRunFeeds(
  db: Database,
  runId: string,
  threadFetcher?: (subject: string) => Promise<ThreadMessage[]>,
): Promise<{ threads: number; synced: number; new_replies: number }> {
  const run: any = db.query("SELECT id FROM runs WHERE id = ?").get(runId);
  if (!run) throw new Error("run not found");
  const links: any[] = db.query(
    `SELECT tl.* FROM task_links tl JOIN tasks t ON t.id = tl.task_id
     WHERE t.run_id = ? AND tl.source = 'email-imap' AND tl.kind = 'thread'`).all(runId);
  const active = (l: any) => {
    try { return JSON.parse(l.meta_json || "{}").last_date || ""; } catch { return ""; }
  };
  links.sort((a, b) => {
    const ka = (active(a) || "") + "|" + (a.created_at || "");
    const kb = (active(b) || "") + "|" + (b.created_at || "");
    return ka < kb ? 1 : ka > kb ? -1 : 0;
  });
  const batch = links.slice(0, 20); // cap: most-recently-active first
  const row: any = db.query("SELECT config_json FROM connector_cfg WHERE id = 'email-imap'").get();
  const config = row ? JSON.parse(row.config_json) : {};
  const own = await ownEmails(db); // never harvest the user's own addresses
  let synced = 0, newReplies = 0, firstErr = "";
  for (const l of batch) {
    try {
      const r = await syncThread({
        link: { ref: l.ref, label: l.label, meta: JSON.parse(l.meta_json || "{}") },
        config, fetchMessages: threadFetcher,
      });
      db.run("UPDATE task_links SET meta_json = ? WHERE id = ?", [JSON.stringify(r.meta), l.id]);
      harvestContacts(db, r.harvest, own);
      synced++; newReplies += r.newCount;
    } catch (e: any) { if (!firstErr) firstErr = e?.message || "thread sync failed"; }
  }
  if (batch.length && !synced) throw new Error(firstErr);
  return { threads: batch.length, synced, new_replies: newReplies };
}

// ---------- dashboard ----------
export function getDashboard(db: Database, runId: string): any | null {
  const run: any = db.query("SELECT * FROM runs WHERE id = ?").get(runId);
  if (!run) return null;
  const pb: any = db.query("SELECT * FROM playbooks WHERE id = ?").get(run.playbook_id);
  const tpl = JSON.parse(pb.weeks_json);
  const weekCount = tpl.weeks.length;

  const tasks: any[] = db.query(
    "SELECT * FROM tasks WHERE run_id = ? ORDER BY week, role, title").all(runId);
  const kpis: any[] = db.query("SELECT * FROM kpis WHERE run_id = ?").all(runId);
  const kpiIds = kpis.map((k) => k.id);
  const entries: any[] = kpiIds.length
    ? db.query(`SELECT * FROM metric_entries WHERE kpi_id IN (${kpiIds.map(() => "?").join(",")}) ORDER BY date DESC`)
        .all(...kpiIds)
    : [];
  const byKpi = new Map<string, any[]>();
  for (const e of entries) {
    if (!byKpi.has(e.kpi_id)) byKpi.set(e.kpi_id, []);
    byKpi.get(e.kpi_id)!.push(e);
  }

  // Evidence links, attached per task.
  const links: any[] = db.query(
    "SELECT * FROM task_links WHERE task_id IN (SELECT id FROM tasks WHERE run_id = ?) ORDER BY created_at DESC"
  ).all(runId);
  const byTask = new Map<string, any[]>();
  for (const l of links) {
    if (!byTask.has(l.task_id)) byTask.set(l.task_id, []);
    byTask.get(l.task_id)!.push({
      id: l.id, source: l.source, kind: l.kind, ref: l.ref, label: l.label,
      meta: JSON.parse(l.meta_json || "{}"), created_at: l.created_at,
    });
  }

  const weeks = tpl.weeks.map((w: any, i: number) => {
    const week = i + 1;
    const { from, to } = weekRange(run.start_date, week);
    const wt = tasks.filter((t) => t.week === week);
    const roles: Record<string, any[]> = {};
    for (const t of wt) {
      const tl = byTask.get(t.id) || [];
      (roles[t.role] ||= []).push({
        id: t.id, title: t.title, done: !!t.done, done_at: t.done_at,
        links: tl, ...taskFeedState(t, tl),
      });
    }
    const done = wt.filter((t) => t.done).length;
    return { week, theme: w.theme, from, to, roles, tasks_done: done, tasks_total: wt.length };
  });

  const kpiViews = kpis.map((k: any) => {
    const targets: number[] = JSON.parse(k.targets_json);
    const es = byKpi.get(k.id) || [];
    const actuals = Array.from({ length: weekCount }, (_, i) => {
      const { from, to } = weekRange(run.start_date, i + 1);
      return es.filter((e) => e.date >= from && e.date < to).reduce((s, e) => s + e.value, 0);
    });
    const totalActual = actuals.reduce((a, b) => a + b, 0);
    const totalTarget = targets.reduce((a, b) => a + b, 0);
    return {
      id: k.id, name: k.name, unit: k.unit, targets, actuals,
      total_actual: totalActual, total_target: totalTarget,
      pct: totalTarget > 0 ? Math.min(100, Math.round((100 * totalActual) / totalTarget)) : 0,
      recent: es.slice(0, 8).map((e) => ({
        id: e.id, date: e.date, value: e.value, source: e.source, note: e.note,
      })),
    };
  });

  const tasksDone = tasks.filter((t) => t.done).length;
  // Mundane activity log — small user-initiated actions, newest first.
  const events: any[] = db.query(
    "SELECT id, kind, label, detail_json, created_at FROM events WHERE run_id = ? ORDER BY created_at DESC LIMIT 120"
  ).all(runId);
  const dash: any = {
    run: {
      id: run.id, name: run.name, playbook_id: run.playbook_id,
      playbook_name: pb.name, start_date: run.start_date, status: run.status,
    },
    current_week: currentWeek(run.start_date, weekCount),
    weeks,
    kpis: kpiViews,
    activity: [
      ...tasks.filter((t) => t.done && t.done_at).map((t) => ({
        type: "task", at: t.done_at, week: t.week, role: t.role, title: t.title,
      })),
      ...entries.map((e) => {
        const k = kpis.find((x) => x.id === e.kpi_id);
        return {
          type: "metric", at: e.date, kpi: k?.name || "", value: e.value,
          unit: k?.unit || "", source: e.source, note: e.note,
        };
      }),
      ...events.map((e) => ({
        type: "event", at: e.created_at, kind: e.kind, label: e.label,
        task_id: (() => { try { return JSON.parse(e.detail_json || "{}").task_id || null; } catch { return null; } })(),
      })),
    ].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 60),
    overall: {
      tasks_done: tasksDone,
      tasks_total: tasks.length,
      pct: tasks.length ? Math.round((100 * tasksDone) / tasks.length) : 0,
    },
  };
  // Illiad behavior nudges — derived from the same payload, never stored.
  dash.nudges = nudgeList(dash);
  // Illiad programs the Today page: greeting, wins-first line, one focus.
  dash.today = programToday(dash);
  return dash;
}

// ---------- app ----------
export function createApp(opts: {
  dbPath: string;
  smtpIoFactory?: () => Promise<SmtpLineIO>;
  threadFetcher?: (subject: string) => Promise<ThreadMessage[]>;
}) {
  const db = new Database(opts.dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  initDb(db);
  seedIfEmpty(db);

  const q = {
    playbooks: () => db.query("SELECT id, name, description FROM playbooks ORDER BY name").all(),
    playbook: db.query("SELECT * FROM playbooks WHERE id = ?"),
    runs: () => db.query(
      `SELECT r.*, p.name AS playbook_name,
        (SELECT COUNT(*) FROM tasks t WHERE t.run_id = r.id) AS tasks_total,
        (SELECT COUNT(*) FROM tasks t WHERE t.run_id = r.id AND t.done = 1) AS tasks_done
       FROM runs r JOIN playbooks p ON p.id = r.playbook_id ORDER BY r.start_date DESC`).all(),
  };

  async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const m = req.method;

    // Own addresses (every sending account), memoized per request: never
    // harvested as contacts, never shown as stakeholders.
    let ownCache: Set<string> | null = null;
    const ownAddrs = async (): Promise<Set<string>> => (ownCache ??= await ownEmails(db));

    // Thread messages for viewing and reply-threading: the injectable stub
    // in tests, real IMAP otherwise. Always oldest-first.
    const fetchThreadMsgs = async (subject: string, config: any): Promise<ThreadMessage[]> => {
      if (opts.threadFetcher) {
        const msgs = await opts.threadFetcher(subject);
        return msgs
          .map((m: any) => ({ ...m, body: m.body || m.snippet || "" }))
          .sort((a: any, b: any) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      }
      return getThreadMessages(subject, config);
    };

    try {
      // ----- playbooks -----
      if (path === "/api/playbooks" && m === "GET") return json(q.playbooks());
      if (path === "/api/playbooks" && m === "POST") {
        const b = await body(req);
        if (!b?.name) return err(400, "name is required");
        const id = uuid();
        db.run("INSERT INTO playbooks (id, name, description, weeks_json) VALUES (?, ?, ?, ?)",
          [id, b.name, b.description || "", JSON.stringify(b.weeks || { weeks: [], kpis: [] })]);
        return json({ id }, 201);
      }
      let pm = path.match(/^\/api\/playbooks\/([^/]+)$/);
      if (pm) {
        const id = decodeURIComponent(pm[1]);
        if (m === "GET") {
          const r: any = q.playbook.get(id);
          return r ? json({ ...r, weeks_json: JSON.parse(r.weeks_json) }) : err(404, "playbook not found");
        }
        if (m === "PUT") {
          const b = await body(req);
          const r: any = q.playbook.get(id);
          if (!r) return err(404, "playbook not found");
          db.run("UPDATE playbooks SET name = ?, description = ?, weeks_json = ? WHERE id = ?", [
            b.name ?? r.name, b.description ?? r.description,
            b.weeks ? JSON.stringify(b.weeks) : r.weeks_json, id,
          ]);
          return json({ ok: true });
        }
        if (m === "DELETE") {
          db.run("DELETE FROM playbooks WHERE id = ?", [id]);
          return json({ ok: true });
        }
      }

      // ----- runs -----
      if (path === "/api/runs" && m === "GET") {
        return json(q.runs().map((r: any) => ({
          ...r,
          pct: r.tasks_total ? Math.round((100 * r.tasks_done) / r.tasks_total) : 0,
        })));
      }
      if (path === "/api/runs" && m === "POST") {
        const b = await body(req);
        if (!b?.playbook_id) return err(400, "playbook_id is required");
        const pb: any = q.playbook.get(b.playbook_id);
        if (!pb) return err(404, "playbook not found");
        const startDate = /^\d{4}-\d{2}-\d{2}$/.test(b.start_date || "")
          ? b.start_date : new Date().toISOString().slice(0, 10);
        const name = b.name || `${pb.name} — ${startDate}`;
        const id = instantiateRun(db, b.playbook_id, name, startDate);
        return json({ id }, 201);
      }
      pm = path.match(/^\/api\/runs\/([^/]+)$/);
      if (pm) {
        const id = decodeURIComponent(pm[1]);
        if (m === "GET") {
          const d = getDashboard(db, id);
          return d ? json(d) : err(404, "run not found");
        }
        if (m === "PUT") {
          const b = await body(req);
          const r: any = db.query("SELECT * FROM runs WHERE id = ?").get(id);
          if (!r) return err(404, "run not found");
          db.run("UPDATE runs SET name = ?, status = ?, start_date = ? WHERE id = ?", [
            b.name ?? r.name, b.status ?? r.status, b.start_date ?? r.start_date, id,
          ]);
          return json({ ok: true });
        }
        if (m === "DELETE") {
          const kpis: any[] = db.query("SELECT id FROM kpis WHERE run_id = ?").all(id);
          const tx = db.transaction(() => {
            for (const k of kpis) db.run("DELETE FROM metric_entries WHERE kpi_id = ?", [k.id]);
            db.run("DELETE FROM task_links WHERE task_id IN (SELECT id FROM tasks WHERE run_id = ?)", [id]);
            db.run("DELETE FROM kpis WHERE run_id = ?", [id]);
            db.run("DELETE FROM tasks WHERE run_id = ?", [id]);
            db.run("DELETE FROM runs WHERE id = ?", [id]);
          });
          tx();
          return json({ ok: true });
        }
      }

      // ----- task toggle -----
      pm = path.match(/^\/api\/runs\/([^/]+)\/tasks\/([^/]+)\/toggle$/);
      if (pm && m === "POST") {
        const [runId, taskId] = [decodeURIComponent(pm[1]), decodeURIComponent(pm[2])];
        const t: any = db.query("SELECT * FROM tasks WHERE id = ? AND run_id = ?").get(taskId, runId);
        if (!t) return err(404, "task not found");
        const done = t.done ? 0 : 1;
        db.run("UPDATE tasks SET done = ?, done_at = ? WHERE id = ?", [
          done, done ? new Date().toISOString() : null, taskId,
        ]);
        logEvent(db, runId, "task", done ? `marked “${t.title}” done` : `reopened “${t.title}”`,
          { task_id: taskId });
        return json({ id: taskId, done: !!done });
      }

      // ----- metric entries -----
      pm = path.match(/^\/api\/kpis\/([^/]+)\/entries$/);
      if (pm && m === "POST") {
        const kpiId = decodeURIComponent(pm[1]);
        const k: any = db.query("SELECT id, run_id, name, unit FROM kpis WHERE id = ?").get(kpiId);
        if (!k) return err(404, "kpi not found");
        const b = await body(req);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(b?.date || "")) return err(400, "date (YYYY-MM-DD) is required");
        if (!Number.isFinite(Number(b?.value))) return err(400, "numeric value is required");
        const id = uuid();
        db.run("INSERT INTO metric_entries (id, kpi_id, date, value, source, note) VALUES (?, ?, ?, ?, ?, ?)", [
          id, kpiId, b.date, Number(b.value), b.source || "manual", b.note || "",
        ]);
        logEvent(db, k.run_id, "kpi",
          `logged ${Number(b.value)}${k.unit ? ` ${k.unit}` : ""} for ${k.name}`,
          { kpi_id: kpiId });
        return json({ id }, 201);
      }
      pm = path.match(/^\/api\/entries\/([^/]+)$/);
      if (pm && m === "DELETE") {
        db.run("DELETE FROM metric_entries WHERE id = ?", [decodeURIComponent(pm[1])]);
        return json({ ok: true });
      }

      // ----- task links -----
      pm = path.match(/^\/api\/runs\/([^/]+)\/tasks\/([^/]+)\/links$/);
      if (pm && m === "POST") {
        const [runId, taskId] = [decodeURIComponent(pm[1]), decodeURIComponent(pm[2])];
        const t: any = db.query("SELECT id, title FROM tasks WHERE id = ? AND run_id = ?").get(taskId, runId);
        if (!t) return err(404, "task not found");
        const b = await body(req);
        const label = String(b?.label || "").trim();
        if (!label) return err(400, "label is required");
        const source = /^[a-z0-9-]{1,40}$/.test(String(b?.source || "manual")) ? b.source : "manual";
        const kind = String(b?.kind || "note").slice(0, 40);
        const meta = b?.meta && typeof b.meta === "object" ? b.meta : {};
        const id = uuid();
        db.run(
          "INSERT INTO task_links (id, task_id, source, kind, ref, label, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [id, taskId, source, kind, String(b?.ref || "").slice(0, 200), label.slice(0, 2000),
           JSON.stringify(meta), new Date().toISOString()]);
        // Mundane activity: what was added, and to which task.
        const feedLabel =
          source === "manual" && kind === "note" ? `added manual note to “${t.title}”`
          : source === "email-imap" ? `linked email thread “${label}” to “${t.title}”`
          : source === "calendar-ical" ? `linked calendar event “${label}” to “${t.title}”`
          : source === "webhook" ? `webhook pushed “${label}” to “${t.title}”`
          : `added ${kind} to “${t.title}”`;
        logEvent(db, runId, "feed", feedLabel, { task_id: taskId, link_id: id });
        // Harvest contacts from linked email threads (from + recipients),
        // never the user's own addresses.
        if (source === "email-imap") {
          const tos = Array.isArray(meta.to) ? meta.to : [];
          harvestContacts(db, [meta.from, meta.last_from, ...tos], await ownAddrs());
        }
        return json({ id }, 201);
      }
      pm = path.match(/^\/api\/links\/([^/]+)$/);
      if (pm && m === "DELETE") {
        db.run("DELETE FROM task_links WHERE id = ?", [decodeURIComponent(pm[1])]);
        return new Response(null, { status: 204 });
      }
      // Edit a manual note's text. Only user-authored notes are editable —
      // thread/event labels are derived from their source.
      if (pm && m === "PUT") {
        const linkId = decodeURIComponent(pm[1]);
        const l: any = db.query(
          "SELECT tl.*, t.run_id, t.title AS task_title FROM task_links tl " +
          "JOIN tasks t ON t.id = tl.task_id WHERE tl.id = ?").get(linkId);
        if (!l) return err(404, "link not found");
        if (l.source !== "manual") return err(400, "only manual notes can be edited");
        const b = await body(req);
        const label = String(b?.label || "").trim();
        if (!label) return err(400, "label is required");
        db.run("UPDATE task_links SET label = ? WHERE id = ?", [label.slice(0, 2000), linkId]);
        logEvent(db, l.run_id, "feed", `edited note on “${l.task_title}”`, { task_id: l.task_id, link_id: linkId });
        return json({ ok: true });
      }

      // ----- inbound thread sync -----
      // Pulls replies into linked email threads. First sync seeds seen_ids
      // silently (old mail isn't "new"); later syncs accumulate meta.unseen.
      const imapCfgRow = () => {
        const row: any = db.query("SELECT config_json FROM connector_cfg WHERE id = 'email-imap'").get();
        return row ? JSON.parse(row.config_json) : {};
      };
      const syncOneThread = async (l: any, config: any) => {
        const r = await syncThread({
          link: { ref: l.ref, label: l.label, meta: JSON.parse(l.meta_json || "{}") },
          config, fetchMessages: opts.threadFetcher,
        });
        db.run("UPDATE task_links SET meta_json = ? WHERE id = ?", [JSON.stringify(r.meta), l.id]);
        harvestContacts(db, r.harvest, await ownAddrs());
        return r;
      };
      const threadLinksForTask = (taskId: string) => db.query(
        "SELECT * FROM task_links WHERE task_id = ? AND source = 'email-imap' AND kind = 'thread'").all(taskId);
      pm = path.match(/^\/api\/runs\/([^/]+)\/tasks\/([^/]+)\/sync-feed$/);
      if (pm && m === "POST") {
        const [runId, taskId] = [decodeURIComponent(pm[1]), decodeURIComponent(pm[2])];
        const t: any = db.query("SELECT id, title FROM tasks WHERE id = ? AND run_id = ?").get(taskId, runId);
        if (!t) return err(404, "task not found");
        const links: any[] = threadLinksForTask(taskId);
        const config = imapCfgRow();
        let synced = 0, newReplies = 0, firstErr = "";
        for (const l of links) {
          try { const r = await syncOneThread(l, config); synced++; newReplies += r.newCount; }
          catch (e: any) { if (!firstErr) firstErr = e?.message || "thread sync failed"; }
        }
        if (links.length && !synced) {
          return err(/missing IMAP credentials/.test(firstErr) ? 400 : 502, firstErr);
        }
        if (newReplies > 0) {
          logEvent(db, runId, "feed",
            `synced “${t.title}” — ${newReplies} new ${newReplies === 1 ? "reply" : "replies"}`,
            { task_id: taskId });
        }
        return json({ threads: links.length, synced, new_replies: newReplies });
      }
      pm = path.match(/^\/api\/runs\/([^/]+)\/sync-feeds$/);
      if (pm && m === "POST") {
        const runId = decodeURIComponent(pm[1]);
        try {
          return json(await syncRunFeeds(db, runId, opts.threadFetcher));
        } catch (e: any) {
          const msg = e?.message || "sync failed";
          if (msg === "run not found") return err(404, msg);
          return err(/missing IMAP credentials/.test(msg) ? 400 : 502, msg);
        }
      }
      pm = path.match(/^\/api\/runs\/([^/]+)\/tasks\/([^/]+)\/feed\/read$/);
      if (pm && m === "POST") {
        const [runId, taskId] = [decodeURIComponent(pm[1]), decodeURIComponent(pm[2])];
        const t: any = db.query("SELECT id FROM tasks WHERE id = ? AND run_id = ?").get(taskId, runId);
        if (!t) return err(404, "task not found");
        const upd = db.prepare("UPDATE task_links SET meta_json = ? WHERE id = ?");
        db.transaction(() => {
          for (const l of threadLinksForTask(taskId) as any[]) {
            const meta = JSON.parse(l.meta_json || "{}");
            if (Number(meta.unseen) > 0) { meta.unseen = 0; upd.run(JSON.stringify(meta), l.id); }
          }
        })();
        return json({ ok: true });
      }
      // Read a linked thread's messages (oldest first). Read-only IMAP.
      pm = path.match(/^\/api\/runs\/([^/]+)\/tasks\/([^/]+)\/threads\/([^/]+)\/messages$/);
      if (pm && m === "GET") {
        const [runId, taskId, linkId] =
          [decodeURIComponent(pm[1]), decodeURIComponent(pm[2]), decodeURIComponent(pm[3])];
        const l: any = db.query(
          "SELECT tl.* FROM task_links tl JOIN tasks t ON t.id = tl.task_id " +
          "WHERE tl.id = ? AND tl.task_id = ? AND t.run_id = ? " +
          "AND tl.source = 'email-imap' AND tl.kind = 'thread'").get(linkId, taskId, runId);
        if (!l) return err(404, "thread not found");
        const row: any = db.query("SELECT config_json FROM connector_cfg WHERE id = 'email-imap'").get();
        const config = row ? JSON.parse(row.config_json) : {};
        try {
          const messages = await fetchThreadMsgs(l.label || l.ref, config);
          return json({
            messages: messages.map((mg) => ({
              from: mg.from, date: mg.date, subject: mg.subject,
              snippet: mg.snippet, body: mg.body,
            })),
          });
        } catch (e: any) {
          const msg = e?.message || "thread fetch failed";
          return err(/missing IMAP credentials/.test(msg) ? 400 : 502, msg);
        }
      }

      // ----- stakeholders -----
      // Per-counterparty rollup: threads + tasks involving each email address,
      // built from email_contacts and thread-link meta (from/to).
      if (path === "/api/stakeholders" && m === "GET") {
        const runId = url.searchParams.get("run_id") || "";
        if (!runId) return err(400, "run_id is required");
        const run: any = db.query("SELECT id FROM runs WHERE id = ?").get(runId);
        if (!run) return err(404, "run not found");
        return json({ stakeholders: getStakeholders(db, runId, await ownAddrs()) });
      }

      // ----- illiad -----
      // C-suite assistant: deterministic NL over the run's own data.
      // run_id defaults to the most recent active run; 404 when there is none.
      pm = path.match(/^\/api\/illiad\/ask$/);
      if (pm && m === "POST") {
        const b = await body(req);
        const message = String(b?.message || "").trim();
        if (!message) return err(400, "message is required");
        let runId = b?.run_id ? String(b.run_id) : "";
        if (runId) {
          const r: any = db.query("SELECT id FROM runs WHERE id = ?").get(runId);
          if (!r) return err(404, "run not found");
        } else {
          const r: any = db.query(
            "SELECT id FROM runs WHERE status = 'active' ORDER BY start_date DESC, rowid DESC LIMIT 1").get();
          if (!r) return err(404, "no active run");
          runId = r.id;
        }
        const { reply, intent } = await askIlliad(db, message, { runId, threadFetcher: opts.threadFetcher });
        return json({ reply, intent });
      }

      // ----- connectors -----
      if (path === "/api/connectors" && m === "GET") {
        const cfgs = new Set(
          (db.query("SELECT id FROM connector_cfg").all() as any[]).map((r) => r.id));
        return json([...connectors.values()].map((c) => ({
          id: c.id, name: c.name, description: c.description, configured: cfgs.has(c.id),
        })));
      }
      // GNOME Online Accounts mail accounts (for the email-imap setup).
      // Never 500s when GOA is absent — availability is the answer.
      pm = path.match(/^\/api\/connectors\/email-imap\/goa-accounts$/);
      if (pm && m === "GET") {
        try {
          const accounts = await listGoaMailAccounts();
          return json({
            available: true,
            accounts: accounts.map((a) => ({ id: a.id, email: a.email, provider: a.providerName })),
          });
        } catch {
          return json({ available: false, accounts: [] });
        }
      }
      // Email thread search (evidence linking). Before the generic :id block.
      pm = path.match(/^\/api\/connectors\/email-imap\/threads$/);
      if (pm && m === "GET") {
        const q = (url.searchParams.get("q") || "").trim();
        if (!q) return json({ threads: [] });
        const folder = url.searchParams.get("folder") || undefined;
        const row: any = db.query("SELECT config_json FROM connector_cfg WHERE id = 'email-imap'").get();
        const config = row ? JSON.parse(row.config_json) : {};
        try {
          return json({ threads: await searchThreads({ query: q, folder, config }) });
        } catch (e: any) {
          const msg = e?.message || "thread search failed";
          return err(/missing IMAP credentials/.test(msg) ? 400 : 502, msg);
        }
      }
      // Assign from feed: compose + send an email thread, then link it to the
      // task's feed. Always user-initiated from the UI — never auto-sent.
      pm = path.match(/^\/api\/connectors\/email-imap\/send$/);
      if (pm && m === "POST") {
        const b = await body(req);
        const toRaw = Array.isArray(b?.to) ? b.to : (typeof b?.to === "string" ? [b.to] : []);
        const to = [...new Set(toRaw.map((t: any) => String(t).trim().toLowerCase()).filter(Boolean))];
        if (!to.length) return err(400, "to (at least one recipient) is required");
        const bad = to.find((t) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t));
        if (bad) return err(400, `invalid email address: ${bad}`);
        const subject = String(b?.subject || "").trim();
        if (!subject) return err(400, "subject is required");
        const msgBody = String(b?.body || "").trim();
        if (!msgBody) return err(400, "body is required");
        const t: any = db.query("SELECT id, title FROM tasks WHERE id = ? AND run_id = ?")
          .get(b?.task_id, b?.run_id);
        if (!t) return err(404, "task not found");
        const row: any = db.query("SELECT config_json FROM connector_cfg WHERE id = 'email-imap'").get();
        const config = row ? JSON.parse(row.config_json) : {};
        let resolved;
        try {
          resolved = await resolveSmtpForAccount(db, String(b?.from_account || b?.from || ""));
        } catch (e: any) {
          return err(400, e?.message || "SMTP is not configured");
        }
        const cfg = resolved.cfg;
        let sent;
        try {
          sent = await sendWithConfig(cfg, { to, subject, body: msgBody }, opts.smtpIoFactory);
        } catch (e: any) {
          return err(502, e?.message || "send failed");
        }
        // File the sent message in the SENDING account's Sent folder
        // (best effort — the mail is already out).
        try {
          await appendToSent({ config: imapConfigForAccount(db, resolved.account), raw: sent.raw });
        } catch (e: any) {
          console.error("[cadence] sent-mail APPEND failed:", e?.message || e);
        }
        // Remember the contacts, most-recently-used first.
        const now = new Date().toISOString();
        const up = db.prepare(
          "INSERT INTO email_contacts (email, name, last_used) VALUES (?, '', ?) " +
          "ON CONFLICT(email) DO UPDATE SET last_used = excluded.last_used");
        db.transaction(() => { for (const e of to) up.run(e, now); })();
        // Link the new thread into the task's feed (newest first by created_at).
        const linkId = uuid();
        db.run(
          "INSERT INTO task_links (id, task_id, source, kind, ref, label, meta_json, created_at) " +
          "VALUES (?, ?, 'email-imap', 'thread', ?, ?, ?, ?)",
          [linkId, b.task_id, normalizeSubject(subject), subject.slice(0, 500),
           JSON.stringify({ from: sent.from, to, date: now.slice(0, 10), count: 1,
                            message_id: sent.messageId }), now]);
        const toShort = to.length > 1 ? `${to[0]} +${to.length - 1} more` : to[0];
        logEvent(db, String(b.run_id), "feed", `sent email to ${toShort} from “${t.title}”`,
          { task_id: b.task_id, link_id: linkId });
        return json({ link_id: linkId, message_id: sent.messageId, from: sent.from }, 201);
      }
      // Reply inside a linked thread. Always user-initiated from the thread
      // view — never auto-sent. Threading headers keep it in the same
      // conversation; the reply is filed to Sent and folded into the link's
      // meta so the next sync doesn't count our own message as new.
      pm = path.match(/^\/api\/connectors\/email-imap\/reply$/);
      if (pm && m === "POST") {
        const b = await body(req);
        const linkId = String(b?.link_id || "");
        const msgBody = String(b?.body || "").trim();
        if (!msgBody) return err(400, "body is required");
        const l: any = db.query(
          "SELECT tl.*, t.run_id, t.title AS task_title FROM task_links tl " +
          "JOIN tasks t ON t.id = tl.task_id " +
          "WHERE tl.id = ? AND tl.task_id = ? AND t.run_id = ? " +
          "AND tl.source = 'email-imap' AND tl.kind = 'thread'")
          .get(linkId, b?.task_id, b?.run_id);
        if (!l) return err(404, "thread not found");
        const meta = JSON.parse(l.meta_json || "{}");
        const row: any = db.query("SELECT config_json FROM connector_cfg WHERE id = 'email-imap'").get();
        const config = row ? JSON.parse(row.config_json) : {};
        let resolved;
        try {
          resolved = await resolveSmtpForAccount(db, String(b?.from_account || ""));
        } catch (e: any) {
          return err(400, e?.message || "SMTP is not configured");
        }
        const own = await ownAddrs();
        // Reply to the latest external sender; fall back to the thread's from.
        const candidates = [meta.last_from, meta.from].map((s: any) => parseAddr(s)?.email).filter(Boolean);
        const toAddr = candidates.find((e: string) => !own.has(e));
        if (!toAddr) return err(400, "no one to reply to in this thread");
        // Threading headers from a fresh fetch (newest message with a real id).
        let inReplyTo = "", references: string[] = [];
        try {
          const msgs = await fetchThreadMsgs(l.label || l.ref, config);
          const ids = msgs.map((mg: any) => {
            const raw = String(mg.messageId || "");
            return raw && !raw.startsWith("~") ? raw.replace(/^<|>$/g, "") : "";
          }).filter(Boolean);
          if (ids.length) {
            inReplyTo = ids[ids.length - 1];
            references = ids.slice(-5);
          }
        } catch { /* threading headers are best-effort; the reply still sends */ }
        const subject = /^re:/i.test(l.label || "") ? l.label : `Re: ${l.label}`;
        let sent;
        try {
          sent = await sendWithConfig(resolved.cfg,
            { to: [toAddr], subject, body: msgBody, inReplyTo: inReplyTo || undefined,
              references: references.length ? references : undefined },
            opts.smtpIoFactory);
        } catch (e: any) {
          return err(502, e?.message || "send failed");
        }
        try {
          await appendToSent({ config: imapConfigForAccount(db, resolved.account), raw: sent.raw });
        } catch (e: any) {
          console.error("[cadence] sent-mail APPEND failed:", e?.message || e);
        }
        const now = new Date().toISOString();
        const seen: string[] = Array.isArray(meta.seen_ids) ? meta.seen_ids : [];
        if (sent.messageId && !seen.includes(sent.messageId)) seen.push(sent.messageId);
        db.run("UPDATE task_links SET meta_json = ? WHERE id = ?", [JSON.stringify({
          ...meta, seen_ids: seen, count: (Number(meta.count) || 0) + 1,
          last_from: sent.from, last_date: now.slice(0, 10),
        }), l.id]);
        logEvent(db, l.run_id, "feed", `replied to “${l.label}” on “${l.task_title}”`,
          { task_id: l.task_id, link_id: l.id });
        return json({ message_id: sent.messageId, to: toAddr }, 201);
      }
      // Recent email contacts for the Assign-from-feed datalist.
      if (path === "/api/email-contacts" && m === "GET") {
        const contacts = db.query(
          "SELECT email, name, last_used FROM email_contacts ORDER BY last_used DESC LIMIT 20").all();
        return json({ contacts });
      }
      // Sending accounts for the Assign-from-feed From picker.
      // No secrets: only ids, emails, labels, kinds.
      if (path === "/api/email-accounts" && m === "GET") {
        return json(await listSendAccounts(db).catch(() => ({ accounts: [], default_account: null })));
      }
      // Manage the configured sending accounts (GOA accounts need no config
      // and can't be added/removed here — they appear automatically).
      if (path === "/api/email-accounts" && m === "POST") {
        const b = await body(req);
        const action = String(b?.action || "");
        const config = readImapConfig(db);
        config.accounts = Array.isArray(config.accounts) ? config.accounts : [];
        if (action === "add") {
          const a = b?.account || {};
          const email = String(a.email || "").trim().toLowerCase();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err(400, "a valid email is required");
          if (config.accounts.some((x: any) => String(x.email || "").toLowerCase() === email)) {
            return err(400, "that email is already a sending account");
          }
          const entry: any = {
            id: "a" + uuid().slice(0, 8),
            email,
            label: String(a.label || email).slice(0, 120),
          };
          if (a.goa_account) {
            entry.goa_account = String(a.goa_account);
          } else {
            entry.smtp_host = String(a.smtp_host || "").trim();
            entry.smtp_port = a.smtp_port ? Number(a.smtp_port) : undefined;
            entry.smtp_user = String(a.smtp_user || email).trim();
            if (a.smtp_pass) entry.smtp_pass = String(a.smtp_pass);
            if (!entry.smtp_host || !entry.smtp_user) {
              return err(400, "smtp_host and smtp_user are required (or pick a GOA account)");
            }
          }
          config.accounts.push(entry);
          writeImapConfig(db, config);
          return json({ id: `cfg:${entry.id}` }, 201);
        }
        if (action === "remove") {
          const id = String(b?.id || "");
          const ix = config.accounts.findIndex((x: any) => `cfg:${x.id || x.email}` === id);
          if (ix < 0) return err(404, "account not found");
          config.accounts.splice(ix, 1);
          if (config.default_account === id) delete config.default_account;
          writeImapConfig(db, config);
          return json({ ok: true });
        }
        if (action === "set-default") {
          const id = String(b?.id || "");
          const { accounts } = await listSendAccounts(db).catch(() => ({ accounts: [] as any[] }));
          if (!accounts.some((a: any) => a.id === id)) return err(404, "account not found");
          config.default_account = id;
          writeImapConfig(db, config);
          return json({ ok: true });
        }
        return err(400, "action must be add, remove, or set-default");
      }
      // Bulk-sync contact photos from every enabled EDS address book
      // (GOA-synced GNOME contacts) into the photo cache. Verbose result
      // so CLI-shape problems are diagnosable from the JSON alone.
      if (path === "/api/contacts/photos/sync" && m === "POST") {
        const res = await syncPhotosFromEDS(db);
        db.run(
          "INSERT INTO connector_cfg (id, name, config_json) VALUES ('contact-photos', 'Contact photos', ?) " +
          "ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json",
          [JSON.stringify({ last_sync: new Date().toISOString() })]);
        return json(res);
      }
      if (path === "/api/contacts/photo" && m === "GET") {
        // Single photo from the cache (populated by the bulk sync above).
        // 404 → the UI falls back to the initial-based avatar. 404s are
        // explicitly no-store so a freshly uploaded photo shows immediately.
        // The browser caches hits for a day; the server cache is 30 days
        // (manual uploads never expire).
        const email = url.searchParams.get("email") || "";
        const photo = await getContactPhoto(db, email);
        if (!photo) {
          return new Response(JSON.stringify({ error: "no photo" }), {
            status: 404,
            headers: { "content-type": "application/json", "cache-control": "no-store" },
          });
        }
        return new Response(photo.data as any, {
          status: 200,
          headers: {
            "content-type": photo.mime,
            "cache-control": "public, max-age=86400",
            "content-length": String(photo.data.length),
          },
        });
      }
      // Manually set a contact's avatar. Accepts a data: URI or raw base64
      // (JPEG/PNG/GIF/WebP, ≤2 MB). Manual photos win over EDS-synced ones
      // and never expire.
      if (path === "/api/contacts/photo" && m === "POST") {
        const b = await body(req);
        try {
          const saved = saveManualPhoto(db, b?.email, b?.data);
          return json({ ...saved, source: "manual" });
        } catch (e: any) {
          return err(400, e?.message || "could not save the photo");
        }
      }
      // Remove a stored avatar (manual or synced). Idempotent.
      if (path === "/api/contacts/photo" && m === "DELETE") {
        deleteContactPhoto(db, url.searchParams.get("email") || "");
        return json({ ok: true });
      }
      // Calendar event search (Meeting pill in the task feed). Before the generic :id block.
      pm = path.match(/^\/api\/connectors\/calendar-ical\/events$/);
      if (pm && m === "GET") {
        const from = url.searchParams.get("from") || "", to = url.searchParams.get("to") || "";
        if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
          return err(400, "from/to (YYYY-MM-DD) are required");
        }
        const q = (url.searchParams.get("q") || "").trim();
        const row: any = db.query("SELECT config_json FROM connector_cfg WHERE id = 'calendar-ical'").get();
        const config = row ? JSON.parse(row.config_json) : {};
        try {
          const { url: feedUrl } = resolveCalConfig(config); // secret-bearing URL, never logged
          const events = filterEvents(parseIcs(await fetchIcs(feedUrl)), from, to, q);
          return json({
            events: events.map((e) => ({
              uid: e.uid, summary: e.title,
              starts_at: e.start.toISOString(), ends_at: e.end.toISOString(),
              ...(e.recurring ? { recurring: true } : {}),
            })),
          });
        } catch (e: any) {
          const msg = e?.message || "calendar fetch failed";
          return err(/no iCal URL/.test(msg) ? 400 : 502, msg);
        }
      }
      pm = path.match(/^\/api\/connectors\/([^/]+)$/);
      if (pm && (m === "GET" || m === "POST")) {
        const id = decodeURIComponent(pm[1]);
        const c = getConnector(id);
        if (!c) return err(404, "connector not found");
        if (m === "GET") {
          const row: any = db.query("SELECT config_json FROM connector_cfg WHERE id = ?").get(id);
          return json({ id: c.id, name: c.name, description: c.description, config: row ? JSON.parse(row.config_json) : {} });
        }
        const b = (await body(req)) || {};
        const cfg = b.config && typeof b.config === "object" ? b.config : {};
        db.run("INSERT INTO connector_cfg (id, name, config_json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json, name = excluded.name",
          [id, c.name, JSON.stringify(cfg)]);
        return json({ ok: true });
      }
      pm = path.match(/^\/api\/connectors\/([^/]+)\/sync$/);
      if (pm && m === "POST") {
        const id = decodeURIComponent(pm[1]);
        const c = getConnector(id);
        if (!c) return err(404, "connector not found");
        const b = await body(req);
        if (!b?.kpi_id) return err(400, "kpi_id is required");
        const k: any = db.query("SELECT id FROM kpis WHERE id = ?").get(b.kpi_id);
        if (!k) return err(404, "kpi not found");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(b.from || "") || !/^\d{4}-\d{2}-\d{2}$/.test(b.to || "")) {
          return err(400, "from/to (YYYY-MM-DD) are required");
        }
        const row: any = db.query("SELECT config_json FROM connector_cfg WHERE id = ?").get(id);
        const config = row ? JSON.parse(row.config_json) : {};
        let results;
        try {
          results = await c.sync({ from: b.from, to: b.to, config });
        } catch (e: any) {
          return err(502, e?.message || "connector sync failed");
        }
        const ins = db.prepare(
          "INSERT INTO metric_entries (id, kpi_id, date, value, source, note) VALUES (?, ?, ?, ?, ?, ?)");
        const tx = db.transaction(() => {
          for (const r of results) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date) || !Number.isFinite(Number(r.value))) {
              throw new Error(`connector returned bad row: ${JSON.stringify(r)}`);
            }
            ins.run(uuid(), b.kpi_id, r.date, Number(r.value), id, r.note || "");
          }
        });
        try { tx(); } catch (e: any) { return err(502, e?.message || "storing sync results failed"); }
        return json({ inserted: results.length });
      }

      // ----- inbound webhook -----
      pm = path.match(/^\/api\/hooks\/([^/]+)$/);
      if (pm && m === "POST") {
        const key = decodeURIComponent(pm[1]);
        const row: any = db.query("SELECT config_json FROM connector_cfg WHERE id = 'webhook'").get();
        if (!keyIsValid(row ? JSON.parse(row.config_json) : {}, key)) {
          return err(401, "invalid hook key");
        }
        const b = await body(req);
        // Link-evidence shape: { task_id, kind?, ref?, label, meta? }.
        // Metric shape (existing): { kpi_id, date, value, note? }.
        if (b?.task_id) {
          const t: any = db.query("SELECT id, run_id, title FROM tasks WHERE id = ?").get(b.task_id);
          if (!t) return err(404, "task not found");
          const label = String(b.label || b.ref || "").trim();
          if (!label) return err(400, "label is required");
          const meta = b?.meta && typeof b.meta === "object" ? b.meta : {};
          const id = uuid();
          db.run(
            "INSERT INTO task_links (id, task_id, source, kind, ref, label, meta_json, created_at) VALUES (?, ?, 'webhook', ?, ?, ?, ?, ?)",
            [id, b.task_id, String(b.kind || "record").slice(0, 40), String(b.ref || "").slice(0, 200),
             label.slice(0, 500), JSON.stringify(meta), new Date().toISOString()]);
          logEvent(db, t.run_id, "feed", `webhook pushed “${label}” to “${t.title}”`,
            { task_id: b.task_id, link_id: id });
          return json({ id }, 201);
        }
        if (!b?.kpi_id) return err(400, "kpi_id is required");
        const k: any = db.query("SELECT id, run_id, name, unit FROM kpis WHERE id = ?").get(b.kpi_id);
        if (!k) return err(404, "kpi not found");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || "")) return err(400, "date (YYYY-MM-DD) is required");
        if (!Number.isFinite(Number(b?.value))) return err(400, "numeric value is required");
        const id = uuid();
        db.run("INSERT INTO metric_entries (id, kpi_id, date, value, source, note) VALUES (?, ?, ?, ?, 'webhook', ?)", [
          id, b.kpi_id, b.date, Number(b.value), b.note || "",
        ]);
        logEvent(db, k.run_id, "kpi",
          `logged ${Number(b.value)}${k.unit ? ` ${k.unit}` : ""} for ${k.name} via webhook`,
          { kpi_id: b.kpi_id });
        return json({ id }, 201);
      }

      return err(404, "not found");
    } catch (e: any) {
      console.error("[cadence]", e?.message || e);
      return err(500, "internal error");
    }
  }

  // ----- static files -----
  async function serveStatic(path: string): Promise<Response> {
    let rel = path === "/" ? "index.html" : path.slice(1).split("?")[0];
    if (rel.includes("..")) return err(404, "not found");
    const file = join(publicDir, rel);
    if (!existsSync(file)) {
      // SPA fallback for unknown non-api paths
      const idx = join(publicDir, "index.html");
      if (existsSync(idx)) return new Response(Bun.file(idx), { headers: { "content-type": "text/html" } });
      return err(404, "not found");
    }
    const types: Record<string, string> = {
      ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
      ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon",
      ".svg": "image/svg+xml", ".webp": "image/webp",
    };
    return new Response(Bun.file(file), {
      headers: { "content-type": types[extname(file)] || "application/octet-stream" },
    });
  }

  return {
    db,
    fetch: async (req: Request): Promise<Response> => {
      if (new URL(req.url).pathname.startsWith("/api/")) return fetch(req);
      return serveStatic(new URL(req.url).pathname);
    },
    close: () => db.close(),
  };
}

// ---------- main ----------
if (import.meta.main) {
  const dataDir = process.env.CADENCE_DATA_DIR || join(appRoot, "..", "data");
  mkdirSync(dataDir, { recursive: true });
  process.env.CADENCE_DATA_DIR = dataDir;
  const app = createApp({ dbPath: join(dataDir, "cadence.db") });
  const port = Number(process.env.CADENCE_PORT || 3040);
  Bun.serve({ port, hostname: "127.0.0.1", fetch: app.fetch });
  console.log(`[cadence] http://127.0.0.1:${port} (data: ${dataDir})`);
  // Bulk-sync contact photos in the background (GOA-synced address books).
  // Non-fatal: avatars fall back to initials until the cache fills.
  syncPhotosFromEDS(app.db).then((r) => {
    if (r.photos > 0 || r.errors.length) {
      console.log(`[cadence] contact photos: ${r.photos} cached from ${r.books} books` +
        (r.errors.length ? ` (${r.errors.length} errors)` : ""));
    }
  }).catch((e) => console.error("[cadence] photo sync failed:", e?.message || e));
}
