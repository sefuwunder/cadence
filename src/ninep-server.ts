// ninep-server.ts — Cadence as a 9P2000 tree.
//
// Run: bun src/ninep-server.ts
//   CADENCE_DATA_DIR (default: <repo>/data) — cadence.db lives here,
//     and staging drafts live in <data>/staging/.
//   NINEP_PORT (default 9040), loopback only.
//
// Tree:
//   /templates/<id>/{name, description, weeks}
//   /runs/<id>/{name, playbook, start_date, status, steps/<task>/{title, role, week, done, links/<link>/{kind, ref, label}}}
//   /today            — current week's open tasks across active runs
//   /kpis/<id>/{name, unit, targets, entries/<entry>/{date, value, note}}
//   /activity         — recent events, newest first
//   /contacts/<email>/{name, last_used}
//   /staging/<draft>/{template, thread, contact, excerpt, created, status, result, approve, reject}
//
// Staging is file-backed, not a database table: a draft is a directory
// of field files. Writing a playbook id (or empty, to use the draft's
// template file) to `approve` creates the run — mirroring server.ts
// instantiateRun — logs an event, and records status=approved plus the
// run id in `result`. Writing anything to `reject` marks it rejected.
// The draft directory stays as the audit record of the decision.
//
// Writes elsewhere: a step's `done` file takes "1" or "0" and updates
// the task row (done_at set or cleared). Everything else is read-only.

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { serveNineP, type DirNode, type FileNode, type Node } from "./ninep.ts";
import { initDb } from "./db.ts";

function textFile(name: string, path: string, get: () => string, set?: (v: string) => void): FileNode {
  return {
    kind: "file", name, path,
    len: () => new TextEncoder().encode(get()).length,
    read: (off: number, count: number) => new TextEncoder().encode(get()).slice(off, off + count),
    write: set
      ? (off: number, data: Uint8Array) => {
          if (off !== 0) throw new Error("offset must be 0");
          set(new TextDecoder().decode(data));
          return data.length;
        }
      : undefined,
    mtime: () => Date.now(),
  };
}

function dir(name: string, path: string, list: () => { name: string; isDir: boolean }[],
  get: (n: string) => Node | null, create?: (n: string, isDir: boolean) => Node,
  remove?: () => void): DirNode {
  return { kind: "dir", name, path, list, get, create, remove, mtime: () => Date.now() };
}

// Mirrors server.ts currentWeek: week N covers days [(N-1)*7, N*7) after start.
function currentWeek(startDate: string, weekCount: number): number {
  const days = Math.floor((Date.now() - new Date(startDate + "T00:00:00Z").getTime()) / 864e5);
  return Math.min(weekCount, Math.max(1, Math.floor(days / 7) + 1));
}

// Mirrors server.ts instantiateRun: template weeks -> tasks, kpis -> kpi rows.
function instantiateRun(db: Database, playbookId: string, name: string, startDate: string): string {
  const pb: any = db.query("SELECT * FROM playbooks WHERE id = ?").get(playbookId);
  if (!pb) throw new Error("playbook not found");
  const tpl = JSON.parse(pb.weeks_json);
  const runId = randomUUID();
  db.run("INSERT INTO runs (id, playbook_id, name, start_date, status) VALUES (?, ?, ?, ?, 'active')",
    [runId, playbookId, name, startDate]);
  const insTask = db.prepare("INSERT INTO tasks (id, run_id, week, role, title, done) VALUES (?, ?, ?, ?, ?, 0)");
  (tpl.weeks || []).forEach((w: any, wi: number) => {
    for (const [role, titles] of Object.entries(w.roles || {})) {
      for (const title of titles as string[]) insTask.run(randomUUID(), runId, wi + 1, role, title);
    }
  });
  const insKpi = db.prepare("INSERT INTO kpis (id, run_id, name, unit, targets_json) VALUES (?, ?, ?, ?, ?)");
  for (const k of tpl.kpis || []) {
    insKpi.run(randomUUID(), runId, k.name, k.unit || "", JSON.stringify(k.targets || [0, 0, 0, 0]));
  }
  return runId;
}

function diskFile(name: string, path: string, full: string): FileNode {
  return {
    kind: "file", name, path,
    len: () => (existsSync(full) ? statSync(full).size : 0),
    read: (off: number, count: number) =>
      (existsSync(full) ? readFileSync(full).slice(off, off + count) : new Uint8Array(0)),
    write: (off: number, data: Uint8Array) => {
      if (off !== 0) throw new Error("offset must be 0");
      writeFileSync(full, data);
      return data.length;
    },
    truncate: () => writeFileSync(full, new Uint8Array(0)),
    remove: () => rmSync(full, { force: true }),
    mtime: () => (existsSync(full) ? statSync(full).mtimeMs : Date.now()),
  };
}

