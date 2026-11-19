import { describe, expect, it } from "vitest";
import { constantTimeEqual, parseCommandResponse, parseEvent, parseTelemetry } from "../src/validation";
import { telemetry } from "./fixtures";

describe("payload validation", () => {
  it("accepts the firmware telemetry contract", () => expect(parseTelemetry(telemetry)).toEqual(telemetry));
  it("rejects malformed telemetry", () => {
    expect(parseTelemetry({ ...telemetry, deviceId: "../../bad" })).toBeNull();
    expect(parseTelemetry({ ...telemetry, smokeRaw: Number.NaN })).toBeNull();
    expect(parseTelemetry({ ...telemetry, flameDetected: "false" })).toBeNull();
  });
  it("validates events and correlated command responses", () => {
    expect(parseEvent({ deviceId: "ESP32_001", eventType: "FIRE", severity: "CRITICAL", state: "FIRE", message: "Fire", uptimeMs: 1 })).not.toBeNull();
    expect(parseCommandResponse({ deviceId: "ESP32_001", commandId: "a".repeat(32), command: "PUMP_ON", status: "EXECUTED" })).not.toBeNull();
    expect(parseCommandResponse({ deviceId: "ESP32_001", commandId: "bad", command: "PUMP_ON", status: "EXECUTED" })).toBeNull();
  });
  it("compares webhook secrets without early length acceptance", () => {
    expect(constantTimeEqual("secret", "secret")).toBe(true);
    expect(constantTimeEqual("", "secret")).toBe(false);
    expect(constantTimeEqual("secret", "secret2")).toBe(false);
  });
});
