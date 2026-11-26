import { useLayoutEffect, useRef } from "react";
import { QRCodeSVG } from "qrcode.react";

export function PaymentQrCode({ value, size = 320, title = "Scan to open checkout", logoSrc, level = "M" }: {
  value: string;
  size?: number;
  title?: string;
  logoSrc?: string;
  level?: "M" | "L";
}) {
  const ref = useRef<SVGSVGElement>(null);
  useLayoutEffect(() => {
    const svg = ref.current;
    const container = svg?.parentElement;
    if (!svg || !container) return;
    const modules = svg.viewBox.baseVal.width;
    const fit = () => {
      // Whole device pixels keep the squares of a long signed URL distinct on narrow screens.
      const limit = Math.min(size, container.getBoundingClientRect().width);
      const ratio = window.devicePixelRatio || 1;
      const pixelsPerModule = Math.floor(limit * ratio / modules);
      if (pixelsPerModule >= 1) svg.style.width = (modules * pixelsPerModule / ratio) + "px";
    };
    fit();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    observer?.observe(container);
    window.addEventListener("resize", fit);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, [value, size, level]);
  // Keep the mark small enough to leave room for long signed links on a phone.
  const logoSize = Math.round(size * 0.14);
  return (
    <QRCodeSVG
      ref={ref}
      value={value}
      size={size}
      level={level}
      marginSize={4}
      fgColor="#10392f"
      bgColor="#ffffff"
      imageSettings={logoSrc ? { src: logoSrc, width: logoSize, height: logoSize, excavate: true } : undefined}
      style={{ display: "block", maxWidth: "100%", height: "auto" }}
      role="img"
      title={title}
    />
  );
}
