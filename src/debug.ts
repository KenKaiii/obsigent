export type DebugLogEntry = Readonly<{
  id: number;
  runId: string;
  scope: string;
  event: string;
  at: string;
  data?: Record<string, unknown>;
}>;

let nextLogId = 0;
let debugEnabled = false;
const entries: DebugLogEntry[] = [];

export function createRunId(prefix: string): string {
  nextLogId += 1;
  return `${prefix}-${Date.now().toString(36)}-${nextLogId}`;
}

export function setDebugEnabled(enabled: boolean): void {
  debugEnabled = enabled;
}

export function isDebugEnabled(): boolean {
  return debugEnabled;
}

export function logDebug(
  enabled: boolean,
  runId: string,
  scope: string,
  event: string,
  data?: Record<string, unknown>,
): void {
  if (!enabled && !debugEnabled) {
    return;
  }

  const entry: DebugLogEntry = {
    id: ++nextLogId,
    runId,
    scope,
    event,
    at: new Date().toISOString(),
    ...(data ? { data } : {}),
  };
  entries.push(entry);
  if (entries.length > 80) {
    entries.splice(0, entries.length - 80);
  }

  console.info("[obsigent]", entry);
}

export function getDebugEntries(): readonly DebugLogEntry[] {
  return entries;
}

export function formatDebugEntries(): string {
  return entries
    .map((entry) => {
      const data = entry.data ? ` ${JSON.stringify(entry.data)}` : "";
      return `${entry.id} ${entry.at} ${entry.runId} ${entry.scope}:${entry.event}${data}`;
    })
    .join("\n");
}
