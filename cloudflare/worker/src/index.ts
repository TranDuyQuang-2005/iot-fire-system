import { createJwt, principalFromRequest, verifyAspNetIdentityPassword } from "./auth";
import { ensureDevice, persistEvent } from "./data";
import { sendPush } from "./fcm";
import { RealtimeCoordinator } from "./realtime";
import { camelize, eq, SupabaseRest } from "./supabase";
import type { AuthPrincipal, CommandResponse, DeviceEvent, Env, RuntimeState, Telemetry } from "./types";
import { constantTimeEqual, parseCommandResponse, parseEvent, parseTelemetry, validDeviceId } from "./validation";

export { RealtimeCoordinator };

const MAX_BODY_BYTES = 64 * 1024;
const ALLOWED_COMMANDS = new Set(["FAN_ON", "FAN_OFF", "PUMP_ON", "PUMP_OFF", "BUZZER_ON", "BUZZER_OFF", "SET_AUTO_MODE", "SET_MANUAL_MODE", "RESET_ALARM"]);

function corsHeaders(request: Request, env: Env): HeadersInit {
  const origin = request.headers.get("Origin");
  const allowed = new Set(env.ALLOWED_ORIGINS.split(",").map(value => value.trim()).filter(Boolean));
  if (!origin || !allowed.has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Expose-Headers": "X-Total-Count",
    Vary: "Origin"
  };
}

function json(request: Request, env: Env, body: unknown, status = 200, extra: HeadersInit = {}): Response {
  return Response.json(body, { status, headers: { ...corsHeaders(request, env), ...extra } });
}

async function readJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
  try { return JSON.parse(text) as unknown; } catch { throw new HttpError(400, "Malformed JSON"); }
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function realtimeStub(env: Env, name: string): DurableObjectStub {
  return env.REALTIME.get(env.REALTIME.idFromName(name));
}

async function requireAuth(request: Request, env: Env): Promise<AuthPrincipal> {
  const principal = await principalFromRequest(request, env);
  if (!principal) throw new HttpError(401, "Unauthorized");
  return principal;
}

export async function webhook(request: Request, env: Env, type: "telemetry" | "event" | "command-response"): Promise<Response> {
  const supplied = request.headers.get("X-EMQX-Webhook-Secret") ?? "";
  if (!supplied || !constantTimeEqual(supplied, env.EMQX_WEBHOOK_SECRET)) throw new HttpError(401, "Invalid webhook authentication");
  const body = await readJson(request);
  if (type === "telemetry") {
    const telemetry = parseTelemetry(body);
    if (!telemetry) throw new HttpError(400, "Invalid telemetry payload");
    const response = await realtimeStub(env, telemetry.deviceId).fetch("https://do/telemetry", { method: "POST", body: JSON.stringify(telemetry) });
    if (!response.ok) throw new HttpError(502, "Realtime coordinator rejected telemetry");
    return new Response(response.body, { status: response.status, headers: { "Content-Type": "application/json" } });
  }
  if (type === "event") {
    const event = parseEvent(body);
    if (!event) throw new HttpError(400, "Invalid event payload");
    const saved = await persistEvent(env, event);
    const realtime = { type: event.eventType === "FIRE_DETECTED" ? "FireDetected" : "AlertCreated", data: { ...event, eventId: String(saved.id), createdAt: new Date().toISOString() } };
    await realtimeStub(env, event.deviceId).fetch("https://do/event", { method: "POST", body: JSON.stringify(realtime) });
    if (saved.pushType) await sendPush(env, saved.pushType, String(saved.id));
    return Response.json({ accepted: true, eventId: saved.id });
  }
  const command = parseCommandResponse(body);
  if (!command) throw new HttpError(400, "Invalid command response payload");
  await handleCommandResponse(env, command);
  return Response.json({ accepted: true });
}

