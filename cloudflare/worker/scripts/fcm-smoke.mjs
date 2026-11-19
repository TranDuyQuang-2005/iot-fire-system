import { createSign } from "node:crypto";

const required = [
  "SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY",
  "FIREBASE_PROJECT_ID"
];

for (const name of required) {
  if (!process.env[name]) throw new Error(`Missing ${name}`);
}

const base64Url = (value) => Buffer.from(value).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
const claims = base64Url(JSON.stringify({
  iss: process.env.FIREBASE_CLIENT_EMAIL,
  scope: "https://www.googleapis.com/auth/firebase.messaging",
  aud: "https://oauth2.googleapis.com/token",
  iat: now,
  exp: now + 3600
}));
const unsigned = `${header}.${claims}`;
const signer = createSign("RSA-SHA256");
signer.update(unsigned);
signer.end();
const assertion = `${unsigned}.${signer.sign(process.env.FIREBASE_PRIVATE_KEY, "base64url")}`;

const oauthResponse = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion
  })
});
if (!oauthResponse.ok) throw new Error(`OAuth status ${oauthResponse.status}`);
const { access_token: accessToken } = await oauthResponse.json();
if (!accessToken) throw new Error("OAuth response did not contain an access token");

const tokenResponse = await fetch(
  `${process.env.SUPABASE_URL}/rest/v1/UserPushTokens?select=Token&IsActive=eq.true&limit=1`,
  { headers: { apikey: process.env.SUPABASE_SECRET_KEY } }
);
if (!tokenResponse.ok) throw new Error(`Push-token query status ${tokenResponse.status}`);
const tokenRows = await tokenResponse.json();
if (tokenRows.length !== 1 || !tokenRows[0].Token) throw new Error("No active push token available");

const sendResponse = await fetch(
  `https://fcm.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID}/messages:send`,
  {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      message: {
        token: tokenRows[0].Token,
        notification: {
          title: "IoT Fire deployment check",
          body: "Cloud notification path is working."
        },
        data: { eventType: "DEPLOYMENT_SMOKE", eventId: "cloud-check" }
      }
    })
  }
);

if (!sendResponse.ok) throw new Error(`FCM send status ${sendResponse.status}`);
console.log(`FCM PASS oauth=PASS send_status=${sendResponse.status} active_token_used=1`);
