// Browser helpers for the backend's `/api/v3/*` routes (Agora Conversational AI v3 preview).

export type V3List<T> = {
  data?: { count?: number; list?: T[] };
  has_more?: boolean;
  next_cursor?: string | null;
};

export type SessionStatus =
  | "IDLE"
  | "STARTING"
  | "RUNNING"
  | "STOPPING"
  | "STOPPED"
  | "FAILED";

export type SessionAnalysis = {
  status?: "pending" | "completed" | "failed" | "skipped";
  skip_reason?: string | null;
  complete_ts?: number | null;
  result?: Record<string, unknown> | null;
  error?: string | null;
};

export type SessionDetail = {
  agent_session_id: string;
  agent_name?: string;
  start_ts?: number;
  stop_ts?: number | null;
  status?: SessionStatus | string;
  message?: string | null;
  analysis?: SessionAnalysis | null;
};

export function apiError(value: unknown, fallback: string): string {
  if (typeof value !== "object" || value === null) return fallback;
  const body = value as Record<string, unknown>;
  const message = [body.error, body.detail, body.message, body.reason].find(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
  const reason =
    typeof body.reason === "string" && body.reason !== message
      ? body.reason
      : "";
  return message ? (reason ? `${message} — ${reason}` : message) : fallback;
}

export async function v3Fetch<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`/api/v3/${path}`, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    cache: "no-store",
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(apiError(data, `Agora v3 request failed (${response.status})`));
  }
  return data as T;
}

export function listItems<T>(value: unknown): T[] {
  const list = (value as V3List<T> | null)?.data?.list;
  return Array.isArray(list) ? list : [];
}

/** Fetches every page of a v3 list (the demo's projects are small). */
export async function v3ListAll<T>(resource: string, limit = 100): Promise<T[]> {
  const items: T[] = [];
  let cursor = "";
  for (let page = 0; page < 20; page += 1) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    const body = await v3Fetch<V3List<T>>(`${resource}?${query}`);
    items.push(...listItems<T>(body));
    if (!body?.has_more || !body.next_cursor) break;
    cursor = body.next_cursor;
  }
  return items;
}

export function formatTimestamp(value?: number | null): string {
  if (value == null) return "Not returned";
  const timestamp = value > 10_000_000_000 ? value : value * 1000;
  return new Date(timestamp).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function sessionIsFinal(status?: string): boolean {
  return status === "STOPPED" || status === "FAILED";
}