export async function handleCommandResponse(env: Env, response: CommandResponse): Promise<void> {
  const db = new SupabaseRest(env);
  const normalized = response.status.toUpperCase() === "EXECUTED" ? "ACKNOWLEDGED" : response.status.toUpperCase();
  if (!["ACKNOWLEDGED", "REJECTED", "FAILED"].includes(normalized)) throw new HttpError(400, "Invalid command status");
  const query = new URLSearchParams({ select: "Id,DeviceId", CommandId: eq(response.commandId), limit: "1" });
  const rows = await db.select<{ Id: number; DeviceId: number }>("Commands", query);
  if (!rows[0]) throw new HttpError(404, "Unknown command");
  const device = await ensureDevice(env, response.deviceId);
  if (device.Id !== rows[0].DeviceId) throw new HttpError(409, "Command device mismatch");
  await db.update("Commands", new URLSearchParams({ Id: eq(rows[0].Id) }), {
    Status: normalized, Reason: response.reason ?? response.message ?? null, ExecutedAt: new Date().toISOString()
  });
  await realtimeStub(env, response.deviceId).fetch("https://do/command-response", {
    method: "POST",
    body: JSON.stringify({ type: "CommandStatusChanged", data: { ...response, status: normalized, reason: response.reason ?? response.message ?? null } })
  });
}

async function login(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request) as Record<string, unknown>;
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!/^[A-Za-z0-9_.@-]{1,100}$/.test(username) || password.length < 1 || password.length > 200) throw new HttpError(400, "Invalid credentials format");
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const limiter = realtimeStub(env, `auth:${ip}:${username.toLowerCase()}`);
  const limitResponse = await limiter.fetch("https://do/rate-limit", { method: "POST", body: JSON.stringify({ now: Date.now() }) });
  const limit = await limitResponse.json<{ allowed: boolean; retryAfter: number }>();
  if (!limit.allowed) throw new HttpError(429, `Too many login attempts; retry in ${limit.retryAfter}s`);
  const db = new SupabaseRest(env);
  const users = await db.select<{ Username: string; PasswordHash: string; Role: string }>("Users", new URLSearchParams({ select: "Username,PasswordHash,Role", Username: eq(username), limit: "1" }));
  const user = users[0];
  if (!user || !await verifyAspNetIdentityPassword(user.PasswordHash, password)) throw new HttpError(401, "Invalid username or password");
  const jwt = await createJwt(env, { username: user.Username, role: user.Role });
  return Response.json({ accessToken: jwt.token, expiresIn: jwt.expiresIn, role: user.Role, username: user.Username });
}

