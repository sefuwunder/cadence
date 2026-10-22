// Connector registry — auto-loads every connector module in this directory.
// A connector is any *.ts file (except index.ts) exporting:
//   export const connector = {
//     id: "my-source",            // unique, used as metric_entries.source
//     name: "My Source",         // display name
//     description: "...",        // one-liner for the UI
//     async sync({ from, to, config }) {
//       // from/to: "YYYY-MM-DD" (inclusive). config: saved connector_cfg.
//       // Return [{ date: "YYYY-MM-DD", value: number, note?: "..." }].
//       // Throw a plain Error with a human message on failure.
//     },
//   };
// See README.md in this directory for the full authoring guide.

import { readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

export interface ConnectorResult {
  date: string;
  value: number;
  note?: string;
}

export interface Connector {
  id: string;
  name: string;
  description: string;
  sync(opts: { from: string; to: string; config: any }): Promise<ConnectorResult[]>;
}

const dir = dirname(fileURLToPath(import.meta.url));

async function load(): Promise<Map<string, Connector>> {
  const reg = new Map<string, Connector>();
  for (const f of readdirSync(dir).sort()) {
    if (f === "index.ts" || !f.endsWith(".ts")) continue;
    const mod = await import(join(dir, f));
    const c = mod?.connector as Connector | undefined;
    if (!c || !c.id || typeof c.sync !== "function") {
      console.warn(`[connectors] skipping ${f}: no valid \`connector\` export`);
      continue;
    }
    if (reg.has(c.id)) {
      console.warn(`[connectors] duplicate id "${c.id}" in ${f}; keeping first`);
      continue;
    }
    reg.set(c.id, c);
  }
  return reg;
}

// Loaded once at startup; the import waits for it.
export const connectors: Map<string, Connector> = await load();

export function getConnector(id: string): Connector | undefined {
  return connectors.get(id);
}
