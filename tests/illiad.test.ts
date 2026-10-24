// Illiad tests — intent router, analysis math, brief voice, endpoint round-trips.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createApp } from "../src/server.ts";
import { parseIntent, matchKpiName, matchTask } from "../src/illiad/intents.ts";
import { kpiPacing, analyzeRun } from "../src/illiad/analyze.ts";
import { composeBrief, composeEncouragement, daypart } from "../src/illiad/brief.ts";
import { nudgeList } from "../src/illiad/nudges.ts";
import { programToday } from "../src/illiad/today.ts";

const KPI_NAMES = ["Outbound Emails/DMs", "Discovery Calls", "SQLs", "Closed Packages", "Active Seats"];

// ---------- intent classification ----------

describe("parseIntent", () => {
  const table: [string, string][] = [
    ["brief me", "brief"],
    ["morning brief", "brief"],
    ["how are we doing", "brief"],
    ["status", "brief"],
    ["give me the state of play", "brief"],
    ["kpis", "kpi_status"],
    ["how are sqls doing", "kpi_status"],
    ["how is discovery pacing", "kpi_status"],
    ["what's stalled", "stalled"],
    ["what needs attention", "stalled"],
    ["sync feeds", "sync"],
    ["check email", "sync"],
    ["refresh", "sync"],
    ["any new replies", "unread"],
    ["what's unread", "unread"],
    ["how's acme", "stakeholder"],
    ["update on beta corp", "stakeholder"],
    ["tell me about jane", "stakeholder"],
    ["log 5 discovery calls", "log"],
    ["log 12 seats", "log"],
    ["mark onboarding checklist done", "done"],
    ["complete the audit draft", "done"],
    ["add task draft SOW week 2 for CRO", "create_task"],
    ["motivate me", "encourage"],
    ["give me the real picture", "encourage"],
    ["how am i doing", "encourage"],
    ["help", "help"],
    ["blargh flimflam", "fallback"],
    ["", "fallback"],
  ];
  for (const [utterance, intent] of table) {
    test(`"${utterance}" → ${intent}`, () => {
      expect(parseIntent(utterance).intent).toBe(intent);
    });
  }

  test("slots extracted", () => {
    expect(parseIntent("log 5 discovery calls").slots).toMatchObject({ value: "5", kpi: "discovery calls" });
    expect(parseIntent("how are sqls doing").slots.kpi).toBe("sqls");
    expect(parseIntent("how's acme").slots.who).toBe("acme");
    const c = parseIntent("add task draft SOW week 2 for CRO").slots;
    expect(c).toMatchObject({ title: "draft sow", week: "2", role: "CRO" });
    expect(parseIntent("mark onboarding checklist done").slots.task).toBe("onboarding checklist");
  });
});

describe("matchKpiName", () => {
  const cases: [string, string | null][] = [
    ["sqls", "SQLs"], ["sql", "SQLs"], ["qualified leads", "SQLs"],
    ["discovery", "Discovery Calls"], ["discovery calls", "Discovery Calls"],
    ["outreach", "Outbound Emails/DMs"], ["emails", "Outbound Emails/DMs"],
    ["anchor packages", "Closed Packages"], ["packages", "Closed Packages"],
    ["seats", "Active Seats"], ["active seats", "Active Seats"],
    ["bananas", null], ["", null],
  ];
  for (const [text, name] of cases) {
    test(`"${text}" → ${name}`, () => {
      expect(matchKpiName(text, KPI_NAMES)).toBe(name);
    });
  }
});

describe("matchTask", () => {
  const tasks = [
    { id: "1", title: "Finalize SOW templates", done: false },
    { id: "2", title: "Build ICP list of 400 targets", done: false },
    { id: "3", title: "Domain warmup", done: true },
  ];
  test("exact-ish match wins", () => {
    const r: any = matchTask("sow templates", tasks);
    expect(r.task.id).toBe("1");
  });
  test("no match → null", () => {
    expect(matchTask("bananas", tasks)).toBeNull();
  });
  test("ambiguous → list", () => {
    const r: any = matchTask("list", [
      { id: "a", title: "Build ICP list", done: false },
      { id: "b", title: "Review target list", done: false },
    ]);
    expect(r.ambiguous.length).toBe(2);
  });
});

// ---------- pacing math ----------

