/**
 * Short-lived dashboard session tokens.
 *
 * The merchant API key is a shown-once credential for server-to-server API
 * use — it is returned at creation or regeneration and never stored in
 * plaintext. The dashboard, which authenticates a merchant on every Privy
 * login and cannot be handed the same key again, mints one of these tokens
 * from /merchant/register instead: an HMAC-signed JWT whose subject is the
 * merchant id. requireApiKey accepts both credential kinds.
 */

import crypto from "crypto";
import { SignJWT, jwtVerify } from "jose";

const ISSUER = "serapay-dashboard";
const AUDIENCE = "serapay-dashboard-api";
export const DASHBOARD_SESSION_TTL_SECONDS = 24 * 60 * 60;

function getSigningKey(): Uint8Array | null {
  const secret = process.env.SESSION_SECRET?.trim();
  if (secret && Buffer.byteLength(secret, "utf8") >= 32) {
    return crypto.createHash("sha256").update(`serapay-dashboard-session:v1:${secret}`).digest();
  }
  // validateRuntimeEnv refuses to boot production without a strong
  // SESSION_SECRET, so a missing key can only be development or tests.
  if (process.env.NODE_ENV === "production") return null;
  return crypto.createHash("sha256").update("serapay-dashboard-session:v1:development").digest();
}

export async function issueDashboardSession(
  merchantId: string,
  walletAddress: string,
  ttlSeconds: number = DASHBOARD_SESSION_TTL_SECONDS,
): Promise<string> {
  const key = getSigningKey();
  if (!key) throw new Error("SESSION_SECRET must be at least 32 bytes to issue dashboard sessions");
  return await new SignJWT({ wallet: walletAddress, typ: "dashboard-session" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(merchantId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key);
}

export async function verifyDashboardSession(token: string): Promise<{ merchantId: string } | null> {
  const key = getSigningKey();
  if (!key || typeof token !== "string" || !token) return null;
  try {
    const { payload } = await jwtVerify(token, key, { issuer: ISSUER, audience: AUDIENCE });
    if ((payload as Record<string, unknown>).typ !== "dashboard-session") return null;
    if (typeof payload.sub !== "string" || !payload.sub) return null;
    return { merchantId: payload.sub };
  } catch {
    return null;
  }
}
