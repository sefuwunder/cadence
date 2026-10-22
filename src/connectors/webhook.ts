// Webhook connector — inbound only. External systems POST metric values to
// /api/hooks/:key. sync() is a no-op; data arrives via HTTP, not polling.
//
// Config shape (stored in connector_cfg, editable in the UI):
//   { "keys": { "<random-key>": { "label": "CRM nightly push", "created": "2026-10-22" } } }
// Generate a key with: crypto.randomUUID(). Keep keys secret — anyone with a
// key can write metric entries.
export const connector = {
  id: "webhook",
  name: "Inbound webhook",
  description:
    "Receive metric values pushed from external systems via POST /api/hooks/:key.",
  async sync(_opts: { from: string; to: string; config: any }) {
    return [] as { date: string; value: number; note?: string }[];
  },
};

/** Validate a hook key against the stored webhook connector config. */
export function keyIsValid(config: any, key: string): boolean {
  return !!(
    config &&
    typeof config === "object" &&
    config.keys &&
    typeof config.keys === "object" &&
    config.keys[key]
  );
}
