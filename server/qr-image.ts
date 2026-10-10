import { createRequire } from "node:module";
import path from "node:path";
import * as canvas from "@napi-rs/canvas";
import { JSDOM } from "jsdom";
import QRCodeStyling, { type Options } from "qr-code-styling";
import type { Merchant } from "../drizzle/schema";
import { renderPaymentQrCard, type QrCanvasRuntime } from "../shared/qr-card";
import { buildQrOptions, renderAdvancedQr, type QrStyle } from "../shared/qr-style";
import { loadQrLogo } from "./qr-logo";

const require = createRequire(import.meta.url);
// Alpine has no system fonts; keep downloaded payment details legible there.
for (const weight of [600, 700, 800]) {
  canvas.GlobalFonts.registerFromPath(require.resolve(`@fontsource/inter/files/inter-latin-${weight}-normal.woff`), "Inter");
}

const runtime: QrCanvasRuntime = {
  createCanvas: (width, height) => canvas.createCanvas(width, height) as unknown as HTMLCanvasElement,
  loadImage: async src => await canvas.loadImage(src) as unknown as HTMLImageElement,
  async renderQr(options, size) {
    const style = options.qrStyle as QrStyle;
    if (options.qrMode === "advanced") {
      const image = runtime.createCanvas(size, size);
      const logo = options.merchantLogo ? await runtime.loadImage(options.merchantLogo) : undefined;
      renderAdvancedQr(image, options.qrValue, size, options.bgColor!, style, logo, runtime.createCanvas, 2);
      return image;
    }
    const qr = new QRCodeStyling({ jsdom: JSDOM, nodeCanvas: canvas as unknown as Options["nodeCanvas"], type: "svg" });
    try {
      // Draw the generated shapes directly; Skia is slow at their redundant color clips.
      qr.applyExtension(svg => {
        for (const rect of svg.querySelectorAll("rect[clip-path]")) {
          const clip = svg.querySelector(rect.getAttribute("clip-path")!.match(/#[\w-]+/)![0])!;
          const group = svg.ownerDocument.createElementNS(svg.namespaceURI, "g");
          const color = rect.getAttribute("fill")!;
          group.setAttribute("fill", color.slice(0, 7));
          // Skia's SVG parser needs alpha separately from the hex color.
          if (color.length === 9) group.setAttribute("opacity", String(parseInt(color.slice(7), 16) / 255));
          group.append(...clip.children);
          rect.replaceWith(group);
        }
      });
      qr.update(buildQrOptions(options.qrValue, size, options.fgColor!, options.bgColor!, style, options.merchantLogo || undefined));
      return await canvas.loadImage(await qr.getRawData("svg") as Buffer) as unknown as HTMLImageElement;
    } finally {
      qr._window.close();
    }
  },
};

export class QrImageError extends Error {
  constructor(message: string, readonly status = 422) {
    super(message);
    this.name = "QrImageError";
  }
}

export async function renderPaymentQrPng(
  qrValue: string,
  merchant: Merchant,
  payment: { amount: string; coin: string },
): Promise<string> {
  try {
    return await renderPaymentQrCard({
      qrValue,
      receiverAddress: (merchant.storeAddress || merchant.walletAddress).toLowerCase(),
      ...payment,
      merchantName: merchant.name,
      merchantLogo: await loadQrLogo(merchant.logoData),
      fgColor: merchant.qrFgColor,
      bgColor: merchant.qrBgColor,
      qrStyle: merchant.qrStyle,
      qrMode: merchant.qrMode,
      strictImages: true,
      footerIcon: path.resolve(process.env.NODE_ENV === "production" ? "dist/public/favicon-32x32.png" : "client/public/favicon-32x32.png"),
    }, runtime);
  } catch {
    throw new QrImageError("Unable to render payment QR with the saved branding");
  }
}
