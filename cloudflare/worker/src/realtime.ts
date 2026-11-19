import { markDeviceOffline, persistEvent, persistTelemetry } from "./data";
import { sendPush } from "./fcm";
import { decideTelemetry, isOffline } from "./runtime";
import type { DeviceEvent, Env, RuntimeState, Telemetry } from "./types";

const STATE_KEY = "runtime";

export class RealtimeCoordinator implements DurableObject {
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/connect") return this.openWebSocket(request);
    if (path === "/status" && request.method === "GET") {
      const runtime = await this.state.storage.get<RuntimeState>(STATE_KEY) ?? null;
      return Response.json(runtime);
    }
    if (request.method !== "POST") return new Response("Not found", { status: 404 });
    if (path === "/telemetry") return this.telemetry(await request.json<Telemetry>());
    if (path === "/event" || path === "/command-response") {
      await this.broadcast(await request.json<unknown>());
      return new Response(null, { status: 204 });
    }
    if (path === "/rate-limit") return this.rateLimit(await request.json<{ now: number }>());
    return new Response("Not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    const runtime = await this.state.storage.get<RuntimeState>(STATE_KEY);
    if (!runtime) return;
    const timeoutMs = Number(this.env.DEVICE_OFFLINE_SECONDS || "15") * 1000;
    const now = Date.now();
    if (!isOffline(runtime, now, timeoutMs)) {
      await this.state.storage.setAlarm(runtime.lastTelemetryAt + timeoutMs);
      return;
    }
    runtime.online = false;
    await this.state.storage.put(STATE_KEY, runtime);
    const deviceId = runtime.latest?.deviceId;
    if (!deviceId) return;
    const eventId = await markDeviceOffline(this.env, deviceId, runtime.lastState ?? "NORMAL");
    await this.broadcast({ type: "DeviceConnectionChanged", data: { deviceId, status: "OFFLINE", online: false, lastSeen: new Date(runtime.lastTelemetryAt).toISOString() } });
    await sendPush(this.env, "DEVICE_OFFLINE", String(eventId));
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (message === "ping") socket.send("pong");
  }

  webSocketError(): void {}
  webSocketClose(socket: WebSocket, code: number, reason: string, wasClean: boolean): void {
    socket.close(code, reason);
  }

  private openWebSocket(request: Request): Response {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client, headers: { "Sec-WebSocket-Protocol": "iot-fire" } });
  }

  private async telemetry(payload: Telemetry): Promise<Response> {
    const now = Date.now();
    const previous = await this.state.storage.get<RuntimeState>(STATE_KEY) ?? null;
    const decision = decideTelemetry(previous, payload, now, Number(this.env.TELEMETRY_PERSIST_SECONDS || "10") * 1000);
    await this.state.storage.put(STATE_KEY, decision.next);
    await this.state.storage.setAlarm(now + Number(this.env.DEVICE_OFFLINE_SECONDS || "15") * 1000);
    const receivedAt = new Date(now).toISOString();
    if (decision.persist) await persistTelemetry(this.env, payload, receivedAt);
    await this.broadcast({ type: "TelemetryUpdated", data: { ...payload, systemState: payload.state, receivedAt, lastSeen: receivedAt, status: "ONLINE" } });
    if (decision.becameOnline) {
      const onlineEvent: DeviceEvent = { deviceId: payload.deviceId, eventType: "DEVICE_ONLINE", severity: "INFO", state: payload.state, message: "Telemetry connection restored", uptimeMs: payload.uptimeMs };
      const saved = await persistEvent(this.env, onlineEvent);
      await this.broadcast({ type: "DeviceConnectionChanged", data: { deviceId: payload.deviceId, status: "ONLINE", online: true, lastSeen: receivedAt } });
      await sendPush(this.env, "DEVICE_ONLINE", String(saved.id));
    }
    return Response.json({ accepted: true, persisted: decision.persist, stateTransition: decision.stateTransition });
  }

  private async broadcast(message: unknown): Promise<void> {
    const encoded = JSON.stringify(message);
    for (const socket of this.state.getWebSockets()) {
      try { socket.send(encoded); } catch { socket.close(1011, "Broadcast failed"); }
    }
  }

  private async rateLimit(input: { now: number }): Promise<Response> {
    const key = "login-attempts";
    const current = await this.state.storage.get<{ start: number; count: number }>(key);
    const windowMs = 60_000;
    const next = !current || input.now - current.start >= windowMs ? { start: input.now, count: 1 } : { ...current, count: current.count + 1 };
    await this.state.storage.put(key, next);
    return Response.json({ allowed: next.count <= 5, retryAfter: Math.max(1, Math.ceil((next.start + windowMs - input.now) / 1000)) });
  }
}