function fixtureDash(over: any = {}) {
  return {
    run: { id: "r", name: "Sprint 1", start_date: "2026-10-01", status: "active" },
    current_week: 2,
    weeks: [],
    kpis: [{
      id: "k1", name: "SQLs", unit: "leads",
      targets: [0, 10, 18, 20], actuals: [0, 0, 0, 0],
      total_actual: 0, total_target: 48,
    }],
    overall: { tasks_done: 0, tasks_total: 38, pct: 0 },
    ...over,
  };
}
// start 2026-10-01; week 2 starts 2026-10-08. nowMs = 2026-10-11 → elapsed 3/7.

describe("kpiPacing", () => {
  const nowMs = Date.parse("2026-10-11T12:00:00Z");
  test("on track near prorated target", () => {
    const d = fixtureDash();
    d.kpis[0].actuals = [0, 4, 0, 0];
    const [p] = kpiPacing(d, nowMs);
    expect(p.status).toBe("on_track"); // 4 vs 10*3/7 ≈ 4.29
  });
  test("behind well under pace", () => {
    const d = fixtureDash();
    d.kpis[0].actuals = [0, 1, 0, 0];
    expect(kpiPacing(d, nowMs)[0].status).toBe("behind");
  });
  test("ahead past expected", () => {
    const d = fixtureDash();
    d.kpis[0].actuals = [0, 12, 0, 0];
    expect(kpiPacing(d, nowMs)[0].status).toBe("ahead");
  });
  test("no target and no actual → no_target", () => {
    const d = fixtureDash();
    d.kpis[0].targets = [0, 0, 0, 0];
    expect(kpiPacing(d, nowMs)[0].status).toBe("no_target");
  });
  test("no target but actuals → ahead", () => {
    const d = fixtureDash();
    d.kpis[0].targets = [0, 0, 0, 0];
    d.kpis[0].actuals = [0, 3, 0, 0];
    expect(kpiPacing(d, nowMs)[0].status).toBe("ahead");
  });
});

// ---------- brief voice ----------

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u;

describe("composeBrief", () => {
  test("wins first, honest behind line, no emoji", () => {
    const d = fixtureDash({
      overall: { tasks_done: 12, tasks_total: 38, pct: 32 },
      kpis: [{
        id: "k1", name: "SQLs", unit: "leads",
        targets: [0, 10, 18, 20], actuals: [0, 1, 0, 0],
        total_actual: 1, total_target: 48,
      }],
    });
    const brief = composeBrief(d, Date.parse("2026-10-11T12:00:00Z"));
    expect(brief).toMatch(/^Good (morning|afternoon|evening)\./);
    expect(brief.indexOf("Wins:")).toBeLessThan(brief.indexOf("KPI pacing"));
    expect(brief).toContain("behind"); // names the gap, no sugarcoating
    expect(brief).toContain("Suggested focus:");
    expect(EMOJI.test(brief)).toBe(false);
  });

  test("empty board is honest, not cheerleading", () => {
    const brief = composeBrief(fixtureDash(), Date.parse("2026-10-11T12:00:00Z"));
    expect(brief).toContain("No wins on the board yet");
    expect(EMOJI.test(brief)).toBe(false);
  });
});

describe("composeEncouragement", () => {
  test("grounded in numbers", () => {
    const d = fixtureDash({ overall: { tasks_done: 12, tasks_total: 38, pct: 32 } });
    d.kpis[0].actuals = [0, 12, 0, 0];
    const e = composeEncouragement(d, Date.parse("2026-10-11T12:00:00Z"));
    expect(e).toContain("12 tasks already done");
    expect(EMOJI.test(e)).toBe(false);
  });
});

describe("daypart", () => {
  test("uses America/New_York", () => {
    expect(daypart(Date.parse("2026-10-22T13:00:00Z"))).toBe("Good morning"); // 09:00 EDT
    expect(daypart(Date.parse("2026-10-22T18:00:00Z"))).toBe("Good afternoon"); // 14:00 EDT
    expect(daypart(Date.parse("2026-10-22T23:00:00Z"))).toBe("Good evening"); // 19:00 EDT
  });
});

// ---------- endpoint round-trips ----------

let app: ReturnType<typeof createApp>;
let tmp: string;
let runId = "";
let taskTitle = "";
let taskId = "";

