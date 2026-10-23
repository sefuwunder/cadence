// Illiad ask handler — routes parsed intents to Cadence's data layer.
// Calls data functions directly (never HTTP). Write intents (log / done /
// create_task / sync) execute and report what changed. No destructive intents.

import type { Database } from "bun:sqlite";
import { parseIntent, matchKpiName, matchTask } from "./intents.ts";
import { analyzeRun, fmt, whole } from "./analyze.ts";
import { composeBrief, composeEncouragement } from "./brief.ts";
import { getDashboard, getStakeholders, syncRunFeeds } from "../server.ts";

const HELP = `I'm Illiad — I automate, analyze, and keep the state of play positive.

Try me:
- "Brief me" — the state-of-play brief
- "How are SQLs doing?" — KPI pacing (any KPI name works)
- "What's stalled?" — tasks gone quiet
- "Sync feeds" — pull replies into linked threads
- "Any new replies?" — unread thread activity
- "How's Acme?" — a stakeholder's threads and tasks
- "Log 5 discovery calls" — record a KPI number
- "Mark onboarding checklist done" — complete a task
- "Add task draft SOW week 2 for CRO" — create a task
- "Motivate me" — the real picture, grounded in numbers`;

const TZ = process.env.CADENCE_TZ || "America/New_York";
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });

function allTasks(dash: any): { id: string; title: string; done: boolean; week: number; role: string }[] {
  const out: { id: string; title: string; done: boolean; week: number; role: string }[] = [];
  for (const w of dash.weeks || []) {
    for (const [role, ts] of Object.entries(w.roles || {}) as [string, any[]][]) {
      for (const t of ts) out.push({ id: t.id, title: t.title, done: !!t.done, week: w.week, role });
    }
  }
  return out;
}

