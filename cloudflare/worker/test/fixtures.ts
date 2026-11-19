import type { Env, Telemetry } from "../src/types";

export const telemetry: Telemetry = {
  deviceId: "ESP32_001",
  temperature: 30.5,
  humidity: 76.6,
  temperatureRate: 0,
  smokeRaw: 1200,
  smokeLevel: "NORMAL",
  flameDetected: false,
  flameConfirmed: false,
  state: "NORMAL",
  mode: "AUTO",
  fanOn: false,
  pumpOn: false,
  buzzerOn: false,
  dhtOk: true,
  wifiRssi: -48,
  uptimeMs: 16056
};

export function env(overrides: Partial<Env> = {}): Env {
  return {
    SUPABASE_URL: "https://lmmqianbtgivdobqouwr.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
    JWT_SECRET: "test-jwt-secret-at-least-32-characters",
    JWT_ISSUER: "IotFire",
    JWT_AUDIENCE: "IotFireClient",
    JWT_EXPIRES_SECONDS: "3600",
    EMQX_WEBHOOK_SECRET: "test-webhook-secret",
    EMQX_API_URL: "https://example.emqxsl.com",
    EMQX_API_KEY: "test-api-key",
    EMQX_API_SECRET: "test-api-secret",
    FIREBASE_PROJECT_ID: "iot-fire-monitoring-85448",
    FIREBASE_CLIENT_EMAIL: "firebase@example.invalid",
    FIREBASE_PRIVATE_KEY: "unused-in-unit-tests",
    ALLOWED_ORIGINS: "https://iot-fire-monitoring-85448.web.app,capacitor://localhost",
    TELEMETRY_PERSIST_SECONDS: "10",
    DEVICE_OFFLINE_SECONDS: "15",
    RAW_RETENTION_DAYS: "30",
    REALTIME: {} as DurableObjectNamespace,
    ...overrides
  };
}