async function call(method: string, path: string, body?: any) {
  const res = await app.fetch(new Request(`http://localhost${path}`, {
    method, headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "cadence-illiad-test-"));
  app = createApp({ dbPath: join(tmp, "test.db") });
  const pb = (await call("GET", "/api/playbooks")).data[0];
  const run = await call("POST", "/api/runs", {
    playbook_id: pb.id, name: "Illiad Sprint", start_date: new Date().toISOString().slice(0, 10),
  });
  runId = run.data.id;
  const dash = (await call("GET", `/api/runs/${runId}`)).data;
  taskTitle = dash.weeks[0].roles.CEO[0].title;
  taskId = dash.weeks[0].roles.CEO[0].id;
});
afterAll(() => {
  app.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("POST /api/illiad/ask", () => {
  test("brief round-trip", async () => {
    const { status, data } = await call("POST", "/api/illiad/ask", { message: "brief me" });
    expect(status).toBe(200);
    expect(data.intent).toBe("brief");
    expect(typeof data.reply).toBe("string");
    expect(data.reply.length).toBeGreaterThan(50);
  });

  test("defaults to the active run", async () => {
    const { status, data } = await call("POST", "/api/illiad/ask", { message: "kpis" });
    expect(status).toBe(200);
    expect(data.intent).toBe("kpi_status");
    expect(data.reply).toContain("KPI pacing");
  });

  test("log writes a metric entry", async () => {
    const { status, data } = await call("POST", "/api/illiad/ask", {
      message: "log 5 discovery calls", run_id: runId,
    });
    expect(status).toBe(200);
    expect(data.intent).toBe("log");
    expect(data.reply).toContain("Discovery Calls");
    const row: any = app.db.query(
      "SELECT value, source FROM metric_entries WHERE kpi_id IN (SELECT id FROM kpis WHERE run_id = ? AND name = 'Discovery Calls')"
    ).get(runId);
    expect(row.value).toBe(5);
    expect(row.source).toBe("illiad");
  });

  test("log unknown kpi lists options", async () => {
    const { data } = await call("POST", "/api/illiad/ask", { message: "log 5 bananas" });
    expect(data.intent).toBe("log");
    expect(data.reply).toContain("Which KPI?");
  });

  test("done marks the task complete", async () => {
    const { status, data } = await call("POST", "/api/illiad/ask", {
      message: `mark ${taskTitle} done`, run_id: runId,
    });
    expect(status).toBe(200);
    expect(data.intent).toBe("done");
    const t: any = app.db.query("SELECT done FROM tasks WHERE id = ?").get(taskId);
    expect(t.done).toBe(1);
  });

  test("done with no match says so", async () => {
    const { data } = await call("POST", "/api/illiad/ask", {
      message: "mark xyzzy plugh done", run_id: runId,
    });
    expect(data.intent).toBe("done");
    expect(data.reply).toContain("couldn't find");
  });

  test("create_task inserts a row", async () => {
    const { status, data } = await call("POST", "/api/illiad/ask", {
      message: "add task illiad probe task week 2 for CRO", run_id: runId,
    });
    expect(status).toBe(200);
    expect(data.intent).toBe("create_task");
    const t: any = app.db.query(
      "SELECT week, role FROM tasks WHERE run_id = ? AND title = 'illiad probe task'").get(runId);
    expect(t.week).toBe(2);
    expect(t.role).toBe("CRO");
  });

  test("create_task validates role", async () => {
    const { data } = await call("POST", "/api/illiad/ask", {
      message: "add task something week 1 for JANITOR", run_id: runId,
    });
    expect(data.intent).toBe("create_task");
    expect(data.reply).toContain("CEO/CRO/CTO/COO");
  });

  test("stakeholder lookup", async () => {
    await call("POST", `/api/runs/${runId}/tasks/${taskId}/links`, {
      source: "email-imap", kind: "thread", ref: "acme kickoff", label: "Acme kickoff",
      meta: { from: "Jane <jane@acme.com>", to: ["me@x.com"], date: "2026-10-22", count: 2 },
    });
    const { data } = await call("POST", "/api/illiad/ask", { message: "how's acme" });
    expect(data.intent).toBe("stakeholder");
    expect(data.reply).toContain("acme.com");
  });

  test("stakeholder unknown → graceful", async () => {
    const { data } = await call("POST", "/api/illiad/ask", { message: "how's nosuchcorp" });
    expect(data.intent).toBe("stakeholder");
    expect(data.reply).toContain("don't see a stakeholder");
  });

  test("sync with no IMAP configured fails gracefully", async () => {
    const { data } = await call("POST", "/api/illiad/ask", { message: "sync feeds" });
    expect(data.intent).toBe("sync");
    expect(data.reply).toContain("Couldn't sync feeds");
  });

  test("stalled report", async () => {
    const { data } = await call("POST", "/api/illiad/ask", { message: "what's stalled" });
    expect(data.intent).toBe("stalled");
    expect(typeof data.reply).toBe("string");
  });

  test("unread report", async () => {
    const { data } = await call("POST", "/api/illiad/ask", { message: "any new replies" });
    expect(data.intent).toBe("unread");
    expect(data.reply).toContain("Inbox zero");
  });

  test("help lists capabilities", async () => {
    const { data } = await call("POST", "/api/illiad/ask", { message: "help" });
    expect(data.intent).toBe("help");
    expect(data.reply).toContain("Brief me");
  });

  test("fallback is graceful", async () => {
    const { data } = await call("POST", "/api/illiad/ask", { message: "blargh flimflam wibble" });
    expect(data.intent).toBe("fallback");
    expect(data.reply).toContain("didn't quite catch that");
  });

  test("unknown run_id → 404", async () => {
    const { status } = await call("POST", "/api/illiad/ask", { message: "brief me", run_id: "nope" });
    expect(status).toBe(404);
  });

  test("empty message → 400", async () => {
    const { status } = await call("POST", "/api/illiad/ask", { message: "   " });
    expect(status).toBe(400);
  });

  test("no active run → 404", async () => {
    const tmp2 = mkdtempSync(join(tmpdir(), "cadence-illiad-empty-"));
    const app2 = createApp({ dbPath: join(tmp2, "t.db") });
    const res = await app2.fetch(new Request("http://localhost/api/illiad/ask", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "brief me" }),
    }));
    expect(res.status).toBe(404);
    app2.close();
    rmSync(tmp2, { recursive: true, force: true });
  });
});

