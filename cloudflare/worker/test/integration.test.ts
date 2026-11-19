import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { handleCommandResponse, publishCommand } from "../src/index";
import { fcmPayload } from "../src/fcm";
import { RealtimeCoordinator } from "../src/realtime";
import { SupabaseRest } from "../src/supabase";
import type { RuntimeState } from "../src/types";
import { env, telemetry } from "./fixtures";

afterEach(() => vi.restoreAllMocks());

describe("Worker integration units", () => {
  it("sends current Supabase secret keys only as apikey headers", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json([]));
    await new SupabaseRest(env()).select("Devices", new URLSearchParams({ select: "Id" }));
    const headers = new Headers(fetchMock.mock.calls[0]![1]?.headers);
    expect(headers.get("apikey")).toBe("sb_secret_test-only-placeholder");
    expect(headers.has("Authorization")).toBe(false);
  });

  it("rejects unauthenticated and malformed telemetry webhooks", async () => {
    const config = env();
    const missing = await worker.fetch!(new Request("https://worker.test/webhooks/emqx/telemetry", { method: "POST", body: JSON.stringify(telemetry) }) as Request<unknown, IncomingRequestCfProperties>, config, {} as ExecutionContext);
    expect(missing.status).toBe(401);
    const malformed = await worker.fetch!(new Request("https://worker.test/webhooks/emqx/telemetry", { method: "POST", headers: { "X-EMQX-Webhook-Secret": config.EMQX_WEBHOOK_SECRET }, body: "{}" }) as Request<unknown, IncomingRequestCfProperties>, config, {} as ExecutionContext);
    expect(malformed.status).toBe(400);
  });

  it("publishes a correlated command through EMQX HTTP API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 202 }));
    await publishCommand(env(), "ESP32_001", "a".repeat(32), "PUMP_ON");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://example.emqxsl.com/publish");
    const body = JSON.parse(String(init?.body));
    expect(body.topic).toBe("iot/fire/device/ESP32_001/command");
    expect(JSON.parse(body.payload)).toEqual({ commandId: "a".repeat(32), command: "PUMP_ON" });
  });

  it("updates a correlated command response and broadcasts its result", async () => {
    const broadcast = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const namespace = {
      idFromName: vi.fn().mockReturnValue("do-id"),
      get: vi.fn().mockReturnValue({ fetch: broadcast })
    } as unknown as DurableObjectNamespace;
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json([{ Id: 7, DeviceId: 1 }]))
      .mockResolvedValueOnce(Response.json([{ Id: 1, DeviceCode: "ESP32_001", CurrentState: "NORMAL", CurrentMode: "AUTO" }]))
      .mockResolvedValueOnce(Response.json([{ Id: 7 }]));
    await handleCommandResponse(env({ REALTIME: namespace }), {
      deviceId: "ESP32_001", commandId: "a".repeat(32), command: "PUMP_ON", status: "EXECUTED"
    });
    expect(fetchMock.mock.calls[2]![1]?.method).toBe("PATCH");
    expect(String(fetchMock.mock.calls[2]![1]?.body)).toContain('"Status":"ACKNOWLEDGED"');
    expect(broadcast).toHaveBeenCalledOnce();
  });

  it("broadcasts realtime telemetry without a database write inside the sampling window", async () => {
    const runtime: RuntimeState = { online: true, lastTelemetryAt: Date.now() - 1000, lastPersistedAt: Date.now() - 1000, lastState: "NORMAL", latest: telemetry };
    const store = new Map<string, unknown>([["runtime", runtime]]);
    const send = vi.fn();
    const state = {
      storage: {
        get: async (key: string) => store.get(key),
        put: async (key: string, value: unknown) => { store.set(key, value); },
        setAlarm: async () => undefined
      },
      getWebSockets: () => [{ send, close: vi.fn() }],
      acceptWebSocket: vi.fn()
    } as unknown as DurableObjectState;
    const coordinator = new RealtimeCoordinator(state, env());
    const response = await coordinator.fetch(new Request("https://do/telemetry", { method: "POST", body: JSON.stringify(telemetry) }));
    expect(response.ok).toBe(true);
    expect((await response.json<{ persisted: boolean }>()).persisted).toBe(false);
    expect(JSON.parse(send.mock.calls[0]![0])).toMatchObject({ type: "TelemetryUpdated", data: { deviceId: "ESP32_001" } });
  });

  it("keeps FCM data free of custom timestamp fields", () => {
    const payload = fcmPayload("token", "FIRE", "42", { title: "Fire", body: "Detected", channelId: "fire_critical" });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toMatch(/createdAt|event_time|timestamp/i);
    expect(serialized).toContain('"eventId":"42"');
  });
});
