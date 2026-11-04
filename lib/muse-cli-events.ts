/** Offline parsing of Muse CLI JSONL completion; no provider execution. */
export function readMuseTerminal(jsonl: string): string | null {
  if (jsonl.length > 200_000) return null;
  let terminal: string | null = null;
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { return null; }
    if (!value || typeof value !== "object") return null;
    const event = value as { payload_type?: unknown; payload?: { terminal?: unknown; text?: unknown } };
    if (event.payload_type === "run.terminal.completed") {
      if (terminal !== null || event.payload?.terminal !== "completed" || typeof event.payload.text !== "string" || event.payload.text.length > 8000) return null;
      terminal = event.payload.text;
    }
  }
  return terminal;
}