describe("nudgeList", () => {
  const NOW = new Date("2026-10-23T12:00:00Z").getTime();
  const dashFor = (over: any = {}) => ({
    run: { id: "r1", name: "Sprint", start_date: "2026-10-19" },
    current_week: 1,
    weeks: [{ week: 1, roles: { CEO: [] as any[] } }],
    kpis: [],
    overall: { tasks_done: 0, tasks_total: 0, pct: 0 },
    ...over,
  });
  const task = (over: any = {}) => ({
    id: "t1", title: "Quiet task", done: false, done_at: null,
    links: [], unread: false, stalled: false, days_quiet: null, ...over,
  });

  test("stalled task → check-in nudge with task_id", () => {
    const t = task({
      stalled: true, days_quiet: 9,
      links: [{ source: "manual", kind: "note", meta: {}, created_at: "2026-10-10T00:00:00Z" }],
    });
    const n = nudgeList(dashFor({ weeks: [{ week: 1, roles: { CEO: [t] } }] }), NOW);
    expect(n.length).toBe(1);
    expect(n[0].kind).toBe("stalled");
    expect(n[0].task_id).toBe("t1");
    expect(n[0].text).toContain("Quiet task");
    expect(n[0].text).toContain("9d");
  });

  test("behind KPI → pacing nudge", () => {
    const d = dashFor({
      kpis: [{ id: "k1", name: "SQLs", unit: "", targets: [20, 0, 0, 0], actuals: [2, 0, 0, 0] }],
    });
    const n = nudgeList(d, NOW);
    const p = n.find((x) => x.kind === "pacing");
    expect(p).toBeDefined();
    expect(p!.text).toContain("SQLs");
    expect(p!.text).toContain("back on pace");
  });

  test("unread thread → reply nudge", () => {
    const t = task({
      unread: true,
      links: [{ source: "email-imap", kind: "thread", label: "Re: Terms",
                meta: { unseen: 3, last_from: "a@b.co" }, created_at: "2026-10-23T10:00:00Z" }],
    });
    const n = nudgeList(dashFor({ weeks: [{ week: 1, roles: { CEO: [t] } }] }), NOW);
    const u = n.find((x) => x.kind === "unread");
    expect(u).toBeDefined();
    expect(u!.text).toContain("3 unread replies");
    expect(u!.text).toContain("Re: Terms");
  });

  test("accelerating completions → momentum nudge", () => {
    const t1 = task({ id: "a", title: "A", done: true, done_at: "2026-10-22T10:00:00Z" });
    const t2 = task({ id: "b", title: "B", done: true, done_at: "2026-10-21T10:00:00Z" });
    const n = nudgeList(dashFor({ weeks: [{ week: 1, roles: { CEO: [t1, t2] } }] }), NOW);
    const m = n.find((x) => x.kind === "momentum");
    expect(m).toBeDefined();
    expect(m!.text).toContain("accelerating");
  });

  test("quiet board → no nudges", () => {
    expect(nudgeList(dashFor(), NOW)).toEqual([]);
  });

  test("at most 4 nudges", () => {
    const mk = (i: number) => task({
      id: `s${i}`, title: `Stalled ${i}`, stalled: true, days_quiet: 5 + i,
      links: [{ source: "manual", kind: "note", meta: {}, created_at: "2026-10-01T00:00:00Z" }],
    });
    const n = nudgeList(
      dashFor({ weeks: [{ week: 1, roles: { CEO: [mk(1), mk(2), mk(3)] } }] }), NOW);
    expect(n.length).toBeLessThanOrEqual(4);
  });
});

