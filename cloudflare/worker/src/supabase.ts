import type { Env } from "./types";

export class SupabaseRest {
  constructor(private readonly env: Env) {}

  async select<T>(table: string, query: URLSearchParams): Promise<T[]> {
    return this.request<T[]>(table, query, { method: "GET" });
  }

  async selectWithCount<T>(table: string, query: URLSearchParams): Promise<{ rows: T[]; total: number }> {
    const response = await this.fetch(table, query, { method: "GET", headers: { Prefer: "count=exact" } });
    const range = response.headers.get("Content-Range");
    const totalText = range?.split("/")[1];
    const rows = await response.json<T[]>();
    return { rows, total: totalText && totalText !== "*" ? Number(totalText) : rows.length };
  }

  async insert<T>(table: string, body: unknown): Promise<T[]> {
    return this.request<T[]>(table, new URLSearchParams(), {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(body)
    });
  }

  async update<T>(table: string, filters: URLSearchParams, body: unknown): Promise<T[]> {
    return this.request<T[]>(table, filters, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(body)
    });
  }

  async remove(table: string, filters: URLSearchParams): Promise<void> {
    await this.request<unknown>(table, filters, { method: "DELETE", headers: { Prefer: "return=minimal" } });
  }

  private async request<T>(table: string, query: URLSearchParams, init: RequestInit): Promise<T> {
    const response = await this.fetch(table, query, init);
    if (response.status === 204) return undefined as T;
    return response.json<T>();
  }

  private async fetch(table: string, query: URLSearchParams, init: RequestInit): Promise<Response> {
    const keyHeaders: Record<string, string> = { apikey: this.env.SUPABASE_SECRET_KEY };
    if (!this.env.SUPABASE_SECRET_KEY.startsWith("sb_secret_"))
      keyHeaders.Authorization = `Bearer ${this.env.SUPABASE_SECRET_KEY}`;
    const response = await fetch(`${this.env.SUPABASE_URL}/rest/v1/${encodeURIComponent(table)}?${query}`, {
      ...init,
      headers: {
        ...keyHeaders,
        "Content-Type": "application/json",
        ...(init.headers ?? {})
      }
    });
    if (!response.ok) throw new Error(`Supabase ${table} request failed (${response.status})`);
    return response;
  }
}

export function eq(value: string | number | boolean): string {
  return `eq.${String(value)}`;
}

export function camelize<T>(value: T): T {
  if (Array.isArray(value)) return value.map(camelize) as T;
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) result[key[0]!.toLowerCase() + key.slice(1)] = camelize(item);
    return result as T;
  }
  return value;
}
