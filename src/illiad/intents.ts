// Illiad intent router — deterministic NL parsing for the C-suite assistant.
// Keyword/regex rules over the playbook domain (SQLs, discovery calls, anchor
// packages, seats, outreach). No AI, no randomness: same input → same intent.
// Slot resolution (KPI names, task titles, stakeholders) happens in ask.ts
// against live data; the parser only extracts raw slot text.

export type IlliadIntent =
  | "brief" | "kpi_status" | "stalled" | "sync" | "unread" | "stakeholder"
  | "log" | "done" | "create_task" | "encourage" | "help" | "fallback";

export interface ParsedIntent {
  intent: IlliadIntent;
  slots: Record<string, string>;
  confidence: number;
  raw: string;
}

const mk = (intent: IlliadIntent, slots: Record<string, string> = {}, confidence = 1): ParsedIntent =>
  ({ intent, slots, confidence, raw: "" });

/** Normalize for matching only — slot text is extracted from the raw input. */
export function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[''']/g, "") // "how's" → "hows" (keeps one token)
    .replace(/[^a-z0-9\s/$.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseIntent(rawInput: string): ParsedIntent {
  const raw = String(rawInput || "");
  const text = norm(raw);
  if (!text) return { ...mk("fallback", {}, 0), raw };

  // help
  if (/\bhelp\b/.test(text) || text === "?" || /\bwhat can you do\b/.test(text)) {
    return { ...mk("help"), raw };
  }

  // log: "log 5 discovery calls" / "log 12.5 seats"
  let m = text.match(/^log\s+(\d+(?:\.\d+)?)\s+(.+)$/);
  if (m) return { ...mk("log", { value: m[1], kpi: m[2].trim() }), raw };

  // done: "mark X done", "complete X", "X is done"
  m = text.match(/^(?:mark|complete)\s+(.+?)\s+done$/)
    || text.match(/^mark\s+(.+?)\s+as\s+done$/)
    || text.match(/^(?:complete|finish)\s+(.+)$/);
  if (m) return { ...mk("done", { task: m[1].trim() }), raw };
  m = text.match(/^(.+?)\s+is\s+done$/);
  if (m && m[1].trim().length > 2) return { ...mk("done", { task: m[1].trim() }), raw };

  // create_task: "add task <title> week <n> for <ROLE>"
  m = text.match(/^add\s+task\s+(.+?)\s+week\s+(\d+)\s+(?:for|to)\s+([a-z]+)$/);
  if (m) {
    return { ...mk("create_task", { title: m[1].trim(), week: m[2], role: m[3].toUpperCase() }), raw };
  }

  // kpi_status: mentions kpis, or "how are <kpi> doing/pacing"
  const howDoing = text.match(/\bhow\s+(?:are|is)\s+(.+?)\s+(doing|pacing)\b/);
  const howSlot = howDoing ? howDoing[1] : "";
  const isWe = ["we", "things", "i", "it"].includes(howSlot);
  if (/\bkpis?\b/.test(text) || (howDoing && !isWe)) {
    const slot = !isWe && howSlot ? howSlot.trim() : "";
    const kpiWord = text.match(/^(.+?)\s+kpis?\b/) || text.match(/\bkpis?\s+(?:for|on)\s+(.+)$/);
    return { ...mk("kpi_status", { kpi: slot || (kpiWord ? kpiWord[1].trim() : "") }), raw };
  }

  // stalled
  if (/\bstalled?\b/.test(text) || /\bstuck\b/.test(text) || /\bneeds attention\b/.test(text)) {
    return { ...mk("stalled", {}, 0.9), raw };
  }

  // sync
  if (/\bsync\b/.test(text) || /\brefresh\b/.test(text)
      || /\bcheck\s+(?:my\s+|the\s+)?(?:email|mail|inbox|feeds?)\b/.test(text)) {
    return { ...mk("sync", {}, 0.9), raw };
  }

  // unread
  if (/\bunread\b/.test(text) || /\bnew replies?\b/.test(text)
      || /\bany new\b/.test(text) || /\bunseen\b/.test(text)) {
    return { ...mk("unread", {}, 0.9), raw };
  }

  // stakeholder: "hows acme", "update on acme", "tell me about acme"
  m = text.match(/^(?:hows|how is|update on|tell me about|whats (?:new|happening) with)\s+(.+)$/);
  if (m && m[1].trim() !== "it" && m[1].trim() !== "things") {
    return { ...mk("stakeholder", { who: m[1].trim() }), raw };
  }

  // brief
  if (/\bbrief\b/.test(text) || /\bhow are we doing\b/.test(text)
      || /\bhow'?s it going\b/.test(text) || /\bstate of play\b/.test(text)
      || /\brundown\b/.test(text) || text === "status"
      || /\bstatus update\b/.test(text) || /\bgive me an update\b/.test(text)) {
    return { ...mk("brief", {}, 0.9), raw };
  }

  // encourage
  if (/\bmotivat/.test(text) || /\bpep talk\b/.test(text) || /\bencourage/.test(text)
      || /\bkeep (?:me|us) going\b/.test(text) || /\breal picture\b/.test(text)
      || /\bhow am i doing\b/.test(text) || /\bi need (?:a |some )?(?:push|motivation|boost)\b/.test(text)) {
    return { ...mk("encourage", {}, 0.9), raw };
  }

  return { ...mk("fallback", {}, 0), raw };
}

// ---------- fuzzy slot helpers ----------

/** Canonical seed KPI names → match aliases (lowercase). Unknown KPI names
 *  fall back to plain substring matching in matchKpiName. */
const KPI_ALIASES: Record<string, string[]> = {
  "outbound emails/dms": ["outbound", "emails", "dms", "outreach", "email"],
  "discovery calls": ["discovery", "calls", "discovery calls"],
  "sqls": ["sql", "sqls", "leads", "qualified", "qualified leads"],
  "closed packages": ["packages", "closed", "anchor", "anchor packages", "deals", "closed won"],
  "active seats": ["seats", "active seats", "licenses"],
};

/** Best-matching KPI name for free text, or null. Longest alias wins. */
export function matchKpiName(text: string, names: string[]): string | null {
  const t = ` ${norm(text)} `;
  let best: string | null = null;
  let bestScore = 0;
  for (const name of names) {
    const key = name.toLowerCase();
    const cands = [key, ...(KPI_ALIASES[key] || [])];
    for (const c of cands) {
      if (c.length >= 3 && t.includes(c)) {
        if (c.length > bestScore) { bestScore = c.length; best = name; }
      }
    }
  }
  return best;
}

const TASK_STOP = new Set("the,a,an,to,for,of,and,on,in,task,tasks,my,our".split(","));

function taskTokens(s: string): string[] {
  return norm(s).split(" ").filter((w) => w && !TASK_STOP.has(w));
}

/** Fuzzy task match by token recall. Prefers incomplete tasks. Returns the
 *  task, an ambiguity list, or null. */
export function matchTask(
  query: string,
  tasks: { id: string; title: string; done: boolean }[],
): { task: { id: string; title: string; done: boolean } }
  | { ambiguous: { id: string; title: string; done: boolean }[] }
  | null {
  const qt = taskTokens(query);
  if (!qt.length) return null;
  const score = (title: string) => {
    const tt = new Set(taskTokens(title));
    const hit = qt.filter((w) => tt.has(w)).length;
    return hit / qt.length;
  };
  const pool = tasks.filter((t) => !t.done);
  const rank = (list: typeof tasks) =>
    list.map((t) => ({ t, s: score(t.title) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);
  let ranked = rank(pool.length ? pool : tasks);
  if (!ranked.length || ranked[0].s < 0.5) return null;
  const top = ranked.filter((x) => x.s >= ranked[0].s - 0.15).slice(0, 3);
  if (top.length > 1) return { ambiguous: top.map((x) => x.t) };
  return { task: top[0].t };
}
