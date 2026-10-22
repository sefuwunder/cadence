// Manual connector — the default. Metrics are entered by hand (or via the
// webhook connector). sync() is a deliberate no-op returning no entries.
export const connector = {
  id: "manual",
  name: "Manual entry",
  description: "Log metric values by hand in the KPIs tab. Sync does nothing.",
  async sync(_opts: { from: string; to: string; config: any }) {
    return [] as { date: string; value: number; note?: string }[];
  },
};
