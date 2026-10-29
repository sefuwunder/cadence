// ninep-cadence.test.ts — Cadence 9P tree against a temp database.
// Seeds a playbook, a run, and a task; then drives the tree over 9P.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { initDb } from "../src/db.ts";
import { startCadenceNinep } from "../src/ninep-server.ts";
import { NinePClient } from "../src/ninep.ts";

let tmp = "";
let server: any;
let port = 0;
let db: Database;

const WEEKS = JSON.stringify({
  weeks: [{ roles: { exec: ["Kickoff call", "Send welcome"] } }],
  kpis: [{ name: "Response time", unit: "hours", targets: [24, 24, 24, 24] }],
});

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "cadence-9p-"));
  const dbPath = join(tmp, "cadence.db");
  db = new Database(dbPath);
  initDb(db);
  const today = new Date().toISOString().slice(0, 10);
  db.run("INSERT INTO playbooks (id, name, description, weeks_json) VALUES (?, ?, ?, ?)",
    ["pb-1", "Onboarding", "New client onboarding", WEEKS]);
  db.run("INSERT INTO runs (id, playbook_id, name, start_date, status) VALUES (?, ?, ?, ?, 'active')",
    ["run-1", "pb-1", "Acme — Onboarding", today]);
  db.run("INSERT INTO tasks (id, run_id, week, role, title, done) VALUES (?, ?, ?, ?, ?, 0)",
    ["task-1", "run-1", 1, "exec", "Kickoff call"]);
  db.run("INSERT INTO task_links (id, task_id, source, kind, ref, label, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ["link-1", "task-1", "thread", "message", "relay:conv-1", "Intro call", "{}", today]);
  db.run("INSERT INTO kpis (id, run_id, name, unit, targets_json) VALUES (?, ?, ?, ?, ?)",
    ["kpi-1", "run-1", "Response time", "hours", "[24,24,24,24]"]);
  db.run("INSERT INTO metric_entries (id, kpi_id, date, value, source, note) VALUES (?, ?, ?, ?, ?, ?)",
    ["e-1", "kpi-1", today, 6, "manual", "first reply"]);
  db.run("INSERT INTO events (id, run_id, kind, label, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ["ev-1", "run-1", "note", "Kickoff scheduled", "{}", today]);
  db.run("INSERT INTO email_contacts (email, name, last_used) VALUES (?, ?, ?)",
    ["jane@acme.example", "Jane Acme", today]);
  server = startCadenceNinep({ dbPath, stagingDir: join(tmp, "staging"), port: 0 });
  port = server.port;
});

afterAll(() => {
  server.stop();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function client() {
  const c = new NinePClient();
  await c.connect("127.0.0.1", port);
  return c;
}

describe("cadence 9P tree", () => {
  test("root lists the subtrees", async () => {
    const c = await client();
    try {
      const names = (await c.listDir("/")).map((e) => e.name).sort();
      expect(names).toEqual(["activity", "contacts", "kpis", "runs", "staging", "templates", "today"]);
    } finally {
      c.close();
    }
  });

  test("templates, runs, steps, links, kpis, activity, contacts read", async () => {
    const c = await client();
    try {
      expect(await c.readFile("/templates/pb-1/name")).toBe("Onboarding");
      expect(await c.readFile("/templates/pb-1/weeks")).toContain("Kickoff call");
      expect(await c.readFile("/runs/run-1/steps/task-1/title")).toBe("Kickoff call");
      expect(await c.readFile("/runs/run-1/steps/task-1/week")).toBe("1");
      expect(await c.readFile("/runs/run-1/steps/task-1/links/link-1/ref")).toBe("relay:conv-1");
      expect(await c.readFile("/kpis/kpi-1/entries/e-1/value")).toBe("6");
      expect(await c.readFile("/activity")).toContain("Kickoff scheduled");
      expect(await c.readFile("/contacts/jane@acme.example/name")).toBe("Jane Acme");
    } finally {
      c.close();
    }
  });

  test("today shows the current week's open tasks", async () => {
    const c = await client();
    try {
      const today = await c.readFile("/today");
      expect(today).toContain("Kickoff call");
      expect(today).toContain("Acme — Onboarding");
    } finally {
      c.close();
    }
  });

  test("done toggles the task row", async () => {
    const c = await client();
    try {
      expect(await c.readFile("/runs/run-1/steps/task-1/done")).toBe("0");
      await c.writeFile("/runs/run-1/steps/task-1/done", "1");
      expect(await c.readFile("/runs/run-1/steps/task-1/done")).toBe("1");
      const row: any = db.query("SELECT done, done_at FROM tasks WHERE id = 'task-1'").get();
      expect(row.done).toBe(1);
      expect(row.done_at).toBeTruthy();
      await c.writeFile("/runs/run-1/steps/task-1/done", "1"); // idempotent
      await expect(c.writeFile("/runs/run-1/steps/task-1/done", "maybe")).rejects.toThrow();
      await c.writeFile("/runs/run-1/steps/task-1/done", "0");
      expect(await c.readFile("/runs/run-1/steps/task-1/done")).toBe("0");
    } finally {
      c.close();
    }
  });

  test("staging approve creates the run, reject marks rejected", async () => {
    const c = await client();
    try {
      await c.mkdir("/staging/draft-1");
      expect((await c.listDir("/staging")).map((e) => e.name)).toContain("draft-1");
      expect(await c.readFile("/staging/draft-1/status")).toBe("proposed");
      await c.writeFile("/staging/draft-1/template", "pb-1");
      await c.writeFile("/staging/draft-1/thread", "relay:conv-1");
      await c.writeFile("/staging/draft-1/contact", "Beta Corp");
      await c.writeFile("/staging/draft-1/excerpt", "Hi, we'd like to start.");
      await c.writeFile("/staging/draft-1/approve", "pb-1");
      expect(await c.readFile("/staging/draft-1/status")).toBe("approved");
      const runId = await c.readFile("/staging/draft-1/result");
      expect(runId).toBeTruthy();
      const run: any = db.query("SELECT * FROM runs WHERE id = ?").get(runId);
      expect(run.name).toBe("Beta Corp — Onboarding");
      const tasks: any[] = db.query("SELECT title FROM tasks WHERE run_id = ? ORDER BY title").all(runId);
      expect(tasks.map((t) => t.title)).toEqual(["Kickoff call", "Send welcome"]);
      const ev: any = db.query("SELECT * FROM events WHERE run_id = ? AND kind = 'run'").get(runId);
      expect(ev.label).toContain("relay:conv-1");

      await c.mkdir("/staging/draft-2");
      await c.writeFile("/staging/draft-2/reject", "no");
      expect(await c.readFile("/staging/draft-2/status")).toBe("rejected");

      await c.mkdir("/staging/draft-3");
      await expect(c.writeFile("/staging/draft-3/approve", "pb-missing")).rejects.toThrow("playbook not found");
    } finally {
      c.close();
    }
  });
});