describe("programToday", () => {
  const NOW = new Date("2026-10-24T02:00:00Z").getTime(); // 22:00 EDT — evening
  const dashFor = (over: any = {}) => ({
    run: { id: "r1", name: "Sprint", start_date: "2026-10-19" },
    current_week: 1,
    weeks: [{ week: 1, roles: { CEO: [] as any[] } }],
    kpis: [],
    overall: { tasks_done: 0, tasks_total: 0, pct: 0 },
    ...over,
  });
  const task = (over: any = {}) => ({
    id: "t1", title: "First task", done: false, done_at: null,
    links: [], unread: false, stalled: false, days_quiet: null, ...over,
  });

  test("greeting follows the daypart", () => {
    const p = programToday(dashFor(), NOW);
    expect(p.greeting).toBe("Good evening");
  });

  test("stalled task becomes the focus", () => {
    const t = task({ id: "s1", title: "Quiet one", stalled: true, days_quiet: 6,
      links: [{ source: "manual", kind: "note", meta: {}, created_at: "2026-10-10T00:00:00Z" }] });
    const p = programToday(dashFor({ weeks: [{ week: 1, roles: { CEO: [t] } }] }), NOW);
    expect(p.focus).toBeDefined();
    expect(p.focus!.task_id).toBe("s1");
    expect(p.focus!.reason).toContain("Quiet 6d");
  });

  test("unread thread becomes the focus when nothing is stalled", () => {
    const t = task({ id: "u1", title: "Thread task", unread: true,
      links: [{ source: "email-imap", kind: "thread", label: "Re: Terms",
                meta: { unseen: 2, last_from: "a@b.co" }, created_at: "2026-10-23T10:00:00Z" }] });
    const p = programToday(dashFor({ weeks: [{ week: 1, roles: { CEO: [t] } }] }), NOW);
    expect(p.focus!.task_id).toBe("u1");
    expect(p.focus!.reason).toContain("2 unread");
  });

  test("otherwise the next open task is the focus", () => {
    const p = programToday(
      dashFor({ weeks: [{ week: 1, roles: { CEO: [task({ id: "n1", title: "Next up" })] } }] }), NOW);
    expect(p.focus!.task_id).toBe("n1");
    expect(p.focus!.reason).toContain("next move");
  });

  test("all done → no focus, wins carry the page", () => {
    const t = task({ id: "d1", title: "Done", done: true, done_at: "2026-10-22T10:00:00Z" });
    const p = programToday(
      dashFor({
        weeks: [{ week: 1, roles: { CEO: [t] } }],
        overall: { tasks_done: 1, tasks_total: 1, pct: 100 },
      }), NOW);
    expect(p.focus).toBeNull();
    expect(p.wins.length).toBeGreaterThan(0);
    expect(p.wins[0]).toContain("1 of 1 tasks done");
  });

  test("line leads with wins, never shames an empty board", () => {
    const p = programToday(dashFor(), NOW);
    expect(p.line).toContain("first win is one task away");
    expect(p.line).not.toContain("0 of 0");
  });
});
