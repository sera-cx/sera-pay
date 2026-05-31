import crypto from "crypto";

const VERSION = "v1";
const MIN_SECRET_BYTES = 32;

function isStrongSecretMaterial(value: string | undefined): value is string {
  return Boolean(value && Buffer.byteLength(value.trim(), "utf8") >= MIN_SECRET_BYTES);
}

function getSecretMaterial(): string | null {
  const encryptionKey = process.env.SERA_CONFIG_ENCRYPTION_KEY?.trim();
  if (encryptionKey) return isStrongSecretMaterial(encryptionKey) ? encryptionKey : null;

  const fallbackSecret = process.env.SESSION_SECRET?.trim();
  return isStrongSecretMaterial(fallbackSecret) ? fallbackSecret : null;
}

function getKey(): Buffer | null {
  const material = getSecretMaterial();
  return material ? crypto.createHash("sha256").update(material).digest() : null;
}

export function isSecretEncryptionReady(): boolean {
  return getKey() !== null;
}

export function encryptSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  const key = getKey();
  if (!key) {
    throw new Error("Set SERA_CONFIG_ENCRYPTION_KEY to at least 32 bytes before storing Sera API secrets");
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(":");
}

export function decryptSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  const key = getKey();
  if (!key) return null;

  const [version, ivRaw, tagRaw, encryptedRaw] = value.split(":");
  if (version !== VERSION || !ivRaw || !tagRaw || !encryptedRaw) return null;

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64url")),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

export function maskSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length <= 4) return trimmed;
  return trimmed.slice(-4);
}
