import { eq, SupabaseRest } from "./supabase";
import type { DeviceEvent, Env, Telemetry } from "./types";

export interface DeviceRow {
  Id: number;
  DeviceCode: string;
  Name: string;
  Status: string;
  CurrentState: string;
  CurrentMode: string;
  LastSeen: string | null;
}

export async function ensureDevice(env: Env, deviceCode: string): Promise<DeviceRow> {
  const db = new SupabaseRest(env);
  const query = new URLSearchParams({ select: "*", DeviceCode: eq(deviceCode), limit: "1" });
  const existing = await db.select<DeviceRow>("Devices", query);
  if (existing[0]) return existing[0];
  const now = new Date().toISOString();
  try {
    const inserted = await db.insert<DeviceRow>("Devices", {
      DeviceCode: deviceCode, Name: deviceCode, Status: "OFFLINE", CurrentState: "NORMAL", CurrentMode: "AUTO",
      LastSeen: null, CreatedAt: now, UpdatedAt: now
    });
    if (inserted[0]) return inserted[0];
  } catch {
    const raced = await db.select<DeviceRow>("Devices", query);
    if (raced[0]) return raced[0];
  }
  throw new Error("Unable to resolve device");
}

export async function persistTelemetry(env: Env, telemetry: Telemetry, receivedAt: string): Promise<void> {
  const db = new SupabaseRest(env);
  const device = await ensureDevice(env, telemetry.deviceId);
  await db.update("Devices", new URLSearchParams({ Id: eq(device.Id) }), {
    Status: "ONLINE", CurrentState: telemetry.state, CurrentMode: telemetry.mode, LastSeen: receivedAt, UpdatedAt: receivedAt
  });
  await db.insert("SensorReadings", {
    DeviceId: device.Id,
    Temperature: telemetry.temperature,
    Humidity: telemetry.humidity,
    TemperatureRate: telemetry.temperatureRate,
    SmokeRaw: telemetry.smokeRaw,
    SmokeLevel: telemetry.smokeLevel,
    FlameDetected: telemetry.flameDetected,
    FlameConfirmed: telemetry.flameConfirmed,
    SystemState: telemetry.state,
    Mode: telemetry.mode,
    FanOn: telemetry.fanOn,
    PumpOn: telemetry.pumpOn,
    BuzzerOn: telemetry.buzzerOn,
    DhtOk: telemetry.dhtOk,
    WifiRssi: telemetry.wifiRssi,
    UptimeMs: telemetry.uptimeMs,
    ReceivedAt: receivedAt
  });
}

export async function persistEvent(env: Env, event: DeviceEvent): Promise<{ id: number; pushType: string | null }> {
  const db = new SupabaseRest(env);
  const device = await ensureDevice(env, event.deviceId);
  const now = new Date().toISOString();
  const records = await db.insert<{ Id: number }>("Events", {
    DeviceId: device.Id, EventType: event.eventType, Severity: event.severity,
    State: event.state, Message: event.message, CreatedAt: now
  });
  const id = records[0]?.Id;
  if (id === undefined) throw new Error("Event insert returned no id");
  if (["CRITICAL", "HIGH", "WARNING"].includes(event.severity)) {
    await db.insert("Alerts", {
      DeviceId: device.Id, Type: event.eventType, Severity: event.severity, Message: event.message,
      IsAcknowledged: false, CreatedAt: now, AcknowledgedAt: null, AcknowledgedBy: null
    });
  }
  const pushType: Record<string, string> = {
    SMOKE_WARNING: "WARNING", HIGH_RISK: "HIGH_RISK", FIRE_DETECTED: "FIRE",
    FIRE_SUPPRESSING: "SUPPRESSING", FIRE_CLEARED: "POST_FIRE",
    DEVICE_OFFLINE: "DEVICE_OFFLINE", DEVICE_ONLINE: "DEVICE_ONLINE"
  };
  return { id, pushType: pushType[event.eventType] ?? null };
}

export async function markDeviceOffline(env: Env, deviceCode: string, state: string): Promise<number> {
  const db = new SupabaseRest(env);
  const device = await ensureDevice(env, deviceCode);
  const now = new Date().toISOString();
  await db.update("Devices", new URLSearchParams({ Id: eq(device.Id) }), { Status: "OFFLINE", UpdatedAt: now });
  const result = await persistEvent(env, {
    deviceId: deviceCode, eventType: "DEVICE_OFFLINE", severity: "WARNING", state,
    message: "No telemetry within timeout", uptimeMs: 0
  });
  return result.id;
}
