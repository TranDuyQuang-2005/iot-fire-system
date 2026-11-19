import type { AuthPrincipal, Env } from "./types";

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
}

export async function createJwt(env: Env, principal: AuthPrincipal): Promise<{ token: string; expiresIn: number }> {
  const expiresIn = Number(env.JWT_EXPIRES_SECONDS || "3600");
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = base64Url(new TextEncoder().encode(JSON.stringify({
    sub: principal.username,
    name: principal.username,
    role: principal.role,
    iss: env.JWT_ISSUER,
    aud: env.JWT_AUDIENCE,
    iat: now,
    exp: now + expiresIn,
    jti: crypto.randomUUID()
  })));
  const input = `${header}.${payload}`;
  return { token: `${input}.${base64Url(await hmac(env.JWT_SECRET, input))}`, expiresIn };
}

export async function verifyJwt(env: Env, token: string): Promise<AuthPrincipal | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];
  const expected = base64Url(await hmac(env.JWT_SECRET, `${header}.${payload}`));
  if (expected.length !== signature.length) return null;
  let difference = 0;
  for (let index = 0; index < expected.length; index++) difference |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
  if (difference !== 0) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(decodeBase64(payload))) as Record<string, unknown>;
    const now = Math.floor(Date.now() / 1000);
    if (claims.iss !== env.JWT_ISSUER || claims.aud !== env.JWT_AUDIENCE || typeof claims.exp !== "number" || claims.exp <= now) return null;
    const username = typeof claims.name === "string" ? claims.name : claims.sub;
    if (typeof username !== "string" || typeof claims.role !== "string") return null;
    return { username, role: claims.role };
  } catch {
    return null;
  }
}

export async function principalFromRequest(request: Request, env: Env): Promise<AuthPrincipal | null> {
  const header = request.headers.get("Authorization");
  if (header?.startsWith("Bearer ")) return verifyJwt(env, header.slice(7));
  const protocols = request.headers.get("Sec-WebSocket-Protocol")?.split(",").map(value => value.trim()) ?? [];
  const protocolToken = protocols.find(value => value.startsWith("jwt."));
  return protocolToken ? verifyJwt(env, protocolToken.slice(4)) : null;
}

function readUInt32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false);
}

export async function verifyAspNetIdentityPassword(hash: string, password: string): Promise<boolean> {
  try {
    const decoded = decodeBase64(hash);
    if (decoded.length < 14 || decoded[0] !== 0x01) return false;
    const prf = readUInt32(decoded, 1);
    const iterations = readUInt32(decoded, 5);
    const saltLength = readUInt32(decoded, 9);
    if (iterations < 10_000 || iterations > 1_000_000 || saltLength < 16 || 13 + saltLength >= decoded.length) return false;
    const algorithm = prf === 0 ? "SHA-1" : prf === 1 ? "SHA-256" : prf === 2 ? "SHA-512" : null;
    if (algorithm === null) return false;
    const salt = decoded.slice(13, 13 + saltLength);
    const expected = decoded.slice(13 + saltLength);
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    const actual = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: algorithm, salt, iterations }, key, expected.length * 8));
    let difference = 0;
    for (let index = 0; index < expected.length; index++) difference |= expected[index]! ^ actual[index]!;
    return difference === 0;
  } catch {
    return false;
  }
}