export async function askIlliad(
  db: Database,
  message: string,
  opts: { runId: string; threadFetcher?: (subject: string) => Promise<any[]> },
): Promise<{ reply: string; intent: string }> {
  const parsed = parseIntent(message);
  const dash = getDashboard(db, opts.runId);
  if (!dash) return { reply: "I can't find that run.", intent: parsed.intent };
  const kpiNames: string[] = dash.kpis.map((k: any) => k.name);
  const a = () => analyzeRun(dash);

  switch (parsed.intent) {
    case "brief":
      return { reply: composeBrief(dash), intent: "brief" };

    case "encourage":
      return { reply: composeEncouragement(dash), intent: "encourage" };

    case "help":
      return { reply: HELP, intent: "help" };

    case "kpi_status": {
      const slot = (parsed.slots.kpi || "").trim();
      const pacing = analyzeRun(dash).pacing;
      if (!slot) {
        const lines = pacing
          .filter((p) => p.status !== "no_target")
          .map((p) => `- *${p.name}*: ${fmt(p.actual)} of ${fmt(p.expected)} expected by now — ${p.status.replace("_", " ")}`);
        return {
          reply: lines.length
            ? `KPI pacing (week ${dash.current_week}):\n${lines.join("\n")}`
            : "No KPI targets set for this week yet.",
          intent: "kpi_status",
        };
      }
      const match = matchKpiName(slot, kpiNames);
      if (!match) {
        return {
          reply: `I don't track a KPI called "${slot}". Yours are: ${kpiNames.join(", ")}.`,
          intent: "kpi_status",
        };
      }
      const p = pacing.find((x) => x.name === match)!;
      const k = dash.kpis.find((x: any) => x.name === match);
      const total = `${fmt(k.total_actual)} of ${fmt(k.total_target)} total`;
      const detail = p.status === "no_target"
        ? `*${p.name}*: no target this week, ${fmt(p.actual)} logged so far (${total}).`
        : `*${p.name}*: ${fmt(p.actual)} of ${whole(p.expected)} expected by now — ${p.status.replace("_", " ")} (week target ${fmt(p.target)}, ${total}).`;
      return { reply: detail, intent: "kpi_status" };
    }

    case "stalled": {
      const stalled = analyzeRun(dash).stalled;
      if (!stalled.length) {
        return { reply: "Nothing stalled — every active task has recent feed activity.", intent: "stalled" };
      }
      const lines = stalled.slice(0, 5).map(
        (s) => `- "${s.title}" (${s.role}, W${s.week}) — quiet ${s.days_quiet}d`);
      return {
        reply: `Stalled tasks (no feed activity in 3+ days):\n${lines.join("\n")}` +
          (stalled.length > 5 ? `\n…plus ${stalled.length - 5} more.` : ""),
        intent: "stalled",
      };
    }

    case "sync": {
      try {
        const r = await syncRunFeeds(db, opts.runId, opts.threadFetcher);
        if (!r.threads) {
          return {
            reply: "No linked email threads to sync — link a thread from a task's feed first.",
            intent: "sync",
          };
        }
        return {
          reply: `Synced ${r.threads} thread${r.threads === 1 ? "" : "s"}, ` +
            `${r.new_replies} new ${r.new_replies === 1 ? "reply" : "replies"}.`,
          intent: "sync",
        };
      } catch (e: any) {
        return { reply: `Couldn't sync feeds: ${e?.message || "unknown error"}`, intent: "sync" };
      }
    }

    case "unread": {
      const un = analyzeRun(dash).unreadThreads;
      if (!un.length) {
        return { reply: "Inbox zero on linked threads — no unread replies.", intent: "unread" };
      }
      const lines = un.slice(0, 5).map(
        (u) => `- "${u.subject}" — ${u.unseen} new (task: ${u.taskTitle})`);
      return {
        reply: `Unread replies in linked threads:\n${lines.join("\n")}` +
          (un.length > 5 ? `\n…plus ${un.length - 5} more threads.` : ""),
        intent: "unread",
      };
    }

    case "stakeholder": {
      const who = (parsed.slots.who || "").trim().toLowerCase();
      const sh = getStakeholders(db, opts.runId);
      const hits = sh.filter((s: any) =>
        s.name.toLowerCase().includes(who) || s.email.toLowerCase().includes(who));
      if (!hits.length) {
        return {
          reply: `I don't see a stakeholder matching "${parsed.slots.who}".`,
          intent: "stakeholder",
        };
      }
      if (hits.length > 1) {
        return {
          reply: `Which one? ${hits.slice(0, 5).map((s: any) => `${s.name} <${s.email}>`).join("; ")}.`,
          intent: "stakeholder",
        };
      }
      const s = hits[0];
      const unreadN = s.threads.reduce((n: number, t: any) => n + (t.unseen || 0), 0);
      const latest = s.threads[0];
      return {
        reply: `*${s.name}* <${s.email}>: ${s.threads.length} thread${s.threads.length === 1 ? "" : "s"} ` +
          `across ${s.tasks.length} task${s.tasks.length === 1 ? "" : "s"}` +
          (latest ? `, latest "${latest.subject}"${latest.last_date ? ` (${latest.last_date})` : ""}` : "") +
          (unreadN > 0 ? ` — ${unreadN} unread ${unreadN === 1 ? "reply" : "replies"}.` : "."),
        intent: "stakeholder",
      };
    }

    case "log": {
      const value = Number(parsed.slots.value);
      if (!Number.isFinite(value)) {
        return { reply: "I need a number to log — e.g. \"log 5 discovery calls\".", intent: "log" };
      }
      const match = matchKpiName(parsed.slots.kpi || "", kpiNames);
      if (!match) {
        return {
          reply: `Which KPI? I track: ${kpiNames.join(", ")}.`,
          intent: "log",
        };
      }
      const k = dash.kpis.find((x: any) => x.name === match);
      db.run(
        "INSERT INTO metric_entries (id, kpi_id, date, value, source, note) VALUES (?, ?, ?, ?, 'illiad', '')",
        [crypto.randomUUID(), k.id, today(), value]);
      const d2 = getDashboard(db, opts.runId);
      const k2 = d2.kpis.find((x: any) => x.name === match);
      const w = d2.current_week - 1;
      const tgt = k2.targets[w] || 0;
      const nowAt = tgt > 0
        ? `Now at ${fmt(k2.actuals[w] || 0)} of ${fmt(tgt)} for week ${d2.current_week}.`
        : `No target set for week ${d2.current_week} — ${fmt(k2.actuals[w] || 0)} logged so far.`;
      return {
        reply: `Logged ${fmt(value)}${k.unit ? ` ${k.unit}` : ""} to *${match}* for ${today()}. ` + nowAt,
        intent: "log",
      };
    }

    case "done": {
      const query = (parsed.slots.task || "").trim();
      const res = matchTask(query, allTasks(dash));
      if (!res) {
        return { reply: `I couldn't find a task matching "${query}".`, intent: "done" };
      }
      if ("ambiguous" in res) {
        return {
          reply: `Which one?\n${res.ambiguous.map((t, i) => `${i + 1}. "${t.title}"`).join("\n")}`,
          intent: "done",
        };
      }
      const t = res.task;
      if (t.done) {
        return { reply: `"${t.title}" is already done.`, intent: "done" };
      }
      db.run("UPDATE tasks SET done = 1, done_at = ? WHERE id = ?",
        [new Date().toISOString(), t.id]);
      return { reply: `Done — "${t.title}" marked complete.`, intent: "done" };
    }

    case "create_task": {
      const title = (parsed.slots.title || "").trim();
      const week = Number(parsed.slots.week);
      const role = (parsed.slots.role || "").toUpperCase();
      const roles = ["CEO", "CRO", "CTO", "COO"];
      if (!title || !Number.isInteger(week) || week < 1 || week > dash.weeks.length || !roles.includes(role)) {
        return {
          reply: `Say it like: "add task draft the SOW week 2 for CRO" — title, week 1–${dash.weeks.length}, role ${roles.join("/")}.`,
          intent: "create_task",
        };
      }
      db.run("INSERT INTO tasks (id, run_id, week, role, title, done) VALUES (?, ?, ?, ?, ?, 0)",
        [crypto.randomUUID(), opts.runId, week, role, title]);
      return {
        reply: `Added "${title}" to week ${week} for ${role}.`,
        intent: "create_task",
      };
    }

    default:
      return {
        reply: "I didn't quite catch that. I can brief you (\"brief me\"), check KPIs " +
          "(\"how are SQLs doing\"), find stalled tasks, sync feeds, report unread replies, " +
          "look up stakeholders, log numbers (\"log 5 discovery calls\"), mark tasks done, " +
          "and add tasks. Try \"help\" for the full list.",
        intent: "fallback",
      };
  }
}
