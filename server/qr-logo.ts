import dns from "node:dns";
import https from "node:https";
import { storageRead } from "./storage";
import { assertPublicHttpUrl } from "./url-guard";

const MAX_LOGO_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPE = /^image\/(png|jpeg|jpg|webp|gif|svg\+xml)$/i;

function imageDataUrl(body: Buffer, type: string) {
  const mime = type.split(";")[0].trim();
  if (!IMAGE_TYPE.test(mime) || !body.length || body.length > MAX_LOGO_BYTES) {
    throw new Error("Invalid merchant logo image");
  }
  return `data:${mime};base64,${body.toString("base64")}`;
}

async function fetchLogo(raw: string, signal: AbortSignal, redirects = 0): Promise<string> {
  const url = await assertPublicHttpUrl(raw);
  signal.throwIfAborted();
  if (url.username || url.password) throw new Error("Invalid merchant logo URL");
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      signal,
      // Check the actual connection's DNS result, avoiding a second, unchecked
      // resolution between validation and connecting to the logo host.
      lookup(hostname, _options, callback) {
        dns.lookup(hostname, { all: true }, async (error, addresses) => {
          if (error) { callback(error, []); return; }
          try {
            if (!addresses.length) throw new Error("Unable to resolve logo host");
            await Promise.all(addresses.map(({ address, family }) =>
              assertPublicHttpUrl(`https://${family === 6 ? `[${address}]` : address}`)));
            if (_options.all) callback(null, addresses);
            else callback(null, addresses[0].address, addresses[0].family);
          } catch (error) {
            callback(error as NodeJS.ErrnoException, []);
          }
        });
      },
    }, (response) => {
      response.on("error", reject);
      if ([301, 302, 303, 307, 308].includes(response.statusCode || 0) && response.headers.location) {
        response.destroy();
        if (redirects >= 3) { reject(new Error("Too many logo redirects")); return; }
        try { resolve(fetchLogo(new URL(response.headers.location, url).href, signal, redirects + 1)); }
        catch (error) { reject(error); }
        return;
      }
      if (response.statusCode !== 200) {
        response.destroy();
        reject(new Error("Unable to load merchant logo"));
        return;
      }
      if (!IMAGE_TYPE.test((response.headers["content-type"] || "").split(";")[0].trim())) {
        response.destroy();
        reject(new Error("Invalid merchant logo image"));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_LOGO_BYTES) request.destroy(new Error("Merchant logo is too large"));
        else chunks.push(chunk);
      });
      response.on("end", () => {
        try { resolve(imageDataUrl(Buffer.concat(chunks), response.headers["content-type"] || "")); }
        catch (error) { reject(error); }
      });
    });
    request.on("error", reject);
  });
}

async function resolveQrLogo(logo: string, signal: AbortSignal): Promise<string> {
  if (logo.startsWith("data:")) {
    const match = /^data:(image\/[a-z+]+);base64,([a-z0-9+/=\s]+)$/i.exec(logo);
    if (!match || match[2].length > MAX_LOGO_BYTES * 1.4) throw new Error("Invalid merchant logo image");
    return imageDataUrl(Buffer.from(match[2], "base64"), match[1]);
  }
  if (logo.startsWith("/api/storage/objects/")) {
    const key = decodeURIComponent(new URL(logo, "https://storage.invalid").pathname.slice("/api/storage/objects/".length));
    if (!key.startsWith("merchant-logos/") || key.split(/[\\/]/).some(part => part === ".." || part === ".")) {
      throw new Error("Invalid merchant logo storage path");
    }
    const object = await storageRead(key, { signal, maxBytes: MAX_LOGO_BYTES });
    return imageDataUrl(object.body, object.contentType);
  }
  return fetchLogo(logo, signal);
}

/** Resolve and validate saved branding before rendering. */
export async function loadQrLogo(logo: string | null): Promise<string | null> {
  if (!logo) return null;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      resolveQrLogo(logo, controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error("Merchant logo request timed out");
          controller.abort(error);
          reject(error);
        }, 10000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
