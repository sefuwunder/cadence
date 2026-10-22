// Cadence — C-suite playbook execution tracker.
// Bun + zero deps + SQLite. Binds 127.0.0.1:3040.

import { Database } from "bun:sqlite";
import { join, extname, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync, existsSync, mkdirSync } from "fs";
import { initDb, seedIfEmpty } from "./db.ts";
import { getConnector, connectors } from "./connectors/index.ts";
import { keyIsValid } from "./connectors/webhook.ts";
import { searchThreads } from "./connectors/email-imap.ts";

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

// ---------- dashboard ----------
function getDashboard(db: Database, runId: string): any | null {
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
      (roles[t.role] ||= []).push({
        id: t.id, title: t.title, done: !!t.done, done_at: t.done_at,
        links: byTask.get(t.id) || [],
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
  return {
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
    ].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 60),
    overall: {
      tasks_done: tasksDone,
      tasks_total: tasks.length,
      pct: tasks.length ? Math.round((100 * tasksDone) / tasks.length) : 0,
    },
  };
}

// ---------- app ----------
export function createApp(opts: { dbPath: string }) {
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
        return json({ id: taskId, done: !!done });
      }

      // ----- metric entries -----
      pm = path.match(/^\/api\/kpis\/([^/]+)\/entries$/);
      if (pm && m === "POST") {
        const kpiId = decodeURIComponent(pm[1]);
        const k: any = db.query("SELECT id FROM kpis WHERE id = ?").get(kpiId);
        if (!k) return err(404, "kpi not found");
        const b = await body(req);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(b?.date || "")) return err(400, "date (YYYY-MM-DD) is required");
        if (!Number.isFinite(Number(b?.value))) return err(400, "numeric value is required");
        const id = uuid();
        db.run("INSERT INTO metric_entries (id, kpi_id, date, value, source, note) VALUES (?, ?, ?, ?, ?, ?)", [
          id, kpiId, b.date, Number(b.value), b.source || "manual", b.note || "",
        ]);
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
        const t: any = db.query("SELECT id FROM tasks WHERE id = ? AND run_id = ?").get(taskId, runId);
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
          [id, taskId, source, kind, String(b?.ref || "").slice(0, 200), label.slice(0, 500),
           JSON.stringify(meta), new Date().toISOString()]);
        return json({ id }, 201);
      }
      pm = path.match(/^\/api\/links\/([^/]+)$/);
      if (pm && m === "DELETE") {
        db.run("DELETE FROM task_links WHERE id = ?", [decodeURIComponent(pm[1])]);
        return new Response(null, { status: 204 });
      }

      // ----- connectors -----
      if (path === "/api/connectors" && m === "GET") {
        const cfgs = new Set(
          (db.query("SELECT id FROM connector_cfg").all() as any[]).map((r) => r.id));
        return json([...connectors.values()].map((c) => ({
          id: c.id, name: c.name, description: c.description, configured: cfgs.has(c.id),
        })));
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
          const t: any = db.query("SELECT id FROM tasks WHERE id = ?").get(b.task_id);
          if (!t) return err(404, "task not found");
          const label = String(b.label || b.ref || "").trim();
          if (!label) return err(400, "label is required");
          const meta = b?.meta && typeof b.meta === "object" ? b.meta : {};
          const id = uuid();
          db.run(
            "INSERT INTO task_links (id, task_id, source, kind, ref, label, meta_json, created_at) VALUES (?, ?, 'webhook', ?, ?, ?, ?, ?)",
            [id, b.task_id, String(b.kind || "record").slice(0, 40), String(b.ref || "").slice(0, 200),
             label.slice(0, 500), JSON.stringify(meta), new Date().toISOString()]);
          return json({ id }, 201);
        }
        if (!b?.kpi_id) return err(400, "kpi_id is required");
        const k: any = db.query("SELECT id FROM kpis WHERE id = ?").get(b.kpi_id);
        if (!k) return err(404, "kpi not found");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || "")) return err(400, "date (YYYY-MM-DD) is required");
        if (!Number.isFinite(Number(b?.value))) return err(400, "numeric value is required");
        const id = uuid();
        db.run("INSERT INTO metric_entries (id, kpi_id, date, value, source, note) VALUES (?, ?, ?, ?, 'webhook', ?)", [
          id, b.kpi_id, b.date, Number(b.value), b.note || "",
        ]);
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
}
