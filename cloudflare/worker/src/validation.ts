import type { CommandResponse, DeviceEvent, Telemetry } from "./types";

const DEVICE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const STATES = new Set(["NORMAL", "HOT", "WARNING", "HIGH_RISK", "FIRE", "SUPPRESSING", "POST_FIRE"]);
const SMOKE_LEVELS = new Set(["NORMAL", "WARNING", "DANGER"]);
const MODES = new Set(["AUTO", "MANUAL"]);

export function validDeviceId(value: unknown): value is string {
  return typeof value === "string" && DEVICE_ID.test(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function parseTelemetry(value: unknown): Telemetry | null {
  if (!value || typeof value !== "object") return null;
  const x = value as Record<string, unknown>;
  if (!validDeviceId(x.deviceId) || !STATES.has(String(x.state)) || !SMOKE_LEVELS.has(String(x.smokeLevel)) || !MODES.has(String(x.mode))) return null;
  if (!(x.temperature === null || finiteNumber(x.temperature)) || !(x.humidity === null || finiteNumber(x.humidity))) return null;
  for (const key of ["temperatureRate", "smokeRaw", "wifiRssi", "uptimeMs"] as const) if (!finiteNumber(x[key])) return null;
  for (const key of ["flameDetected", "flameConfirmed", "fanOn", "pumpOn", "buzzerOn", "dhtOk"] as const) if (typeof x[key] !== "boolean") return null;
  if ((x.smokeRaw as number) < 0 || (x.smokeRaw as number) > 100_000 || (x.uptimeMs as number) < 0) return null;
  return x as unknown as Telemetry;
}

export function parseEvent(value: unknown): DeviceEvent | null {
  if (!value || typeof value !== "object") return null;
  const x = value as Record<string, unknown>;
  if (!validDeviceId(x.deviceId)) return null;
  const eventType = x.eventType;
  const severity = x.severity;
  const state = x.state;
  const message = x.message;
  if (typeof eventType !== "string" || typeof severity !== "string" || typeof state !== "string" || typeof message !== "string") return null;
  if (!eventType || !severity || !state || !message || !finiteNumber(x.uptimeMs)) return null;
  if (eventType.length > 100 || severity.length > 30 || state.length > 30 || message.length > 1000) return null;
  return x as unknown as DeviceEvent;
}

export function parseCommandResponse(value: unknown): CommandResponse | null {
  if (!value || typeof value !== "object") return null;
  const x = value as Record<string, unknown>;
  if (!validDeviceId(x.deviceId) || typeof x.commandId !== "string" || !/^[A-Fa-f0-9]{32}$/.test(x.commandId)) return null;
  if (typeof x.command !== "string" || typeof x.status !== "string") return null;
  if (x.reason !== undefined && typeof x.reason !== "string") return null;
  if (x.message !== undefined && typeof x.message !== "string") return null;
  return x as unknown as CommandResponse;
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  if (length === 0) return true;
  for (let i = 0; i < length; i++) {
    const leftByte = left.length === 0 ? 0 : left[i % left.length]!;
    const rightByte = right.length === 0 ? 0 : right[i % right.length]!;
    difference |= leftByte ^ rightByte;
  }
  return difference === 0;
}
