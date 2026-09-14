import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import dns from "node:dns";
import https from "node:https";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Merchant } from "../drizzle/schema";
import { loadQrLogo } from "./qr-logo";
import { renderPaymentQrPng } from "./qr-image";
import { storageRead } from "./storage";
import { decodeQrCard } from "./test-utils/qr-image";

vi.mock("./storage", () => ({ storageRead: vi.fn() }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const receiver = "0x2222222222222222222222222222222222222222";
const value = `ethereum:0x3333333333333333333333333333333333333333@1/transfer?address=${receiver}&uint256=100000000`;
const merchant = {
  name: "QR API Test Store",
  walletAddress: receiver,
  storeAddress: receiver,
  logoData: null,
  qrFgColor: "#123456",
  qrBgColor: "#ffffff",
  qrMode: "standard",
  qrStyle: "rounded",
} as Merchant;

describe("QR logo loading", () => {
  it.each(["https://127.0.0.1/private.png", "https://[invalid"])("rejects unsafe or malformed redirects: %s", async (location) => {
    vi.spyOn(https, "get").mockImplementation(((_url: unknown, _options: unknown, callback: (response: unknown) => void) => {
      const request = new EventEmitter();
      queueMicrotask(() => {
        callback(Object.assign(new EventEmitter(), { statusCode: 302, headers: { location }, destroy() {} }));
        request.emit("close");
      });
      return request;
    }) as typeof https.get);
    await expect(loadQrLogo("https://1.1.1.1/logo.png")).rejects.toThrow();
    expect(https.get).toHaveBeenCalledTimes(1);
  });

  it.each(["http://example.com/logo.png", "https://127.0.0.1/logo.png", "https://[::1]/logo.png", "file:///etc/passwd", "data:text/html;base64,SGk="])("rejects unsafe logo %s", async (logo) => {
    await expect(loadQrLogo(logo)).rejects.toThrow();
  });

  it("loads storage logos without treating the version query as part of the object key", async () => {
    vi.mocked(storageRead).mockResolvedValue({ key: "merchant-logos/test/logo", body: Buffer.from("test"), contentType: "image/png" });
    await expect(loadQrLogo("/api/storage/objects/merchant-logos/test/logo?v=123")).resolves.toBe("data:image/png;base64,dGVzdA==");
    expect(storageRead).toHaveBeenCalledWith("merchant-logos/test/logo", {
      signal: expect.any(AbortSignal), maxBytes: 10 * 1024 * 1024,
    });
  });

  it("rejects encoded path traversal before reading storage", async () => {
    vi.mocked(storageRead).mockClear();
    await expect(loadQrLogo("/api/storage/objects/merchant-logos/%2e%2e%2fprivate/logo")).rejects.toThrow("storage path");
    expect(storageRead).not.toHaveBeenCalled();
  });

  it("bounds DNS resolution and never connects after its deadline", async () => {
    vi.useFakeTimers();
    let resolveDns!: (value: dns.LookupAddress[]) => void;
    vi.spyOn(dns.promises, "lookup").mockImplementation(() => new Promise(resolve => { resolveDns = resolve; }) as any);
    const request = vi.spyOn(https, "get");
    const result = expect(loadQrLogo("https://logos.example.com/logo.png")).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(10000);
    await result;
    resolveDns([{ address: "1.1.1.1", family: 4 }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(request).not.toHaveBeenCalled();
  });

  it("cancels stalled storage reads at the logo deadline", async () => {
    vi.useFakeTimers();
    vi.mocked(storageRead).mockImplementation(() => new Promise(() => {}));
    const result = expect(loadQrLogo("/api/storage/objects/merchant-logos/test/logo")).rejects.toThrow("timed out");
    const options = vi.mocked(storageRead).mock.lastCall![1]!;
    await vi.advanceTimersByTimeAsync(10000);
    await result;
    expect(options.signal!.aborted).toBe(true);
  });

  it("rejects DNS rebinding in the lookup used for the actual connection", async () => {
    vi.spyOn(dns.promises, "lookup").mockResolvedValue([{ address: "1.1.1.1", family: 4 }] as any);
    vi.spyOn(dns, "lookup").mockImplementation(((_hostname: unknown, _options: unknown, callback: Function) => {
      callback(null, [{ address: "127.0.0.1", family: 4 }]);
    }) as typeof dns.lookup);
    vi.spyOn(https, "get").mockImplementation(((_url: unknown, options: any) => {
      const request = new EventEmitter();
      queueMicrotask(() => options.lookup("logos.example.com", { all: true }, (error: Error) => request.emit("error", error)));
      return request;
    }) as typeof https.get);
    await expect(loadQrLogo("https://logos.example.com/logo.png")).rejects.toThrow("Private/local");
  });
});

describe("shared native QR rendering", () => {
  it.each(["standard", "advanced"] as const)("decodes every saved style in %s mode with a logo", async (qrMode) => {
    const logoData = `data:image/png;base64,${(await readFile("client/public/favicon-32x32.png")).toString("base64")}`;
    const images = new Set<string>();
    for (const qrStyle of ["classic", "rounded", "dots", "classy", "classy-rounded"]) {
      const png = await renderPaymentQrPng(value, { ...merchant, qrMode, qrStyle, logoData }, { amount: "100", coin: "USDC" });
      expect(png).toMatch(/^data:image\/png;base64,/);
      expect(decodeQrCard(png), `${qrMode}/${qrStyle}`).toEqual({ width: 1440, height: 1840, value });
      images.add(png);
    }
    // Downloads preserve the legacy "classy" alias.
    expect(images.size).toBe(4);
  }, 15000);

  it.each(["standard", "advanced"])("renders %s mode without a merchant logo", async qrMode => {
    const png = await renderPaymentQrPng(value, { ...merchant, qrMode }, { amount: "100", coin: "USDC" });
    expect(decodeQrCard(png)).toEqual({ width: 1440, height: 1840, value });
  });

  it("falls back to valid styles and colors for legacy merchant settings", async () => {
    const png = await renderPaymentQrPng(value, { ...merchant, qrMode: null, qrStyle: "unknown", qrFgColor: "invalid", qrBgColor: null }, { amount: "100", coin: "USDC" });
    expect(decodeQrCard(png).value).toBe(value);
  });

  it("preserves translucent saved colors", async () => {
    const png = await renderPaymentQrPng(value, { ...merchant, qrStyle: "classic", qrFgColor: "#12345680", qrBgColor: "#ffffff80" }, { amount: "100", coin: "USDC" });
    expect(decodeQrCard(png).value).toBe(value);
    const context = createCanvas(1440, 1840).getContext("2d");
    context.drawImage(await loadImage(png), 0, 0);
    const pixels = context.getImageData(300, 460, 840, 840).data;
    const colors = new Map<string, number>();
    for (let index = 0; index < pixels.length; index += 4) {
      const color = Array.from(pixels.slice(index, index + 4)).join(",");
      colors.set(color, (colors.get(color) || 0) + 1);
    }
    colors.delete("255,255,255,255");
    expect([...colors].sort((a, b) => b[1] - a[1])[0][0]).toBe("136,153,170,255");
  });

  it("fails for invalid image bytes instead of silently dropping saved branding", async () => {
    await expect(renderPaymentQrPng(value, { ...merchant, logoData: "data:image/png;base64,YmFk" }, { amount: "100", coin: "USDC" })).rejects.toMatchObject({ status: 422 });
  });

  it.each(["standard", "advanced"])("rejects an oversized QR payload in %s mode", async qrMode => {
    await expect(renderPaymentQrPng("x".repeat(10000), { ...merchant, qrMode }, { amount: "100", coin: "USDC" })).rejects.toMatchObject({ status: 422 });
  });
});
