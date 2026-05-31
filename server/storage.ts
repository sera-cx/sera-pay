// Preconfigured storage helpers for Manus WebDev templates
// Uses the Biz-provided storage proxy (Authorization: Bearer <token>)

import { ENV } from './_core/env';
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

type StorageConfig = { baseUrl: string; apiKey: string };
type R2Config = { endpoint: string; accessKeyId: string; secretAccessKey: string; bucket: string; publicUrl: string };

let r2Client: S3Client | null = null;

function getR2Config(): R2Config | null {
  const endpoint = ENV.r2Endpoint || (ENV.r2AccountId ? `https://${ENV.r2AccountId}.r2.cloudflarestorage.com` : "");
  if (!endpoint || !ENV.r2AccessKeyId || !ENV.r2SecretAccessKey || !ENV.r2Bucket) return null;
  return {
    endpoint: endpoint.replace(/\/+$/, ""),
    accessKeyId: ENV.r2AccessKeyId,
    secretAccessKey: ENV.r2SecretAccessKey,
    bucket: ENV.r2Bucket,
    publicUrl: ENV.r2PublicUrl.replace(/\/+$/, ""),
  };
}

export function isR2StorageConfigured(): boolean {
  return getR2Config() !== null;
}

function getR2Client(config: R2Config): S3Client {
  if (!r2Client) {
    r2Client = new S3Client({
      region: "auto",
      endpoint: config.endpoint,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: true,
    });
  }
  return r2Client;
}

function buildPublicR2Url(publicUrl: string, key: string): string {
  return `${publicUrl}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

function buildStorageProxyUrl(key: string): string {
  return `/api/storage/objects/${key.split("/").map(encodeURIComponent).join("/")}`;
}

async function streamToBuffer(body: unknown): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof (body as { transformToByteArray?: unknown }).transformToByteArray === "function") {
    const bytes = await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
    return Buffer.from(bytes);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer | Uint8Array | string>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function getStorageConfig(): StorageConfig {
  const baseUrl = ENV.forgeApiUrl;
  const apiKey = ENV.forgeApiKey;

  if (!baseUrl || !apiKey) {
    throw new Error(
      "Storage proxy credentials missing: set BUILT_IN_FORGE_API_URL and BUILT_IN_FORGE_API_KEY"
    );
  }

  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey };
}

function buildUploadUrl(baseUrl: string, relKey: string): URL {
  const url = new URL("v1/storage/upload", ensureTrailingSlash(baseUrl));
  url.searchParams.set("path", normalizeKey(relKey));
  return url;
}

async function buildDownloadUrl(
  baseUrl: string,
  relKey: string,
  apiKey: string
): Promise<string> {
  const downloadApiUrl = new URL(
    "v1/storage/downloadUrl",
    ensureTrailingSlash(baseUrl)
  );
  downloadApiUrl.searchParams.set("path", normalizeKey(relKey));
  const response = await fetch(downloadApiUrl, {
    method: "GET",
    headers: buildAuthHeaders(apiKey),
  });
  return (await response.json()).url;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function normalizeKey(relKey: string): string {
  return relKey.replace(/^\/+/, "");
}

function toFormData(
  data: Buffer | Uint8Array | string,
  contentType: string,
  fileName: string
): FormData {
  const blob =
    typeof data === "string"
      ? new Blob([data], { type: contentType })
      : new Blob([data as any], { type: contentType });
  const form = new FormData();
  form.append("file", blob, fileName || "file");
  return form;
}

function buildAuthHeaders(apiKey: string): HeadersInit {
  return { Authorization: `Bearer ${apiKey}` };
}

export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  contentType = "application/octet-stream"
): Promise<{ key: string; url: string }> {
  const r2 = getR2Config();
  if (r2) {
    const key = normalizeKey(relKey);
    const body = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
    await getR2Client(r2).send(new PutObjectCommand({
      Bucket: r2.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }));
    return { key, url: r2.publicUrl ? buildPublicR2Url(r2.publicUrl, key) : buildStorageProxyUrl(key) };
  }

  const { baseUrl, apiKey } = getStorageConfig();
  const key = normalizeKey(relKey);
  const uploadUrl = buildUploadUrl(baseUrl, key);
  const formData = toFormData(data, contentType, key.split("/").pop() ?? key);
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: buildAuthHeaders(apiKey),
    body: formData,
  });

  if (!response.ok) {
    const message = await response.text().catch(() => response.statusText);
    throw new Error(
      `Storage upload failed (${response.status} ${response.statusText}): ${message}`
    );
  }
  const url = (await response.json()).url;
  return { key, url };
}

export async function storageGet(relKey: string): Promise<{ key: string; url: string; }> {
  const r2 = getR2Config();
  if (r2) {
    const key = normalizeKey(relKey);
    return { key, url: r2.publicUrl ? buildPublicR2Url(r2.publicUrl, key) : buildStorageProxyUrl(key) };
  }

  const { baseUrl, apiKey } = getStorageConfig();
  const key = normalizeKey(relKey);
  return {
    key,
    url: await buildDownloadUrl(baseUrl, key, apiKey),
  };
}

export async function storageRead(relKey: string): Promise<{ key: string; body: Buffer; contentType: string }> {
  const r2 = getR2Config();
  if (!r2) throw new Error("R2 storage is not configured");

  const key = normalizeKey(relKey);
  const response = await getR2Client(r2).send(new GetObjectCommand({ Bucket: r2.bucket, Key: key }));
  return {
    key,
    body: await streamToBuffer(response.Body),
    contentType: response.ContentType || "application/octet-stream",
  };
}
