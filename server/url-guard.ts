/** Validates public HTTPS targets for merchant webhooks and logo requests. */

import dns from "dns";
import net from "net";

export class UrlGuardError extends Error {
  constructor(message: string, readonly status: number = 400) {
    super(message);
    this.name = "UrlGuardError";
  }
}

const privateAddresses = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) privateAddresses.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10],
  ["fec0::", 10], ["ff00::", 8],
] as const) privateAddresses.addSubnet(address, prefix, "ipv6");

function isPrivateAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  // BlockList also handles expanded and IPv4-mapped IPv6 addresses.
  return kind === 0 || privateAddresses.check(ip, kind === 4 ? "ipv4" : "ipv6");
}

/**
 * Validates that `raw` is an HTTPS URL whose every resolved address is public,
 * and returns the parsed URL. Throws UrlGuardError otherwise. Callers must also
 * validate redirects and the actual connection's lookup to prevent DNS rebinding.
 */
export async function assertPublicHttpUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlGuardError("Invalid URL");
  }
  if (url.protocol !== "https:") {
    throw new UrlGuardError("Only HTTPS URLs are allowed");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^localhost$/i.test(host) || /\.local$/i.test(host) || /\.internal$/i.test(host)) {
    throw new UrlGuardError("Private/local URLs are not allowed");
  }
  // A literal IP is checked directly; a name is fully resolved and every
  // returned address must be public.
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new UrlGuardError("Private/local URLs are not allowed");
    return url;
  }
  let resolved: dns.LookupAddress[];
  try {
    resolved = await dns.promises.lookup(host, { all: true });
  } catch {
    throw new UrlGuardError("Could not resolve webhook host");
  }
  if (!resolved.length) throw new UrlGuardError("Could not resolve webhook host");
  for (const { address } of resolved) {
    if (isPrivateAddress(address)) {
      throw new UrlGuardError("Webhook host resolves to a private address");
    }
  }
  return url;
}
