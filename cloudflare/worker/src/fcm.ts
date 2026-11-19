import type { Env } from "./types";
import { eq, SupabaseRest } from "./supabase";

interface PushContent { title: string; body: string; channelId: string }

const CONTENT: Record<string, PushContent> = {
  WARNING: { title: "⚠️ Có dấu hiệu bất thường", body: "Hệ thống phát hiện khói hoặc khí bất thường.", channelId: "warning" },
  HIGH_RISK: { title: "⚠️ Nguy cơ cháy cao", body: "Mức khói và nhiệt độ đang tăng nhanh.", channelId: "fire_critical" },
  FIRE: { title: "🔥 CẢNH BÁO CHÁY", body: "Hệ thống đã phát hiện cháy.", channelId: "fire_critical" },
  SUPPRESSING: { title: "🚨 Đang xử lý sự cố", body: "Hệ thống đang thực hiện xử lý cháy.", channelId: "fire_critical" },
  POST_FIRE: { title: "✅ Ngọn lửa đã được dập", body: "Hệ thống đang chờ xác nhận an toàn.", channelId: "warning" },
  DEVICE_OFFLINE: { title: "📡 Mất kết nối", body: "Thiết bị giám sát đã mất kết nối.", channelId: "system" },
  DEVICE_ONLINE: { title: "✅ Đã kết nối lại", body: "Thiết bị giám sát đã hoạt động trở lại.", channelId: "system" }
};

let cachedToken: { value: string; expiresAt: number } | null = null;

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function pemBytes(pem: string): ArrayBuffer {
  const normalized = pem.replace(/\\n/g, "\n").replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  return Uint8Array.from(atob(normalized), character => character.charCodeAt(0)).buffer;
}

async function accessToken(env: Env): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = base64Url(new TextEncoder().encode(JSON.stringify({
    iss: env.FIREBASE_CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  })));
  const key = await crypto.subtle.importKey("pkcs8", pemBytes(env.FIREBASE_PRIVATE_KEY), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`)));
  const assertion = `${header}.${claims}.${base64Url(signature)}`;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion })
  });
  if (!response.ok) throw new Error(`Firebase OAuth failed (${response.status})`);
  const result = await response.json<{ access_token: string; expires_in: number }>();
  cachedToken = { value: result.access_token, expiresAt: Date.now() + result.expires_in * 1000 };
  return result.access_token;
}

export function fcmPayload(token: string, eventType: string, eventId: string, content: PushContent): unknown {
  return {
    message: {
      token,
      notification: { title: content.title, body: content.body },
      data: { eventId, eventType, route: "/" },
      android: { priority: "high", notification: { channel_id: content.channelId, sound: "default", tag: `iot-fire-${eventId}` } }
    }
  };
}

export async function sendPush(env: Env, eventType: string, eventId: string): Promise<void> {
  const content = CONTENT[eventType];
  if (!content) return;
  const db = new SupabaseRest(env);
  const query = new URLSearchParams({ select: "Id,Token", IsActive: eq(true), order: "Id.asc", limit: "25" });
  const records = await db.select<Array<{ Id: number; Token: string }>[number]>("UserPushTokens", query);
  if (records.length === 0) return;
  const oauth = await accessToken(env);
  for (const record of records) {
    const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID)}/messages:send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${oauth}`, "Content-Type": "application/json" },
      body: JSON.stringify(fcmPayload(record.Token, eventType, eventId, content))
    });
    if (response.ok) continue;
    const error = await response.text();
    if (response.status === 404 || error.includes("UNREGISTERED") || error.includes("INVALID_ARGUMENT"))
      await db.update("UserPushTokens", new URLSearchParams({ Id: eq(record.Id) }), { IsActive: false, UpdatedAt: new Date().toISOString() });
  }
}
