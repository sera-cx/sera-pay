import { useEffect, useRef } from "react";
import QRCodeStyling from "qr-code-styling";
import { buildQrOptions, renderAdvancedQr, type QrMode, type QrStyle } from "@shared/qr-style";
import { loadCanvasImage } from "@/lib/canvas-image";
import { createBrowserCanvas } from "@/lib/qrCanvas";
export { buildQrOptions, type QrMode, type QrStyle } from "@shared/qr-style";

export function QRStyled({
  value,
  size = 220,
  fgColor = "#000000",
  bgColor = "#ffffff",
  style = "classic",
  logo,
  mode = "standard",
  className,
}: {
  value: string;
  size?: number;
  fgColor?: string;
  bgColor?: string;
  style?: QrStyle;
  logo?: string;
  mode?: QrMode;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const advancedMode = mode === "advanced";

  useEffect(() => {
    if (!containerRef.current || advancedMode) return;
    const container = containerRef.current;
    container.replaceChildren();
    let cancelled = false;
    try {
      const qr = new QRCodeStyling(buildQrOptions(value, size, fgColor, bgColor, style, logo));
      qr.append(container);
      const rendered = container.firstElementChild;
      if (rendered instanceof HTMLElement || rendered instanceof SVGElement) {
        rendered.style.display = "block";
        rendered.style.width = "100%";
        rendered.style.height = "100%";
      }
      void qr.getRawData("svg").then(() => {
        if (cancelled) return;
        // SVG images use a title instead of the HTML alt attribute.
        container.querySelectorAll("image").forEach((el) => {
          if (!el.querySelector("title")) {
            const t = document.createElementNS("http://www.w3.org/2000/svg", "title");
            t.textContent = "Merchant logo";
            el.prepend(t);
          }
        });
      }).catch(() => {});
    } catch { /* Invalid values leave the preview empty. */ }
    return () => { cancelled = true; };
  }, [value, size, fgColor, bgColor, style, logo, advancedMode]);

  useEffect(() => {
    if (!advancedMode || !canvasRef.current) return;
    const controller = new AbortController();
    const canvas = canvasRef.current;
    const pixelRatio = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const render = async () => {
      renderAdvancedQr(canvas, value, size, bgColor, style, undefined, createBrowserCanvas, pixelRatio);
      if (logo) {
        const image = await loadCanvasImage(logo, controller.signal);
        if (controller.signal.aborted) return;
        renderAdvancedQr(canvas, value, size, bgColor, style, image, createBrowserCanvas, pixelRatio);
      }
    };
    // A missing logo keeps the unbranded QR already drawn above.
    void render().catch(() => {});
    return () => controller.abort();
  }, [advancedMode, bgColor, logo, size, style, value]);

  return (
    <div
      className={className}
      style={{
        width: size,
        maxWidth: "100%",
        aspectRatio: "1 / 1",
        overflow: "hidden",
        display: "block",
        position: "relative",
        borderRadius: advancedMode ? Math.max(10, Math.round(size * 0.04)) : 0,
        background: advancedMode ? bgColor : "transparent",
      }}
      role="img"
      aria-label="Payment QR code"
    >
      {advancedMode ? (
        <canvas ref={canvasRef} style={{ display: "block", width: "100%", height: "100%" }} />
      ) : (
        <div ref={containerRef} style={{ position: "relative", width: "100%", height: "100%" }} />
      )}
    </div>
  );
}

export const QR_STYLES: { id: QrStyle; label: string; desc: string }[] = [
  { id: "classic",        label: "Classic",        desc: "Sharp square modules" },
  { id: "rounded",        label: "Rounded",        desc: "Soft rounded modules" },
  { id: "dots",           label: "Dots",           desc: "Circular dot modules" },
  { id: "classy",         label: "Classy",         desc: "Angled premium modules" },
  { id: "classy-rounded", label: "Classy Rounded", desc: "Angled modules with soft corners" },
];