function controlFile(name: string, path: string, onWrite: (data: string) => void): FileNode {
  return {
    kind: "file", name, path,
    len: () => 0,
    read: () => new Uint8Array(0),
    write: (off: number, data: Uint8Array) => {
      if (off !== 0) throw new Error("offset must be 0");
      onWrite(new TextDecoder().decode(data));
      return data.length;
    },
    mtime: () => Date.now(),
  };
}

export function buildCadenceTree(db: Database, stagingDir: string): DirNode {
  const all = (sql: string, ...args: any[]): any[] => db.query(sql).all(...args) as any[];
  const one = (sql: string, ...args: any[]): any => db.query(sql).get(...args) as any;

  mkdirSync(stagingDir, { recursive: true });

  const draftDir = (draftId: string): DirNode => {
    const full = join(stagingDir, draftId);
    const field = (f: string) => (existsSync(join(full, f)) ? readFileSync(join(full, f), "utf8") : "");
    const approve = (data: string) => {
      let playbookId = data.trim() || field("template").trim();
      if (!playbookId) throw new Error("template missing: write a playbook id to approve, or set the template file");
      const pb: any = one("SELECT * FROM playbooks WHERE id = ?", playbookId);
      if (!pb) throw new Error("playbook not found");
      const thread = field("thread");
      const contact = field("contact");
      const today = new Date().toISOString().slice(0, 10);
      const runId = instantiateRun(db, playbookId, contact ? `${contact} — ${pb.name}` : pb.name, today);
      db.run("INSERT INTO events (id, run_id, kind, label, detail_json, created_at) VALUES (?, ?, 'run', ?, ?, ?)",
        [randomUUID(), runId, `Run approved from ${thread}`, JSON.stringify({ draft: draftId, thread }), new Date().toISOString()]);
      writeFileSync(join(full, "status"), "approved");
      writeFileSync(join(full, "result"), runId);
    };
    const reject = () => {
      writeFileSync(join(full, "status"), "rejected");
    };
    return dir(draftId, `/staging/${draftId}`,
      () => {
        const names = new Set(
          readdirSync(full).filter((n) => !statSync(join(full, n)).isDirectory()));
        // approve/reject are virtual control files: writable, never listed on disk.
        names.add("approve");
        names.add("reject");
        return [...names].map((n) => ({ name: n, isDir: false }));
      },
      (n: string) => {
        if (n === "approve") return controlFile(n, `/staging/${draftId}/approve`, approve);
        if (n === "reject") return controlFile(n, `/staging/${draftId}/reject`, reject);
        const p = join(full, n);
        if (!existsSync(p)) return null;
        if (statSync(p).isDirectory()) return null;
        return diskFile(n, `/staging/${draftId}/${n}`, p);
      },
      (n: string, isDir: boolean) => {
        if (isDir) throw new Error("no subdirectories in a draft");
        const p = join(full, n);
        writeFileSync(p, new Uint8Array(0));
        return diskFile(n, `/staging/${draftId}/${n}`, p);
      },
      () => rmSync(full, { recursive: true, force: true }));
  };

  const staging = dir("staging", "/staging",
    () => readdirSync(stagingDir)
      .filter((n) => statSync(join(stagingDir, n)).isDirectory())
      .map((n) => ({ name: n, isDir: true })),
    (n: string) => {
      const p = join(stagingDir, n);
      return existsSync(p) && statSync(p).isDirectory() ? draftDir(n) : null;
    },
    (n: string, isDir: boolean) => {
      if (!isDir) throw new Error("drafts are directories");
      const p = join(stagingDir, n);
      mkdirSync(p, { recursive: true });
      const now = new Date().toISOString();
      for (const [f, v] of [["template", ""], ["thread", ""], ["contact", ""], ["excerpt", ""],
        ["created", now], ["status", "proposed"], ["result", ""]] as const) {
        writeFileSync(join(p, f), v);
      }
      return draftDir(n);
    });

  const templates = dir("templates", "/templates",
    () => all("SELECT id FROM playbooks ORDER BY name").map((r) => ({ name: r.id, isDir: true })),
    (id: string) => {
      const pb = one("SELECT * FROM playbooks WHERE id = ?", id);
      if (!pb) return null;
      return dir(id, `/templates/${id}`,
        () => [{ name: "name", isDir: false }, { name: "description", isDir: false }, { name: "weeks", isDir: false }],
        (n: string) => {
          if (n === "name") return textFile(n, `/templates/${id}/name`, () => pb.name);
          if (n === "description") return textFile(n, `/templates/${id}/description`, () => pb.description);
          if (n === "weeks") return textFile(n, `/templates/${id}/weeks`, () => pb.weeks_json);
          return null;
        });
    });

  const taskNode = (runId: string, t: any): DirNode =>
    dir(t.id, `/runs/${runId}/steps/${t.id}`,
      () => [
        { name: "title", isDir: false }, { name: "role", isDir: false },
        { name: "week", isDir: false }, { name: "done", isDir: false },
        { name: "links", isDir: true },
      ],
      (n: string) => {
        if (n === "title") return textFile(n, `/runs/${runId}/steps/${t.id}/title`, () => t.title);
        if (n === "role") return textFile(n, `/runs/${runId}/steps/${t.id}/role`, () => t.role);
        if (n === "week") return textFile(n, `/runs/${runId}/steps/${t.id}/week`, () => String(t.week));
        if (n === "done") {
          return textFile(n, `/runs/${runId}/steps/${t.id}/done`,
            () => {
              const cur: any = one("SELECT done FROM tasks WHERE id = ?", t.id);
              return cur ? String(cur.done) : "0";
            },
            (v: string) => {
              const s = v.trim();
              if (s !== "0" && s !== "1") throw new Error('done takes "1" or "0"');
              db.run("UPDATE tasks SET done = ?, done_at = ? WHERE id = ?",
                [Number(s), s === "1" ? new Date().toISOString() : null, t.id]);
            });
        }
        if (n === "links") {
          return dir("links", `/runs/${runId}/steps/${t.id}/links`,
            () => all("SELECT id FROM task_links WHERE task_id = ? ORDER BY created_at DESC", t.id)
              .map((l) => ({ name: l.id, isDir: true })),
            (lid: string) => {
              const l = one("SELECT * FROM task_links WHERE id = ? AND task_id = ?", lid, t.id);
              if (!l) return null;
              return dir(lid, `/runs/${runId}/steps/${t.id}/links/${lid}`,
                () => [{ name: "kind", isDir: false }, { name: "ref", isDir: false }, { name: "label", isDir: false }],
                (f: string) => {
                  if (f === "kind") return textFile(f, `/runs/${runId}/steps/${t.id}/links/${lid}/kind`, () => l.kind);
                  if (f === "ref") return textFile(f, `/runs/${runId}/steps/${t.id}/links/${lid}/ref`, () => l.ref);
                  if (f === "label") return textFile(f, `/runs/${runId}/steps/${t.id}/links/${lid}/label`, () => l.label);
                  return null;
                });
            });
        }
        return null;
      });

  const runNode = (r: any): DirNode =>
    dir(r.id, `/runs/${r.id}`,
      () => [
        { name: "name", isDir: false }, { name: "playbook", isDir: false },
        { name: "start_date", isDir: false }, { name: "status", isDir: false },
        { name: "steps", isDir: true },
      ],
      (n: string) => {
        if (n === "name") return textFile(n, `/runs/${r.id}/name`, () => r.name);
        if (n === "playbook") return textFile(n, `/runs/${r.id}/playbook`, () => r.playbook_id);
        if (n === "start_date") return textFile(n, `/runs/${r.id}/start_date`, () => r.start_date);
        if (n === "status") return textFile(n, `/runs/${r.id}/status`, () => r.status);
        if (n === "steps") {
          return dir("steps", `/runs/${r.id}/steps`,
            () => all("SELECT * FROM tasks WHERE run_id = ? ORDER BY week, role, title", r.id)
              .map((t) => ({ name: t.id, isDir: true })),
            (tid: string) => {
              const t = one("SELECT * FROM tasks WHERE id = ? AND run_id = ?", tid, r.id);
              return t ? taskNode(r.id, t) : null;
            });
        }
        return null;
      });

  const runs = dir("runs", "/runs",
    () => all("SELECT id FROM runs ORDER BY start_date DESC, name").map((r) => ({ name: r.id, isDir: true })),
    (id: string) => {
      const r = one("SELECT * FROM runs WHERE id = ?", id);
      return r ? runNode(r) : null;
    });

  const today = textFile("today", "/today", () => {
    const lines: string[] = [];
    for (const r of all("SELECT * FROM runs WHERE status = 'active' ORDER BY name")) {
      const pb = one("SELECT * FROM playbooks WHERE id = ?", r.playbook_id);
      if (!pb) continue;
      let weekCount = 1;
      try { weekCount = JSON.parse(pb.weeks_json).weeks.length || 1; } catch {}
      const week = currentWeek(r.start_date, weekCount);
      for (const t of all("SELECT * FROM tasks WHERE run_id = ? AND week = ? AND done = 0 ORDER BY role, title", r.id, week)) {
        lines.push(`${r.name} | week ${week} | ${t.role} | ${t.title}`);
      }
    }
    return lines.length ? lines.join("\n") + "\n" : "Nothing due today.\n";
  });

  const kpis = dir("kpis", "/kpis",
    () => all("SELECT id FROM kpis ORDER BY run_id, name").map((k) => ({ name: k.id, isDir: true })),
    (id: string) => {
      const k = one("SELECT * FROM kpis WHERE id = ?", id);
      if (!k) return null;
      return dir(id, `/kpis/${id}`,
        () => [
          { name: "name", isDir: false }, { name: "unit", isDir: false },
          { name: "targets", isDir: false }, { name: "entries", isDir: true },
        ],
        (n: string) => {
          if (n === "name") return textFile(n, `/kpis/${id}/name`, () => k.name);
          if (n === "unit") return textFile(n, `/kpis/${id}/unit`, () => k.unit);
          if (n === "targets") return textFile(n, `/kpis/${id}/targets`, () => k.targets_json);
          if (n === "entries") {
            return dir("entries", `/kpis/${id}/entries`,
              () => all("SELECT id FROM metric_entries WHERE kpi_id = ? ORDER BY date DESC", id)
                .map((e) => ({ name: e.id, isDir: true })),
              (eid: string) => {
                const e = one("SELECT * FROM metric_entries WHERE id = ? AND kpi_id = ?", eid, id);
                if (!e) return null;
                return dir(eid, `/kpis/${id}/entries/${eid}`,
                  () => [{ name: "date", isDir: false }, { name: "value", isDir: false }, { name: "note", isDir: false }],
                  (f: string) => {
                    if (f === "date") return textFile(f, `/kpis/${id}/entries/${eid}/date`, () => e.date);
                    if (f === "value") return textFile(f, `/kpis/${id}/entries/${eid}/value`, () => String(e.value));
                    if (f === "note") return textFile(f, `/kpis/${id}/entries/${eid}/note`, () => e.note);
                    return null;
                  });
              });
          }
          return null;
        });
    });

  const activity = textFile("activity", "/activity", () => {
    const rows = all("SELECT * FROM events ORDER BY created_at DESC LIMIT 200");
    return rows.map((e) => `${e.created_at} ${e.kind} ${e.label}`).join("\n") + (rows.length ? "\n" : "");
  });

  const contacts = dir("contacts", "/contacts",
    () => all("SELECT email FROM email_contacts ORDER BY email").map((c) => ({ name: c.email, isDir: true })),
    (email: string) => {
      const c = one("SELECT * FROM email_contacts WHERE email = ?", email);
      if (!c) return null;
      return dir(email, `/contacts/${email}`,
        () => [{ name: "name", isDir: false }, { name: "last_used", isDir: false }],
        (n: string) => {
          if (n === "name") return textFile(n, `/contacts/${email}/name`, () => c.name);
          if (n === "last_used") return textFile(n, `/contacts/${email}/last_used`, () => c.last_used);
          return null;
        });
    });

  const rootChildren: Record<string, Node> = {
    templates, runs, today, kpis, activity, contacts, staging,
  };
  return dir("", "/",
    () => Object.keys(rootChildren).map((n) => ({ name: n, isDir: rootChildren[n].kind === "dir" })),
    (n: string) => rootChildren[n] || null);
}

export function startCadenceNinep(opts: { dbPath: string; stagingDir: string; port: number; hostname?: string }) {
  // Bun's sqlite does not create parent dirs (same class of bug as
  // tally's fresh-clone SQLITE_CANTOPEN): make the data dir first.
  mkdirSync(dirname(opts.dbPath), { recursive: true });
  const db = new Database(opts.dbPath);
  db.run("PRAGMA busy_timeout = 5000");
  initDb(db);
  const tree = buildCadenceTree(db, opts.stagingDir);
  return serveNineP(tree, { port: opts.port, hostname: opts.hostname });
}

if (import.meta.main) {
  const here = dirname(fileURLToPath(import.meta.url));
  const dataDir = process.env.CADENCE_DATA_DIR || join(here, "..", "data");
  const port = Number(process.env.NINEP_PORT || 9040);
  startCadenceNinep({ dbPath: join(dataDir, "cadence.db"), stagingDir: join(dataDir, "staging"), port });
  console.log(`cadence 9P on 127.0.0.1:${port} db ${join(dataDir, "cadence.db")}`);
}
