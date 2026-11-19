import { describe, expect, it } from "vitest";
import { createHash, pbkdf2Sync } from "node:crypto";
import { createJwt, principalFromRequest, verifyAspNetIdentityPassword, verifyJwt } from "../src/auth";
import { env } from "./fixtures";

function identityV3Hash(password: string): string {
  const salt = createHash("sha256").update("stable-test-salt").digest().subarray(0, 16);
  const iterations = 10_000;
  const subkey = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const bytes = Buffer.alloc(13 + salt.length + subkey.length);
  bytes[0] = 1;
  bytes.writeUInt32BE(1, 1);
  bytes.writeUInt32BE(iterations, 5);
  bytes.writeUInt32BE(salt.length, 9);
  salt.copy(bytes, 13);
  subkey.copy(bytes, 13 + salt.length);
  return bytes.toString("base64");
}

describe("authentication", () => {
  it("signs and verifies HS256 JWTs", async () => {
    const config = env();
    const { token } = await createJwt(config, { username: "admin", role: "ADMIN" });
    await expect(verifyJwt(config, token)).resolves.toEqual({ username: "admin", role: "ADMIN" });
    await expect(verifyJwt(config, `${token.slice(0, -1)}x`)).resolves.toBeNull();
  });
  it("accepts JWT through a WebSocket subprotocol without putting it in the URL", async () => {
    const config = env();
    const { token } = await createJwt(config, { username: "admin", role: "ADMIN" });
    const request = new Request("https://worker.example/realtime?deviceId=ESP32_001", { headers: { "Sec-WebSocket-Protocol": `iot-fire, jwt.${token}` } });
    await expect(principalFromRequest(request, config)).resolves.toEqual({ username: "admin", role: "ADMIN" });
  });
  it("verifies ASP.NET Identity V3 PBKDF2 hashes", async () => {
    const hash = identityV3Hash("correct-password");
    await expect(verifyAspNetIdentityPassword(hash, "correct-password")).resolves.toBe(true);
    await expect(verifyAspNetIdentityPassword(hash, "wrong-password")).resolves.toBe(false);
  });
});
