import { useEffect, useRef } from "react";
import QRCodeStyling, { type Options } from "qr-code-styling";

export type QrStyle = "classic" | "rounded" | "dots" | "classy" | "classy-rounded";

export function buildQrOptions(
  value: string,
  size: number,
  fgColor: string,
  bgColor: string,
  style: QrStyle,
  logo?: string,
): Options {
  const quietZone = Math.max(8, Math.round(size * 0.04));
  const base: Options = {
    width: size,
    height: size,
    data: value,
    type: "svg",
    margin: quietZone,
    backgroundOptions: { color: bgColor } as any,
    dotsOptions: { color: fgColor },
    cornersSquareOptions: { color: fgColor },
    cornersDotOptions: { color: fgColor },
    ...(logo
      ? {
          image: logo,
          qrOptions: { errorCorrectionLevel: "H" },
          // imageSize 0.28 = logo occupies ~28% of QR width (up from 0.18)
          imageOptions: { hideBackgroundDots: true, imageSize: 0.28, margin: 3, crossOrigin: "anonymous" },
        }
      : {
          qrOptions: { errorCorrectionLevel: "M" },
        }),
  };

  switch (style) {
    case "rounded":
      return { ...base,
        dotsOptions: { ...base.dotsOptions, type: "extra-rounded" },
        cornersSquareOptions: { ...base.cornersSquareOptions, type: "extra-rounded" },
        cornersDotOptions: { ...base.cornersDotOptions, type: "dot" },
      };
    case "dots":
      return { ...base,
        dotsOptions: { ...base.dotsOptions, type: "dots" },
        cornersSquareOptions: { ...base.cornersSquareOptions, type: "dot" },
        cornersDotOptions: { ...base.cornersDotOptions, type: "dot" },
      };
    case "classy":
      return { ...base,
        dotsOptions: { ...base.dotsOptions, type: "classy" },
        cornersSquareOptions: { ...base.cornersSquareOptions, type: "square" },
        cornersDotOptions: { ...base.cornersDotOptions, type: "square" },
      };
    case "classy-rounded":
      return { ...base,
        dotsOptions: { ...base.dotsOptions, type: "classy-rounded" },
        cornersSquareOptions: { ...base.cornersSquareOptions, type: "extra-rounded" },
        cornersDotOptions: { ...base.cornersDotOptions, type: "dot" },
      };
    case "classic":
    default:
      return { ...base,
        dotsOptions: { ...base.dotsOptions, type: "square" },
        cornersSquareOptions: { ...base.cornersSquareOptions, type: "square" },
        cornersDotOptions: { ...base.cornersDotOptions, type: "square" },
      };
  }
}

export function QRStyled({
  value,
  size = 220,
  fgColor = "#000000",
  bgColor = "#ffffff",
  style = "classic",
  logo,
  className,
}: {
  value: string;
  size?: number;
  fgColor?: string;
  bgColor?: string;
  style?: QrStyle;
  logo?: string;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    containerRef.current.innerHTML = "";
    const qr = new QRCodeStyling(buildQrOptions(value, size, fgColor, bgColor, style, logo));
    qr.append(containerRef.current);
    const rendered = containerRef.current.firstElementChild as HTMLElement | SVGElement | null;
    if (rendered instanceof HTMLElement || rendered instanceof SVGElement) {
      rendered.style.display = "block";
      rendered.style.width = "100%";
      rendered.style.height = "100%";
    }
    // Add accessible <title> to any SVG <image> elements injected by the library.
    // SVG <image> does not support the HTML alt attribute; <title> is the SVG equivalent.
    setTimeout(() => {
      containerRef.current?.querySelectorAll("image").forEach((el) => {
        if (!el.querySelector("title")) {
          const t = document.createElementNS("http://www.w3.org/2000/svg", "title");
          t.textContent = "Merchant logo";
          el.prepend(t);
        }
      });
    }, 50);
  }, [value, size, fgColor, bgColor, style, logo]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ width: size, maxWidth: "100%", aspectRatio: "1 / 1", overflow: "hidden", display: "block" }}
      role="img"
      aria-label="Payment QR code"
    />
  );
}

export const QR_STYLES: { id: QrStyle; label: string; desc: string }[] = [
  { id: "classic",        label: "Classic",        desc: "Sharp square modules" },
  { id: "rounded",        label: "Rounded",        desc: "Soft rounded modules" },
  { id: "dots",           label: "Dots",           desc: "Circular dot modules" },
  { id: "classy",         label: "Classy",         desc: "Angled premium modules" },
  { id: "classy-rounded", label: "Classy Rounded", desc: "Angled modules with soft corners" },
];
