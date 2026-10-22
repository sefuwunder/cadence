// Cadence API tests — bun test (single file; bun shares globalThis across files).
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createApp } from "../src/server.ts";
import { connectors } from "../src/connectors/index.ts";
import { _test as imapTest } from "../src/connectors/email-imap.ts";
import { keyIsValid } from "../src/connectors/webhook.ts";
import { listGoaMailAccounts, getGoaCredentials, goaImapCfg, goaAvailable } from "../src/goa.ts";

let app: ReturnType<typeof createApp>;
let tmp: string;
let seedPbId = "";
let runId = "";
let kpiId = "";
let taskId = "";

async function call(method: string, path: string, body?: any) {
  const res = await app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
const today = () => new Date().toISOString().slice(0, 10);

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "cadence-test-"));
  app = createApp({ dbPath: join(tmp, "test.db") });
});
afterAll(() => {
  app.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("seed + playbooks", () => {
  test("seed playbook exists on fresh db", async () => {
    const { status, data } = await call("GET", "/api/playbooks");
    expect(status).toBe(200);
    expect(data.length).toBe(1);
    expect(data[0].name).toBe("30-Day Sprint — $60k & 20 SQLs");
    seedPbId = data[0].id;
  });

  test("playbook CRUD", async () => {
    const created = await call("POST", "/api/playbooks", {
      name: "Test PB", description: "d",
      weeks: { weeks: [{ theme: "W1", roles: { CEO: ["a"] } }], kpis: [] },
    });
    expect(created.status).toBe(201);
    const id = created.data.id;
    const got = await call("GET", `/api/playbooks/${id}`);
    expect(got.status).toBe(200);
    expect(got.data.weeks_json.weeks[0].theme).toBe("W1");
    const upd = await call("PUT", `/api/playbooks/${id}`, { name: "Test PB2" });
    expect(upd.status).toBe(200);
    const del = await call("DELETE", `/api/playbooks/${id}`);
    expect(del.status).toBe(200);
    expect((await call("GET", `/api/playbooks/${id}`)).status).toBe(404);
  });

  test("playbook create requires name", async () => {
    expect((await call("POST", "/api/playbooks", {})).status).toBe(400);
  });
});

describe("runs + dashboard", () => {
  test("create run instantiates tasks and kpis", async () => {
    const { status, data } = await call("POST", "/api/runs", {
      playbook_id: seedPbId, name: "Sprint 1", start_date: today(),
    });
    expect(status).toBe(201);
    runId = data.id;
    const dash = await call("GET", `/api/runs/${runId}`);
    expect(dash.status).toBe(200);
    expect(dash.data.weeks.length).toBe(4);
    expect(dash.data.kpis.length).toBe(5);
    expect(dash.data.overall.tasks_total).toBe(38);
    expect(dash.data.overall.tasks_done).toBe(0);
    expect(dash.data.overall.pct).toBe(0);
    expect(dash.data.current_week).toBe(1);
    // kpi names + targets from seed
    const sqls = dash.data.kpis.find((k: any) => k.name === "SQLs");
    expect(sqls.targets).toEqual([0, 10, 18, 20]);
    kpiId = sqls.id;
    taskId = dash.data.weeks[0].roles.CEO[0].id;
  });

  test("runs list shows progress", async () => {
    const { data } = await call("GET", "/api/runs");
    expect(data.length).toBe(1);
    expect(data[0].pct).toBe(0);
  });

  test("task toggle flips done state", async () => {
    const t1 = await call("POST", `/api/runs/${runId}/tasks/${taskId}/toggle`);
    expect(t1.status).toBe(200);
    expect(t1.data.done).toBe(true);
    const dash = await call("GET", `/api/runs/${runId}`);
    expect(dash.data.overall.tasks_done).toBe(1);
    expect(dash.data.weeks[0].roles.CEO[0].done).toBe(true);
    const t2 = await call("POST", `/api/runs/${runId}/tasks/${taskId}/toggle`);
    expect(t2.data.done).toBe(false);
  });

  test("toggle unknown task 404s", async () => {
    expect((await call("POST", `/api/runs/${runId}/tasks/nope/toggle`)).status).toBe(404);
  });

  test("metric entries feed dashboard math", async () => {
    const e1 = await call("POST", `/api/kpis/${kpiId}/entries`, {
      date: today(), value: 7, note: "week push",
    });
    expect(e1.status).toBe(201);
    const dash = await call("GET", `/api/runs/${runId}`);
    const sqls = dash.data.kpis.find((k: any) => k.id === kpiId);
    expect(sqls.actuals[0]).toBe(7);
    expect(sqls.total_actual).toBe(7);
    expect(sqls.recent[0].source).toBe("manual");
    expect(dash.data.activity[0].type).toBe("metric");
  });

  test("entry validation", async () => {
    expect((await call("POST", `/api/kpis/${kpiId}/entries`, { date: "bad", value: 1 })).status).toBe(400);
    expect((await call("POST", `/api/kpis/${kpiId}/entries`, { date: today(), value: "x" })).status).toBe(400);
    expect((await call("POST", `/api/kpis/nope/entries`, { date: today(), value: 1 })).status).toBe(404);
  });

  test("run update + delete cascade", async () => {
    const upd = await call("PUT", `/api/runs/${runId}`, { status: "paused" });
    expect(upd.status).toBe(200);
    const del = await call("DELETE", `/api/runs/${runId}`);
    expect(del.status).toBe(200);
    expect((await call("GET", `/api/runs/${runId}`)).status).toBe(404);
    // re-create for later suites
    const r = await call("POST", "/api/runs", { playbook_id: seedPbId, start_date: today() });
    runId = r.data.id;
    const dash = await call("GET", `/api/runs/${runId}`);
    kpiId = dash.data.kpis[0].id;
  });
});

describe("connectors", () => {
  test("registry lists the three built-ins", async () => {
    const { status, data } = await call("GET", "/api/connectors");
    expect(status).toBe(200);
    expect(data.map((c: any) => c.id).sort()).toEqual(["email-imap", "manual", "webhook"]);
    expect(connectors.size).toBe(3);
  });

  test("connector config save + read", async () => {
    const save = await call("POST", "/api/connectors/manual", { config: { a: 1 } });
    expect(save.status).toBe(200);
    const got = await call("GET", "/api/connectors/manual");
    expect(got.data.config).toEqual({ a: 1 });
    const list = await call("GET", "/api/connectors");
    expect(list.data.find((c: any) => c.id === "manual").configured).toBe(true);
  });

  test("unknown connector 404s", async () => {
    expect((await call("GET", "/api/connectors/nope")).status).toBe(404);
    expect((await call("POST", "/api/connectors/nope/sync", {})).status).toBe(404);
  });

  test("manual sync inserts nothing", async () => {
    const r = await call("POST", "/api/connectors/manual/sync", {
      kpi_id: kpiId, from: today(), to: today(),
    });
    expect(r.status).toBe(200);
    expect(r.data.inserted).toBe(0);
  });

  test("sync validates input", async () => {
    expect((await call("POST", "/api/connectors/manual/sync", { kpi_id: kpiId })).status).toBe(400);
    expect((await call("POST", "/api/connectors/manual/sync",
      { kpi_id: "nope", from: today(), to: today() })).status).toBe(404);
  });
});

describe("webhook", () => {
  const KEY = "test-key-123";
  test("key validation helper", () => {
    expect(keyIsValid({ keys: { [KEY]: { label: "x" } } }, KEY)).toBe(true);
    expect(keyIsValid({ keys: {} }, KEY)).toBe(false);
    expect(keyIsValid({}, KEY)).toBe(false);
  });

  test("hook writes entry with valid key", async () => {
    await call("POST", "/api/connectors/webhook", { config: { keys: { [KEY]: { label: "t" } } } });
    const r = await call("POST", `/api/hooks/${KEY}`, {
      kpi_id: kpiId, date: today(), value: 3, note: "crm push",
    });
    expect(r.status).toBe(201);
    const dash = await call("GET", `/api/runs/${runId}`);
    const k = dash.data.kpis.find((x: any) => x.id === kpiId);
    expect(k.recent[0].source).toBe("webhook");
    expect(k.recent[0].note).toBe("crm push");
  });

  test("hook rejects bad key and bad body", async () => {
    expect((await call("POST", "/api/hooks/wrong", {
      kpi_id: kpiId, date: today(), value: 1,
    })).status).toBe(401);
    expect((await call("POST", `/api/hooks/${KEY}`, { kpi_id: kpiId, date: "bad", value: 1 })).status).toBe(400);
  });
});

describe("email-imap helpers", () => {
  test("imapDate formats for SEARCH", () => {
    expect(imapTest.imapDate("2026-10-22")).toBe("22-Oct-2026");
    expect(() => imapTest.imapDate("nope")).toThrow();
  });
  test("internalDateToIso parses INTERNALDATE", () => {
    expect(imapTest.internalDateToIso("22-Oct-2026 10:00:00 +0000")).toBe("2026-10-22");
    expect(imapTest.internalDateToIso("5-Jan-2025 00:00:00 -0500")).toBe("2025-01-05");
    expect(imapTest.internalDateToIso("garbage")).toBe("");
  });
  test("resolveConfig demands credentials", async () => {
    const noGoa = {
      listGoaMailAccounts: async () => [] as any[],
      getGoaCredentials: async (_a: any) => { throw new Error("unused"); },
    };
    await expect(imapTest.resolveConfig({}, noGoa)).rejects.toThrow(/missing IMAP credentials/);
    const c = await imapTest.resolveConfig({ host: "h", user: "u", pass: "p" }, noGoa);
    expect(c.port).toBe(993);
    expect(c.auth).toBe("login");
  });
  test("resolveConfig: explicit config wins, GOA never consulted", async () => {
    let listed = false;
    const goaFns = {
      listGoaMailAccounts: async () => { listed = true; return [] as any[]; },
      getGoaCredentials: async (_a: any) => { throw new Error("unused"); },
    };
    const c = await imapTest.resolveConfig({ host: "h", user: "u", pass: "p" }, goaFns);
    expect(c.auth).toBe("login");
    expect(c.host).toBe("h");
    expect(listed).toBe(false);
  });
  test("resolveConfig: GOA absent/unreachable → human-readable error", async () => {
    const empty = {
      listGoaMailAccounts: async () => [] as any[],
      getGoaCredentials: async (_a: any) => { throw new Error("unused"); },
    };
    await expect(imapTest.resolveConfig({}, empty)).rejects.toThrow(/no GNOME Online Accounts mail account found/);
    const throwing = {
      listGoaMailAccounts: async (): Promise<any[]> => { throw new Error("boom"); },
      getGoaCredentials: async (_a: any) => { throw new Error("unused"); },
    };
    await expect(imapTest.resolveConfig({}, throwing)).rejects.toThrow(/no GNOME Online Accounts mail account found/);
  });
  test("sync without config fails with human message", async () => {
    const conn = connectors.get("email-imap")!;
    await expect(conn.sync({ from: today(), to: today(), config: {} })).rejects.toThrow(/missing IMAP credentials/);
  });
  test("normalizeSubject groups reply/forward variants", () => {
    const n = imapTest.normalizeSubject;
    const k = n("Delivery Kickoff");
    expect(k).toBe("delivery kickoff");
    expect(n("Re: Delivery Kickoff")).toBe(k);
    expect(n("RE: re: Fwd: delivery kickoff")).toBe(k);
    expect(n("Fw:  Delivery   Kickoff")).toBe(k);
    expect(n("[EXTERNAL] Re: Delivery Kickoff")).toBe(k);
    expect(n("Aw: Lieferung Start")).toBe("lieferung start");
    expect(n("Something else entirely")).not.toBe(k);
    expect(n("")).toBe("");
  });
  test("decodeHeader handles RFC 2047", () => {
    expect(imapTest.decodeHeader("=?UTF-8?B?RGVsaXZlcnkgS2lja29mZg==?=")).toBe("Delivery Kickoff");
    expect(imapTest.decodeHeader("plain subject")).toBe("plain subject");
  });
});

describe("goa", () => {
  const acctObj = (over: { acc?: any; mail?: any; ifaces?: string[] } = {}) => {
    const ifaces: Record<string, any> = {
      "org.gnome.OnlineAccounts.Account": {
        Id: "goa_account_1", ProviderType: "google", ProviderName: "Google",
        MailEnabled: true, PresentationIdentity: "user@gmail.com",
        ...(over.acc || {}),
      },
      "org.gnome.OnlineAccounts.Mail": {
        EmailAddress: "user@gmail.com", ImapHost: "imap.gmail.com",
        ImapUserName: "user@gmail.com", ImapUseSsl: true,
        ...(over.mail || {}),
      },
    };
    for (const i of over.ifaces || ["org.gnome.OnlineAccounts.OAuth2Based"]) ifaces[i] = {};
    return ifaces;
  };
  // Stub RunFn answering busctl --json=short calls by method name.
  const goaStub = (objects: Record<string, any>, extra: Record<string, any> = {}) =>
    async (_cmd: string, args: string[]) => {
      const method = args[6];
      if (method === "GetManagedObjects")
        return { code: 0, stdout: JSON.stringify({ type: "(a{oa{sa{sv}}})", data: [objects] }), stderr: "" };
      if (method === "EnsureCredentials")
        return { code: 0, stdout: JSON.stringify({ type: "()", data: [] }), stderr: "" };
      if (method === "GetAccessToken")
        return { code: 0, stdout: JSON.stringify({ type: "s", data: ["tok123"] }), stderr: "" };
      if (method === "GetPassword")
        return { code: 0, stdout: JSON.stringify({ type: "s", data: [extra.password || "pw456"] }), stderr: "" };
      throw new Error("unexpected D-Bus method: " + method);
    };

  test("listGoaMailAccounts honors MailEnabled/MailDisabled variants", async () => {
    const objects = {
      "/p/1": acctObj(),
      "/p/2": acctObj({ acc: { Id: "goa_account_2", MailDisabled: true, PresentationIdentity: "off@x.com" },
                         mail: { EmailAddress: "off@x.com" } }),
      "/p/3": { "org.gnome.OnlineAccounts.Account": { Id: "goa_account_3", MailEnabled: true } }, // no Mail iface
    };
    const accounts = await listGoaMailAccounts(goaStub(objects));
    expect(accounts.length).toBe(1);
    expect(accounts[0].email).toBe("user@gmail.com");
    expect(accounts[0].imapHost).toBe("imap.gmail.com");
    expect(accounts[0].oauth2).toBe(true);
  });

  test("getGoaCredentials: oauth2 path", async () => {
    const objects = { "/p/1": acctObj() };
    const [acct] = await listGoaMailAccounts(goaStub(objects));
    const creds = await getGoaCredentials(acct, goaStub(objects));
    expect(creds).toEqual({ user: "user@gmail.com", oauth2: true, token: "tok123" });
  });

  test("getGoaCredentials: passwordBased path", async () => {
    const objects = { "/p/1": acctObj({ ifaces: ["org.gnome.OnlineAccounts.PasswordBased"] }) };
    const [acct] = await listGoaMailAccounts(goaStub(objects));
    expect(acct.passwordBased).toBe(true);
    const creds = await getGoaCredentials(acct, goaStub(objects));
    expect(creds.user).toBe("user@gmail.com");
    expect(creds.oauth2).toBe(false);
    expect(creds.imapPassword).toBe("pw456");
  });

  test("getGoaCredentials: auth failure when EnsureCredentials fails", async () => {
    const run = async (_c: string, args: string[]) => {
      if (args[6] === "EnsureCredentials") return { code: 1, stdout: "", stderr: "org.freedesktop.DBus.Error.Failed" };
      throw new Error("unexpected");
    };
    const acct = (await listGoaMailAccounts(goaStub({ "/p/1": acctObj() })))[0];
    await expect(getGoaCredentials(acct, run)).rejects.toThrow(/re-authenticate in GNOME Settings/);
  });

  test("goaImapCfg maps SSL→993 and rejects STARTTLS", () => {
    const base: any = { email: "u@x.com", imapHost: "imap.x.com", imapUser: "u@x.com", imapSsl: true };
    expect(goaImapCfg(base)).toEqual({ host: "imap.x.com", port: 993, user: "u@x.com", secure: true });
    expect(() => goaImapCfg({ ...base, imapSsl: false })).toThrow(/STARTTLS/);
    expect(() => goaImapCfg({ ...base, imapHost: "" })).toThrow(/no IMAP host/);
  });

  test("goaAvailable is false when busctl is missing", async () => {
    const run = async () => { throw new Error("spawn busctl ENOENT"); };
    expect(await goaAvailable(run as any)).toBe(false);
  });
});

describe("xoauth2 + GOA-backed resolveConfig", () => {
  const oauthAcct: any = {
    objectPath: "/p/1", id: "goa_account_1", providerType: "google", providerName: "Google",
    email: "user@gmail.com", imapHost: "imap.gmail.com", imapUser: "user@gmail.com",
    imapSsl: true, imapTls: false, oauth2: true, passwordBased: false,
  };
  const oauthFns = {
    listGoaMailAccounts: async () => [oauthAcct],
    getGoaCredentials: async (_a: any) => ({ user: "user@gmail.com", oauth2: true, token: "tok123" }),
  };

  test("xoauth2Blob format", () => {
    const blob = imapTest.xoauth2Blob("user@gmail.com", "tok123");
    expect(Buffer.from(blob, "base64").toString("utf8"))
      .toBe("user=user@gmail.com\x01auth=Bearer tok123\x01\x01");
  });

  test("GOA OAuth2 account resolves to xoauth2", async () => {
    const c = await imapTest.resolveConfig({}, oauthFns as any);
    expect(c.host).toBe("imap.gmail.com");
    expect(c.port).toBe(993);
    expect(c.user).toBe("user@gmail.com");
    expect(c.pass).toBe("tok123");
    expect(c.auth).toBe("xoauth2");
    expect(c.goaId).toBe("goa_account_1");
  });

  test("GOA password account resolves to login", async () => {
    const fns = {
      listGoaMailAccounts: async () => [oauthAcct],
      getGoaCredentials: async (_a: any) => ({ user: "user@gmail.com", oauth2: false, imapPassword: "pw456" }),
    };
    const c = await imapTest.resolveConfig({}, fns as any);
    expect(c.auth).toBe("login");
    expect(c.pass).toBe("pw456");
  });

  test("goa_account selects by email (case-insensitive) or id", async () => {
    const a2 = { ...oauthAcct, id: "goa_account_2", email: "b@x.com", imapUser: "b@x.com" };
    const fns = {
      listGoaMailAccounts: async () => [oauthAcct, a2],
      getGoaCredentials: async (a: any) => ({ user: a.email, oauth2: false, imapPassword: "pw" }),
    };
    const byEmail = await imapTest.resolveConfig({ goa_account: "B@X.COM" }, fns as any);
    expect(byEmail.user).toBe("b@x.com");
    const byId = await imapTest.resolveConfig({ goa_account: "goa_account_1" }, fns as any);
    expect(byId.user).toBe("user@gmail.com");
    const first = await imapTest.resolveConfig({}, fns as any);
    expect(first.user).toBe("user@gmail.com");
    await expect(imapTest.resolveConfig({ goa_account: "nope@x.com" }, fns as any))
      .rejects.toThrow(/no GOA mail account matches/);
  });

  test("goa-accounts endpoint never 500s and has the right shape", async () => {
    const { status, data } = await call("GET", "/api/connectors/email-imap/goa-accounts");
    expect(status).toBe(200);
    expect(typeof data.available).toBe("boolean");
    expect(Array.isArray(data.accounts)).toBe(true);
    for (const a of data.accounts) {
      expect(typeof a.id).toBe("string");
      expect(typeof a.email).toBe("string");
      expect(typeof a.provider).toBe("string");
    }
  });
});

describe("task links", () => {
  let linkTaskId = "";
  let linkId = "";
  const dashTask = async () => {
    const d = await call("GET", `/api/runs/${runId}`);
    return d.data.weeks[0].roles.CEO[0];
  };

  test("tasks carry empty links[] in dashboard", async () => {
    const t = await dashTask();
    linkTaskId = t.id;
    expect(t.links).toEqual([]);
  });

  test("link CRUD round-trip", async () => {
    const created = await call("POST", `/api/runs/${runId}/tasks/${linkTaskId}/links`, {
      source: "email-imap", kind: "thread", ref: "delivery kickoff",
      label: "Re: Delivery Kickoff",
      meta: { from: "jane@acme.com", date: "2026-10-22", count: 4 },
    });
    expect(created.status).toBe(201);
    linkId = created.data.id;
    const t = await dashTask();
    expect(t.links.length).toBe(1);
    expect(t.links[0]).toMatchObject({
      source: "email-imap", kind: "thread", ref: "delivery kickoff", label: "Re: Delivery Kickoff",
    });
    expect(t.links[0].meta).toEqual({ from: "jane@acme.com", date: "2026-10-22", count: 4 });
    const del = await call("DELETE", `/api/links/${linkId}`);
    expect(del.status).toBe(204);
    expect((await dashTask()).links).toEqual([]);
  });

  test("link validation: label required, task must belong to run", async () => {
    expect((await call("POST", `/api/runs/${runId}/tasks/${linkTaskId}/links`,
      { source: "manual" })).status).toBe(400);
    expect((await call("POST", `/api/runs/${runId}/tasks/nope/links`,
      { label: "x" })).status).toBe(404);
    // task exists but in another run
    const r2 = await call("POST", "/api/runs", { playbook_id: seedPbId, start_date: today() });
    expect(r2.status).toBe(201);
    expect((await call("POST", `/api/runs/${r2.data.id}/tasks/${linkTaskId}/links`,
      { label: "x" })).status).toBe(404);
    await call("DELETE", `/api/runs/${r2.data.id}`);
  });

  test("webhook creates task links", async () => {
    const KEY = "test-key-123"; // configured in the webhook suite above
    const r = await call("POST", `/api/hooks/${KEY}`, {
      task_id: linkTaskId, kind: "thread", ref: "kickoff", label: "Delivery Kickoff",
    });
    expect(r.status).toBe(201);
    const t = await dashTask();
    expect(t.links.some((l: any) => l.source === "webhook" && l.label === "Delivery Kickoff")).toBe(true);
    await call("DELETE", `/api/links/${r.data.id}`);
  });

  test("webhook link rejects bad key / bad body", async () => {
    expect((await call("POST", "/api/hooks/wrong",
      { task_id: linkTaskId, label: "x" })).status).toBe(401);
    expect((await call("POST", "/api/hooks/test-key-123",
      { task_id: "nope", label: "x" })).status).toBe(404);
    expect((await call("POST", "/api/hooks/test-key-123",
      { task_id: linkTaskId })).status).toBe(400);
    // metric shape still works alongside
    expect((await call("POST", "/api/hooks/test-key-123",
      { kpi_id: kpiId, date: today(), value: 1 })).status).toBe(201);
  });

  test("thread search 400s when IMAP unconfigured", async () => {
    const r = await call("GET", "/api/connectors/email-imap/threads?q=kickoff");
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/missing IMAP credentials/);
    const empty = await call("GET", "/api/connectors/email-imap/threads");
    expect(empty.status).toBe(200);
    expect(empty.data.threads).toEqual([]);
  });
});
