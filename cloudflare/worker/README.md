# IoT Fire Cloudflare Worker

Production backend source for the strictly free architecture. It replaces the VM-hosted ASP.NET production process while leaving ASP.NET in the repository for development, reference, and fallback.

## Runtime architecture

```text
ESP32 --MQTT/TLS--> EMQX Serverless
  EMQX rules --authenticated HTTPS--> Worker webhooks
  Worker --Supabase Data API--> Supabase PostgreSQL
  Worker --FCM HTTP v1--> Android notifications
  Worker --EMQX HTTP publish API--> ESP32 command topic
  Worker <--> per-device Durable Object <--> Web/Android WebSocket
```

The ESP32 safety state machine remains authoritative and works without any cloud service. Pump GPIO21, fan GPIO25, and buzzer GPIO19 are unchanged.

## Local verification

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd test
```

TypeScript is strict, dependencies are exact-version pinned, and `package-lock.json` is committed. The Worker stores no production secret in source or `wrangler.jsonc`.

## Required Cloudflare secrets

Authenticate Wrangler only when deployment is intended, then provision each value interactively:

```powershell
npx wrangler login
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put JWT_SECRET
npx wrangler secret put EMQX_WEBHOOK_SECRET
npx wrangler secret put EMQX_API_URL
npx wrangler secret put EMQX_API_KEY
npx wrangler secret put EMQX_API_SECRET
npx wrangler secret put FIREBASE_CLIENT_EMAIL
npx wrangler secret put FIREBASE_PRIVATE_KEY
```

`JWT_SECRET` should match the existing ASP.NET production signing secret if existing sessions must remain valid. The Firebase values are individual service-account fields; never copy the service-account JSON into this directory.

## EMQX configuration after deployment

Create rules for the existing topics and send JSON to:

- `iot/fire/device/+/telemetry` -> `POST /webhooks/emqx/telemetry`
- `iot/fire/device/+/event` -> `POST /webhooks/emqx/event`
- `iot/fire/device/+/command-response` -> `POST /webhooks/emqx/command-response`

Every webhook must send `X-EMQX-Webhook-Secret` with the Cloudflare secret value. Do not leave the endpoints configured without that header. Configure the Worker origin, API credentials, and spend limit without enabling a paid tier.

## HTTP and realtime contracts

The Worker preserves the current principal routes: login and `auth/me`, devices/current/latest/history, events, alerts/acknowledge, commands/mode/reset, push-token register/unregister, and health. All `/api` routes except login require a Bearer JWT; command routes additionally require `ADMIN`.

Realtime uses `GET /realtime?deviceId=...` and a native WebSocket. The JWT is carried in the `Sec-WebSocket-Protocol` list as `jwt.<token>`, so it is not placed in a query string. The Durable Object selects `iot-fire` as the negotiated protocol and uses the hibernation API.

Before any web or Android release, replace the fail-safe `configure-iot-fire-worker.invalid` origins with the verified Worker origin. Do not build an Android release before the deployed URL passes health, auth, command, webhook, realtime, FCM, and offline end-to-end checks.

## Persistence and retention

Normal telemetry is broadcast on every packet but persists around every 10 seconds. Critical states and every state transition persist immediately. Events are never sampled. A daily Worker cron deletes only `SensorReadings` older than 30 days; it never cleans Events, Alerts, or Commands.

Supabase is accessed only with the server-side service-role secret through the Data API. No RLS policies are relaxed, and the existing production database is neither reset nor migrated by this Worker project.

## Free-quota forecast for one device

The firmware interval is 4 seconds:

| Resource | Forecast |
|---|---:|
| Telemetry webhook requests | 21,600/day |
| EMQX telemetry rule actions | 648,000/30 days |
| Remaining EMQX action margin before 1,000,000 | about 352,000/30 days |
| Supabase raw rows at 10 seconds | 8,640/day; 259,200/30 days |
| Estimated 30-day raw storage | about 47.5 MB/device |
| Durable Object request operations, 2 clients | about 64,800/day plus connects/commands/events |

Events, command responses, REST traffic, and WebSocket connects depend on actual use. The 4-second interval leaves materially more margin than 3 seconds. Add another device only after recalculating all three provider quotas; one identical additional device would exceed the stated EMQX free action allowance.

No deployment is performed by the source-preparation task. Provider login, secret provisioning, EMQX rule creation, real Worker URL replacement, and production end-to-end testing remain operator steps.
