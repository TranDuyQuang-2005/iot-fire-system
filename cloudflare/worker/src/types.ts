export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  JWT_SECRET: string;
  JWT_ISSUER: string;
  JWT_AUDIENCE: string;
  JWT_EXPIRES_SECONDS: string;
  EMQX_WEBHOOK_SECRET: string;
  EMQX_API_URL: string;
  EMQX_API_KEY: string;
  EMQX_API_SECRET: string;
  FIREBASE_PROJECT_ID: string;
  FIREBASE_CLIENT_EMAIL: string;
  FIREBASE_PRIVATE_KEY: string;
  ALLOWED_ORIGINS: string;
  TELEMETRY_PERSIST_SECONDS: string;
  DEVICE_OFFLINE_SECONDS: string;
  RAW_RETENTION_DAYS: string;
  REALTIME: DurableObjectNamespace;
}

export interface Telemetry {
  deviceId: string;
  temperature: number | null;
  humidity: number | null;
  temperatureRate: number;
  smokeRaw: number;
  smokeLevel: "NORMAL" | "WARNING" | "DANGER";
  flameDetected: boolean;
  flameConfirmed: boolean;
  state: "NORMAL" | "HOT" | "WARNING" | "HIGH_RISK" | "FIRE" | "SUPPRESSING" | "POST_FIRE";
  mode: "AUTO" | "MANUAL";
  fanOn: boolean;
  pumpOn: boolean;
  buzzerOn: boolean;
  dhtOk: boolean;
  wifiRssi: number;
  uptimeMs: number;
}

export interface DeviceEvent {
  deviceId: string;
  eventType: string;
  severity: string;
  state: string;
  message: string;
  uptimeMs: number;
}

export interface CommandResponse {
  deviceId: string;
  commandId: string;
  command: string;
  status: string;
  reason?: string;
  message?: string;
}

export interface AuthPrincipal {
  username: string;
  role: string;
}

export interface RuntimeState {
  online: boolean;
  lastTelemetryAt: number;
  lastPersistedAt: number;
  lastState: string | null;
  latest: Telemetry | null;
}
