import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import dns from "dns";
import { UrlGuardError, assertPublicHttpUrl } from "./url-guard";

// Every test installs a lookup mock before the guard runs. Two reasons: the
// suite must never touch real DNS (CI has no network guarantees, and a real
// resolver could turn a deterministic test into a flaky one), and a literal-IP
// test that *did* reach lookup would be a regression — the guard is supposed to
// decide literals without resolving — so the default mock fails loudly.
let lookupSpy: ReturnType<typeof vi.spyOn<typeof dns.promises, "lookup">>;

beforeEach(() => {
  lookupSpy = vi.spyOn(dns.promises, "lookup").mockRejectedValue(new Error("unexpected DNS lookup in test"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

// @types/node's final `lookup` overload returns a single record, so vitest
// types mockResolvedValue against that; the guard always calls with
// `{ all: true }` and gets an array, which is what we hand back here.
function resolveTo(records: dns.LookupAddress[]) {
  lookupSpy.mockResolvedValue(records as unknown as dns.LookupAddress);
}

function record(address: string): dns.LookupAddress {
  return { address, family: address.includes(":") ? 6 : 4 };
}

async function expectGuardError(raw: string, message: string) {
  let error: unknown;
  try {
    await assertPublicHttpUrl(raw);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(UrlGuardError);
  expect((error as UrlGuardError).status).toBe(400);
  expect((error as UrlGuardError).message).toContain(message);
}

describe("UrlGuardError", () => {
  it("defaults to status 400 and carries a stable name", () => {
    const error = new UrlGuardError("nope");
    expect(error.status).toBe(400);
    expect(error.name).toBe("UrlGuardError");
    expect(error.message).toBe("nope");
    expect(error).toBeInstanceOf(Error);
  });

  it("accepts an explicit status", () => {
    expect(new UrlGuardError("nope", 502).status).toBe(502);
  });
});

describe("URL shape", () => {
  it.each(["not a url", "", "https://", "//example.com/hook", "example.com/hook"])(
    "rejects %j as an invalid URL",
    async (raw) => {
      await expectGuardError(raw, "Invalid URL");
      expect(lookupSpy).not.toHaveBeenCalled();
    },
  );

  it.each([
    "http://example.com/hook",
    "http://8.8.8.8/hook",
    "ftp://example.com/hook",
    "file:///etc/passwd",
  ])("rejects non-HTTPS scheme %s", async (raw) => {
    await expectGuardError(raw, "Only HTTPS URLs are allowed");
    expect(lookupSpy).not.toHaveBeenCalled();
  });
});

describe("blocked hostnames", () => {
  it.each([
    "https://localhost/",
    "https://LOCALHOST/",
    "https://localhost:3000/api/hook",
    "https://printer.local/",
    "https://Printer.LOCAL/",
    "https://metadata.internal/",
    "https://db.Internal/",
    "https://a.b.c.internal/hook",
  ])("blocks %s without resolving it", async (raw) => {
    await expectGuardError(raw, "Private/local URLs are not allowed");
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  it("does not block names that merely contain the suffix as a substring", async () => {
    // "local" and "internal" are only special as a trailing label; a public
    // host whose name happens to start with them must still go through DNS.
    resolveTo([record("8.8.8.8")]);
    await expect(assertPublicHttpUrl("https://localhost.example.com/")).resolves.toBeInstanceOf(URL);
    await expect(assertPublicHttpUrl("https://internal-hooks.example.com/")).resolves.toBeInstanceOf(URL);
  });
});

describe("IPv4 literals", () => {
  it.each([
    "0.0.0.0",           // 0.0.0.0/8 "this host"
    "10.0.0.1",          // RFC1918
    "100.64.0.1",        // CGNAT lower bound
    "100.126.11.86",     // this deployment's Tailscale database
    "100.127.255.255",   // CGNAT upper bound
    "100.100.100.100",   // Tailscale MagicDNS
    "127.0.0.1",         // loopback
    "127.255.255.254",   // loopback upper range
    "169.254.169.254",   // cloud metadata endpoint
    "172.16.0.1",        // RFC1918 lower bound
    "172.31.255.255",    // RFC1918 upper bound
    "192.0.0.1",         // IETF protocol assignments
    "192.168.1.1",       // RFC1918
    "198.18.0.1",        // benchmarking lower bound
    "198.19.255.255",    // benchmarking upper bound
    "224.0.0.1",         // multicast lower bound
    "239.255.255.255",   // multicast upper bound
    "240.0.0.1",         // reserved
    "255.255.255.255",   // broadcast
  ])("blocks https://%s/", async (ip) => {
    await expectGuardError(`https://${ip}/hook`, "Private/local URLs are not allowed");
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  // Each of these sits one address outside a blocked range. They pin the CIDR
  // arithmetic so a future off-by-one in the mask cannot silently widen the
  // blocklist onto real merchants or narrow it off the ranges we care about.
  it.each([
    "100.63.255.255",    // just below CGNAT 100.64.0.0/10
    "100.128.0.0",       // just above CGNAT
    "172.15.255.255",    // just below 172.16.0.0/12
    "172.32.0.1",        // just above 172.16.0.0/12
    "192.0.1.1",         // just above 192.0.0.0/24
    "198.17.255.255",    // just below 198.18.0.0/15
    "198.20.0.1",        // just above 198.18.0.0/15
    "223.255.255.255",   // just below multicast 224.0.0.0/4
    "8.8.8.8",
    "1.1.1.1",
  ])("allows https://%s/ without resolving it", async (ip) => {
    const url = await assertPublicHttpUrl(`https://${ip}/hook`);
    expect(url).toBeInstanceOf(URL);
    expect(url.hostname).toBe(ip);
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  // WHATWG URL parsing normalises octal, decimal, hex and short-form IPv4 into
  // dotted-decimal before the guard ever sees the hostname. The guard relies on
  // that canonicalisation rather than parsing the alternate forms itself, so
  // each case asserts what `hostname` became to document the mechanism.
  it.each([
    ["https://0177.0.0.1/", "127.0.0.1"],   // octal first octet
    ["https://2130706433/", "127.0.0.1"],   // single 32-bit decimal
    ["https://0x7f000001/", "127.0.0.1"],   // single 32-bit hex
    ["https://127.1/", "127.0.0.1"],        // two-part shorthand
  ])("blocks %s, which URL canonicalises to %s", async (raw, canonical) => {
    expect(new URL(raw).hostname).toBe(canonical);
    await expectGuardError(raw, "Private/local URLs are not allowed");
    expect(lookupSpy).not.toHaveBeenCalled();
  });
});

describe("IPv6 literals", () => {
  it.each([
    "[::1]",                // loopback
    "[::]",                 // unspecified
    "[fc00::1]",            // ULA lower half
    "[fd12:3456::1]",       // ULA upper half
    "[fe80::1]",            // link-local
    "[fe90::1]",            // link-local /10 includes more than fe80
    "[febf:ffff::1]",       // link-local upper bound
    "[fec0::1]",            // deprecated site-local
    "[ff02::1]",            // link-local multicast
    "[::ffff:a00:1]",       // IPv4-mapped 10.0.0.1, hex form
    "[::ffff:7f00:1]",      // IPv4-mapped 127.0.0.1, hex form
  ])("blocks https://%s/", async (host) => {
    await expectGuardError(`https://${host}/hook`, "Private/local URLs are not allowed");
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  // The dotted IPv4-mapped form does not survive URL parsing: WHATWG rewrites
  // the trailing v4 into two hex groups, so the literal path always hits the
  // hex-mapped branch. The dotted branch is still reachable through DNS
  // results (see below), which is why the guard keeps both.
  it.each([
    ["https://[::ffff:10.0.0.1]/", "[::ffff:a00:1]"],
    ["https://[::ffff:127.0.0.1]/", "[::ffff:7f00:1]"],
  ])("blocks %s, which URL canonicalises to %s", async (raw, canonical) => {
    expect(new URL(raw).hostname).toBe(canonical);
    await expectGuardError(raw, "Private/local URLs are not allowed");
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  it.each([
    "[2606:4700::1111]",       // Cloudflare
    "[2001:4860:4860::8888]",  // Google
  ])("allows https://%s/ without resolving it", async (host) => {
    const url = await assertPublicHttpUrl(`https://${host}/hook`);
    expect(url).toBeInstanceOf(URL);
    expect(url.hostname).toBe(host);
    expect(lookupSpy).not.toHaveBeenCalled();
  });
});

describe("hostnames that need DNS", () => {
  it("resolves the bare hostname with all:true and returns the URL when every record is public", async () => {
    resolveTo([record("8.8.8.8"), record("2001:4860:4860::8888")]);
    const url = await assertPublicHttpUrl("https://hooks.example.com/pay/callback");
    expect(url).toBeInstanceOf(URL);
    expect(url.href).toBe("https://hooks.example.com/pay/callback");
    // Proves the spy is what the module called — not a copy of the dns object
    // — and that it asks for every record rather than the first one.
    expect(lookupSpy).toHaveBeenCalledTimes(1);
    expect(lookupSpy).toHaveBeenCalledWith("hooks.example.com", { all: true });
  });

  it("rejects when one IPv4 record among public ones is private", async () => {
    resolveTo([record("8.8.8.8"), record("10.0.0.5")]);
    await expectGuardError("https://hooks.example.com/", "Webhook host resolves to a private address");
  });

  it("rejects when the private record is the Tailscale database", async () => {
    resolveTo([record("1.1.1.1"), record("100.126.11.86")]);
    await expectGuardError("https://hooks.example.com/", "Webhook host resolves to a private address");
  });

  it("rejects when one IPv6 record among public ones is private", async () => {
    resolveTo([record("2606:4700::1111"), record("fd00::1")]);
    await expectGuardError("https://hooks.example.com/", "Webhook host resolves to a private address");
  });

  it("rejects an IPv4-mapped IPv6 record in dotted form", async () => {
    // A resolver can hand back the dotted-mapped spelling that the URL parser
    // never produces; this is the only way the dotted branch is exercised.
    resolveTo([record("8.8.8.8"), record("::ffff:10.0.0.1")]);
    await expectGuardError("https://hooks.example.com/", "Webhook host resolves to a private address");
  });

  it("rejects an IPv4-mapped IPv6 record in hex form", async () => {
    resolveTo([record("8.8.8.8"), record("::ffff:7f00:1")]);
    await expectGuardError("https://hooks.example.com/", "Webhook host resolves to a private address");
  });

  it.each(["0:0:0:0:0:0:0:1", "0:0:0:0:0:ffff:a00:1", "febf::1"])("rejects nonpublic IPv6 DNS result %s", async (address) => {
    resolveTo([record("8.8.8.8"), record(address)]);
    await expectGuardError("https://hooks.example.com/", "Webhook host resolves to a private address");
  });

  it("rejects a record that is not an IP literal at all", async () => {
    resolveTo([record("8.8.8.8"), { address: "not-an-ip", family: 4 }]);
    await expectGuardError("https://hooks.example.com/", "Webhook host resolves to a private address");
  });

  it("rejects when lookup returns no records", async () => {
    resolveTo([]);
    await expectGuardError("https://hooks.example.com/", "Could not resolve webhook host");
  });

  it("rejects when lookup throws", async () => {
    lookupSpy.mockRejectedValue(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }));
    await expectGuardError("https://hooks.example.com/", "Could not resolve webhook host");
  });
});

describe("returned URL", () => {
  it("preserves port, path, query and fragment for a public IP literal", async () => {
    const url = await assertPublicHttpUrl("https://8.8.8.8:8443/hooks/pay?order=42&sig=abc#frag");
    expect(url.protocol).toBe("https:");
    expect(url.hostname).toBe("8.8.8.8");
    expect(url.port).toBe("8443");
    expect(url.pathname).toBe("/hooks/pay");
    expect(url.search).toBe("?order=42&sig=abc");
    expect(url.hash).toBe("#frag");
    expect(url.href).toBe("https://8.8.8.8:8443/hooks/pay?order=42&sig=abc#frag");
  });

  it("preserves port, path and query for a resolved public hostname", async () => {
    resolveTo([record("93.184.216.34")]);
    const url = await assertPublicHttpUrl("https://hooks.example.com:8443/pay/callback?order=42");
    expect(url.hostname).toBe("hooks.example.com");
    expect(url.port).toBe("8443");
    expect(url.pathname).toBe("/pay/callback");
    expect(url.search).toBe("?order=42");
    expect(url.href).toBe("https://hooks.example.com:8443/pay/callback?order=42");
  });
});