export async function publishCommand(env: Env, deviceId: string, commandId: string, command: string): Promise<void> {
  const response = await fetch(`${env.EMQX_API_URL.replace(/\/$/, "")}/api/v5/publish`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${env.EMQX_API_KEY}:${env.EMQX_API_SECRET}`)}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ topic: `iot/fire/device/${deviceId}/command`, payload: JSON.stringify({ commandId, command }), qos: 1, retain: false })
  });
  if (!response.ok) throw new Error(`EMQX publish failed (${response.status})`);
}

async function sendCommand(request: Request, env: Env, principal: AuthPrincipal, deviceId: string, forcedCommand?: string): Promise<Response> {
  if (principal.role !== "ADMIN") throw new HttpError(403, "Admin role required");
  if (!validDeviceId(deviceId)) throw new HttpError(400, "Invalid deviceId");
  const body = forcedCommand ? {} : await readJson(request) as Record<string, unknown>;
  const command = (forcedCommand ?? (typeof body.command === "string" ? body.command : "")).trim().toUpperCase();
  if (!ALLOWED_COMMANDS.has(command)) throw new HttpError(400, "Invalid command");
  const runtimeResponse = await realtimeStub(env, deviceId).fetch("https://do/status");
  const runtime = await runtimeResponse.json<RuntimeState | null>();
  const offlineMs = Number(env.DEVICE_OFFLINE_SECONDS || "15") * 1000;
  if (!runtime?.online || Date.now() - runtime.lastTelemetryAt >= offlineMs) throw new HttpError(409, "DEVICE_OFFLINE");
  const device = await ensureDevice(env, deviceId);
  const state = runtime.latest?.state ?? device.CurrentState;
  const mode = runtime.latest?.mode ?? device.CurrentMode;
  if (command === "FAN_ON" && ["WARNING", "HIGH_RISK", "FIRE", "SUPPRESSING"].includes(state)) throw new HttpError(409, "FAN_ON_NOT_ALLOWED_DURING_SAFETY_STATE");
  if (command === "PUMP_OFF" && ["FIRE", "SUPPRESSING"].includes(state)) throw new HttpError(409, "PUMP_OFF_NOT_ALLOWED_DURING_FIRE");
  if (command === "PUMP_ON" && state !== "NORMAL") throw new HttpError(409, "PUMP_ON_ONLY_ALLOWED_IN_NORMAL");
  if ((command === "BUZZER_ON" || command === "BUZZER_OFF") && mode !== "MANUAL") throw new HttpError(409, "BUZZER_MANUAL_MODE_REQUIRED");
  if (command === "BUZZER_OFF" && ["HIGH_RISK", "FIRE", "SUPPRESSING", "POST_FIRE"].includes(state)) throw new HttpError(409, "BUZZER_OFF_NOT_ALLOWED_DURING_SAFETY_STATE");
  const db = new SupabaseRest(env);
  const commandId = crypto.randomUUID().replaceAll("-", "");
  const inserted = await db.insert<{ Id: number }>("Commands", {
    CommandId: commandId, DeviceId: device.Id, CommandType: command, Status: "SENT", Reason: null,
    RequestedBy: principal.username, RequestedAt: new Date().toISOString(), ExecutedAt: null
  });
  try {
    await publishCommand(env, deviceId, commandId, command);
    return Response.json({ commandId, status: "SENT", commandType: command }, { status: 202 });
  } catch {
    if (inserted[0]) await db.update("Commands", new URLSearchParams({ Id: eq(inserted[0].Id) }), { Status: "FAILED", Reason: "MQTT broker is unavailable" });
    throw new HttpError(503, "MQTT unavailable");
  }
}

async function api(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === "/api/auth/login" && request.method === "POST") return login(request, env);
  const principal = await requireAuth(request, env);
  if (url.pathname === "/api/auth/me" && request.method === "GET") return Response.json(principal);
  const db = new SupabaseRest(env);
  if (url.pathname === "/api/devices" && request.method === "GET")
    return Response.json(camelize(await db.select("Devices", new URLSearchParams({ select: "*", order: "DeviceCode.asc" }))));
  const deviceMatch = url.pathname.match(/^\/api\/devices\/([^/]+)(?:\/(latest|readings|commands|mode|reset-alarm))?$/);
  if (deviceMatch) {
    const deviceId = decodeURIComponent(deviceMatch[1]!); const action = deviceMatch[2];
    if (!validDeviceId(deviceId)) throw new HttpError(400, "Invalid deviceId");
    if (action === "commands" && request.method === "POST") return sendCommand(request, env, principal, deviceId);
    if (action === "mode" && request.method === "PUT") {
      const body = await readJson(request) as Record<string, unknown>;
      const mode = String(body.mode ?? "").toUpperCase();
      if (mode !== "AUTO" && mode !== "MANUAL") throw new HttpError(400, "Mode must be AUTO or MANUAL");
      return sendCommand(request, env, principal, deviceId, mode === "AUTO" ? "SET_AUTO_MODE" : "SET_MANUAL_MODE");
    }
    if (action === "reset-alarm" && request.method === "POST") return sendCommand(request, env, principal, deviceId, "RESET_ALARM");
    const devices = await db.select<Record<string, unknown>>("Devices", new URLSearchParams({ select: "*", DeviceCode: eq(deviceId), limit: "1" }));
    const device = devices[0]; if (!device) throw new HttpError(404, "Device not found");
    if (!action && request.method === "GET") return Response.json(camelize(device));
    if (action === "latest" && request.method === "GET") {
      const readings = await db.select("SensorReadings", new URLSearchParams({ select: "*", DeviceId: eq(Number(device.Id)), order: "ReceivedAt.desc", limit: "1" }));
      return Response.json(camelize({ device, reading: readings[0] ?? null }));
    }
    if (action === "readings" && request.method === "GET") {
      const page = Math.max(1, Number(url.searchParams.get("page") ?? "1")); const pageSize = Math.min(500, Math.max(1, Number(url.searchParams.get("pageSize") ?? "100")));
      const query = new URLSearchParams({ select: "*", DeviceId: eq(Number(device.Id)), order: "ReceivedAt.desc", offset: String((page - 1) * pageSize), limit: String(pageSize) });
      const from = url.searchParams.get("from"); const to = url.searchParams.get("to");
      if (from) query.set("ReceivedAt", `gte.${checkedDate(from)}`);
      if (to) query.append("ReceivedAt", `lte.${checkedDate(to)}`);
      const result = await db.selectWithCount("SensorReadings", query);
      return Response.json(camelize({ total: result.total, page, pageSize, items: result.rows }));
    }
  }
  if ((url.pathname === "/api/events" || url.pathname === "/api/alerts") && request.method === "GET") {
    const table = url.pathname.endsWith("events") ? "Events" : "Alerts";
    const page = Math.max(1, Number(url.searchParams.get("page") ?? "1"));
    const pageSize = Math.min(500, Math.max(1, Number(url.searchParams.get("pageSize") ?? "100")));
    const query = new URLSearchParams({ select: "*,Device:Devices!inner(*)", order: "CreatedAt.desc", offset: String((page - 1) * pageSize), limit: String(pageSize) });
    const deviceId = url.searchParams.get("deviceId"); const severity = url.searchParams.get("severity");
    if (deviceId) { if (!validDeviceId(deviceId)) throw new HttpError(400, "Invalid deviceId"); query.set("Device.DeviceCode", eq(deviceId)); }
    if (severity) query.set("Severity", eq(severity.slice(0, 30)));
    if (table === "Events" && url.searchParams.get("eventType")) query.set("EventType", eq(url.searchParams.get("eventType")!.slice(0, 100)));
    if (table === "Alerts" && url.searchParams.has("acknowledged")) {
      const acknowledged = url.searchParams.get("acknowledged"); if (acknowledged !== "true" && acknowledged !== "false") throw new HttpError(400, "Invalid acknowledged filter");
      query.set("IsAcknowledged", eq(acknowledged === "true"));
    }
    if (url.searchParams.get("from")) query.set("CreatedAt", `gte.${checkedDate(url.searchParams.get("from")!)}`);
    if (url.searchParams.get("to")) query.append("CreatedAt", `lte.${checkedDate(url.searchParams.get("to")!)}`);
    const result = await db.selectWithCount(table, query);
    return new Response(JSON.stringify(camelize(result.rows)), { headers: { "Content-Type": "application/json", "X-Total-Count": String(result.total) } });
  }
  const eventById = url.pathname.match(/^\/api\/events\/(\d+)$/);
  if (eventById && request.method === "GET") {
    const rows = await db.select("Events", new URLSearchParams({ select: "*", Id: eq(Number(eventById[1])), limit: "1" }));
    if (!rows[0]) throw new HttpError(404, "Event not found");
    return Response.json(camelize(rows[0]));
  }
  const acknowledge = url.pathname.match(/^\/api\/alerts\/(\d+)\/acknowledge$/);
  if (acknowledge && (request.method === "POST" || request.method === "PUT")) {
    const rows = await db.update("Alerts", new URLSearchParams({ Id: eq(Number(acknowledge[1])) }), { IsAcknowledged: true, AcknowledgedAt: new Date().toISOString(), AcknowledgedBy: principal.username });
    if (!rows[0]) throw new HttpError(404, "Alert not found"); return Response.json(camelize(rows[0]));
  }
  if (url.pathname === "/api/push/register" && request.method === "POST") return registerPush(request, env, principal);
  if (url.pathname === "/api/push/unregister" && request.method === "POST") return unregisterPush(request, env, principal);
  throw new HttpError(404, "Not found");
}

async function registerPush(request: Request, env: Env, principal: AuthPrincipal): Promise<Response> {
  const body = await readJson(request) as Record<string, unknown>; const token = typeof body.token === "string" ? body.token.trim() : "";
  if (token.length < 20 || token.length > 450) throw new HttpError(400, "Invalid push token");
  const db = new SupabaseRest(env);
  const users = await db.select<{ Id: number }>("Users", new URLSearchParams({ select: "Id", Username: eq(principal.username), limit: "1" }));
  if (!users[0]) throw new HttpError(401, "Unknown user");
  const existing = await db.select<{ Id: number }>("UserPushTokens", new URLSearchParams({ select: "Id", Token: eq(token), limit: "1" }));
  const now = new Date().toISOString(); const values = { UserId: users[0].Id, Token: token, Platform: String(body.platform ?? "android").slice(0, 30), DeviceName: String(body.deviceName ?? "").slice(0, 200), IsActive: true, UpdatedAt: now, LastSeenAt: now };
  const rows = existing[0] ? await db.update("UserPushTokens", new URLSearchParams({ Id: eq(existing[0].Id) }), values) : await db.insert("UserPushTokens", { ...values, CreatedAt: now });
  return Response.json(camelize({ registered: true, ...(rows[0] ?? {}) }));
}

async function unregisterPush(request: Request, env: Env, principal: AuthPrincipal): Promise<Response> {
  const body = await readJson(request) as Record<string, unknown>; const token = typeof body.token === "string" ? body.token.trim() : "";
  const db = new SupabaseRest(env); const users = await db.select<{ Id: number }>("Users", new URLSearchParams({ select: "Id", Username: eq(principal.username), limit: "1" }));
  if (users[0] && token) await db.update("UserPushTokens", new URLSearchParams({ UserId: eq(users[0].Id), Token: eq(token) }), { IsActive: false, UpdatedAt: new Date().toISOString() });
  return Response.json({ unregistered: true });
}

function checkedDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) throw new HttpError(400, "Invalid date filter");
  return date.toISOString();
}

const worker: ExportedHandler<Env> = {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    try {
      if (url.pathname === "/health" && request.method === "GET") return json(request, env, { status: "ok", service: "iot-fire-worker" });
      if (url.pathname === "/realtime" && request.method === "GET") {
        const principal = await principalFromRequest(request, env); if (!principal) throw new HttpError(401, "Unauthorized");
        const deviceId = url.searchParams.get("deviceId") ?? ""; if (!validDeviceId(deviceId)) throw new HttpError(400, "deviceId is required");
        return realtimeStub(env, deviceId).fetch(new Request("https://do/connect", request));
      }
      if (url.pathname === "/webhooks/emqx/telemetry" && request.method === "POST") return await webhook(request, env, "telemetry");
      if (url.pathname === "/webhooks/emqx/event" && request.method === "POST") return await webhook(request, env, "event");
      if (url.pathname === "/webhooks/emqx/command-response" && request.method === "POST") return await webhook(request, env, "command-response");
      if (url.pathname.startsWith("/api/")) {
        const response = await api(request, env, url); const headers = new Headers(response.headers); for (const [key, value] of Object.entries(corsHeaders(request, env))) headers.set(key, String(value));
        return new Response(response.body, { status: response.status, headers });
      }
      throw new HttpError(404, "Not found");
    } catch (error) {
      if (error instanceof HttpError) return json(request, env, { message: error.message }, error.status, error.status === 429 ? { "Retry-After": "60" } : {});
      console.error("Request failed", error instanceof Error ? error.name : "UnknownError");
      return json(request, env, { message: "Internal server error" }, 500);
    }
  },

  async scheduled(_controller, env): Promise<void> {
    const days = Math.max(1, Number(env.RAW_RETENTION_DAYS || "30"));
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    await new SupabaseRest(env).remove("SensorReadings", new URLSearchParams({ ReceivedAt: `lt.${cutoff}` }));
  }
};

export default worker;
