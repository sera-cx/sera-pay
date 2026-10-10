import QRCodeStyling from "qr-code-styling";
import type { QrCanvasRuntime } from "@shared/qr-card";
import { buildQrOptions, renderAdvancedQr, type QrStyle } from "@shared/qr-style";
import { loadCanvasImage } from "./canvas-image";

export function createBrowserCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export const browserQrCanvas: QrCanvasRuntime = {
  createCanvas: createBrowserCanvas,
  loadImage: loadCanvasImage,
  async renderQr(options, size) {
    const fg = options.fgColor!, bg = options.bgColor!;
    const style = options.qrStyle as QrStyle;
    if (options.qrMode === "advanced") {
      const canvas = createBrowserCanvas(size, size);
      const logo = options.merchantLogo ? await loadCanvasImage(options.merchantLogo) : undefined;
      renderAdvancedQr(canvas, options.qrValue, size, bg, style, logo, createBrowserCanvas, 2);
      return canvas;
    }
    const qr = new QRCodeStyling(buildQrOptions(options.qrValue, size, fg, bg, style, options.merchantLogo || undefined));
    const blob = await new Promise<Blob>((resolve, reject) => {
      // The library does not reject when its embedded logo fails to load.
      const timer = setTimeout(() => reject(new Error("QR image rendering timed out")), 15000);
      void qr.getRawData("svg").then(data => resolve(data as Blob), reject).finally(() => clearTimeout(timer));
    });
    const url = URL.createObjectURL(blob);
    try { return await loadCanvasImage(url); }
    finally { URL.revokeObjectURL(url); }
  },
};
