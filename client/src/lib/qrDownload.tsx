import React from "react";
import { createRoot } from "react-dom/client";
import { QRStyled, type QrMode, type QrStyle } from "@/components/QRStyled";

type PaymentQrDownloadOptions = {
  qrValue: string;
  receiverAddress: string;
  amount?: string | null;
  coin?: string | null;
  merchantName?: string | null;
  merchantLogo?: string | null;
  fgColor?: string | null;
  bgColor?: string | null;
  qrStyle?: QrStyle | string | null;
  qrMode?: QrMode | string | null;
  filename?: string;
};

const QR_STYLE_FALLBACK: QrStyle = "rounded";

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function normalizeQrStyle(value: PaymentQrDownloadOptions["qrStyle"]): QrStyle {
  if (value === "classic" || value === "rounded" || value === "dots" || value === "classy-rounded") return value;
  if (value === "classy") return "classy-rounded";
  return QR_STYLE_FALLBACK;
}

function normalizeQrMode(value: PaymentQrDownloadOptions["qrMode"]): QrMode {
  return value === "advanced" ? "advanced" : "standard";
}

function safeHex(value: string | null | undefined, fallback: string) {
  const trimmed = String(value || "").trim();
  return /^#[0-9a-f]{6}$/i.test(trimmed) || /^#[0-9a-f]{8}$/i.test(trimmed) ? trimmed : fallback;
}

function splitAddress(address: string) {
  const trimmed = address.trim();
  if (trimmed.length <= 12) return { start: trimmed, middle: "", end: "" };
  return {
    start: trimmed.slice(0, 6),
    middle: trimmed.slice(6, -6),
    end: trimmed.slice(-6),
  };
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function fillRoundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  roundedRect(ctx, x, y, width, height, radius);
  ctx.fill();
}

function loadCanvasImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Unable to load image"));
    image.src = src;
  });
}

async function loadCanvasImageOrNull(src: string | null | undefined) {
  if (!src) return null;
  try {
    return await loadCanvasImage(src);
  } catch {
    return null;
  }
}

function drawImageCoverCircle(ctx: CanvasRenderingContext2D, image: HTMLImageElement, x: number, y: number, size: number) {
  const imageWidth = image.naturalWidth || image.width || size;
  const imageHeight = image.naturalHeight || image.height || size;
  const scale = Math.max(size / imageWidth, size / imageHeight);
  const drawWidth = imageWidth * scale;
  const drawHeight = imageHeight * scale;
  ctx.save();
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(image, x + (size - drawWidth) / 2, y + (size - drawHeight) / 2, drawWidth, drawHeight);
  ctx.restore();
}

function drawSingleLineAddress(ctx: CanvasRenderingContext2D, address: string, x: number, y: number, maxWidth: number, preferredFontSize = 14) {
  const parts = splitAddress(address);
  let fontSize = preferredFontSize;
  const measure = (part: string, weight: number) => {
    ctx.font = `${weight} ${fontSize}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
    return ctx.measureText(part).width;
  };
  const totalWidth = () => measure(parts.start, 800) + measure(parts.middle, 600) + measure(parts.end, 800);
  while (totalWidth() > maxWidth && fontSize > 8) fontSize -= 0.5;

  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  let cursor = x - totalWidth() / 2;
  const drawPart = (part: string, color: string, weight: number) => {
    if (!part) return;
    ctx.font = `${weight} ${fontSize}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
    ctx.fillStyle = color;
    ctx.fillText(part, cursor, y);
    cursor += ctx.measureText(part).width;
  };
  drawPart(parts.start, "#0A1F1A", 800);
  drawPart(parts.middle, "rgba(60,60,67,0.28)", 600);
  drawPart(parts.end, "#0A1F1A", 800);
}

async function renderQrImage(options: Required<Pick<PaymentQrDownloadOptions, "qrValue" | "receiverAddress">> & PaymentQrDownloadOptions, size: number) {
  const host = document.createElement("div");
  host.style.position = "fixed";
  host.style.left = "-10000px";
  host.style.top = "0";
  host.style.width = `${size}px`;
  host.style.height = `${size}px`;
  host.style.background = safeHex(options.bgColor, "#ffffff");
  host.style.pointerEvents = "none";
  document.body.appendChild(host);

  const root = createRoot(host);
  root.render(
    <QRStyled
      value={options.qrValue}
      size={size}
      fgColor={safeHex(options.fgColor, "#000000")}
      bgColor={safeHex(options.bgColor, "#ffffff")}
      style={normalizeQrStyle(options.qrStyle)}
      mode={normalizeQrMode(options.qrMode)}
      logo={options.merchantLogo || undefined}
    />,
  );

  await sleep(normalizeQrMode(options.qrMode) === "advanced" && options.merchantLogo ? 650 : 250);
  try {
    const canvas = host.querySelector("canvas");
    if (canvas instanceof HTMLCanvasElement) {
      return await loadCanvasImage(canvas.toDataURL("image/png"));
    }

    const svg = host.querySelector("svg");
    if (svg) {
      const clone = svg.cloneNode(true) as SVGElement;
      clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      const svgText = new XMLSerializer().serializeToString(clone);
      const objectUrl = URL.createObjectURL(new Blob([svgText], { type: "image/svg+xml;charset=utf-8" }));
      try {
        return await loadCanvasImage(objectUrl);
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    }

    throw new Error("QR image is not ready yet");
  } finally {
    root.unmount();
    host.remove();
  }
}

function drawDownloadFooter(ctx: CanvasRenderingContext2D, width: number, y: number, icon: HTMLImageElement | null) {
  const text = "Powered by SeraPay \u00b7 Sera Protocol";
  const iconSize = 18;
  const gap = icon ? 7 : 0;
  ctx.font = "700 15px -apple-system, BlinkMacSystemFont, 'SF Pro Display', Inter, sans-serif";
  const textWidth = ctx.measureText(text).width;
  const totalWidth = (icon ? iconSize + gap : 0) + textWidth;
  let cursor = width / 2 - totalWidth / 2;
  if (icon) {
    ctx.drawImage(icon, cursor, y - iconSize / 2, iconSize, iconSize);
    cursor += iconSize + gap;
  }
  ctx.fillStyle = "rgba(10,31,26,0.34)";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, cursor, y);
}

function safeFilename(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "payment";
}

export async function downloadPaymentQrCard(options: PaymentQrDownloadOptions) {
  if (!options.qrValue || !options.receiverAddress) throw new Error("Missing QR payment details");

  const scale = 2;
  const width = 720;
  const height = 920;
  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Unable to prepare QR download");
  ctx.scale(scale, scale);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  const bg = "#F2FAF6";
  const cardX = 42;
  const cardY = 46;
  const cardW = width - cardX * 2;
  const cardH = 780;
  const merchantName = options.merchantName || "SeraPay";
  const displayAmount = String(options.amount || "").trim();
  const displayCoin = String(options.coin || "").trim().toUpperCase();

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.shadowColor = "rgba(10,31,26,0.10)";
  ctx.shadowBlur = 28;
  ctx.shadowOffsetY = 8;
  ctx.fillStyle = "#ffffff";
  fillRoundedRect(ctx, cardX, cardY, cardW, cardH, 30);
  ctx.restore();

  const logoImage = await loadCanvasImageOrNull(options.merchantLogo);
  const seraIcon = await loadCanvasImageOrNull("/favicon-32x32.png");

  const logoSize = 74;
  const logoX = width / 2 - logoSize / 2;
  const logoY = cardY + 34;
  if (logoImage) {
    drawImageCoverCircle(ctx, logoImage, logoX, logoY, logoSize);
  } else {
    ctx.fillStyle = "#E8F9F2";
    ctx.beginPath();
    ctx.arc(width / 2, logoY + logoSize / 2, logoSize / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#00A87A";
    ctx.font = "800 28px -apple-system, BlinkMacSystemFont, 'SF Pro Display', Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(merchantName.slice(0, 1).toUpperCase(), width / 2, logoY + logoSize / 2);
  }

  ctx.fillStyle = "#0A1F1A";
  ctx.font = "800 23px -apple-system, BlinkMacSystemFont, 'SF Pro Display', Inter, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(merchantName, width / 2, logoY + logoSize + 30);
  ctx.fillStyle = "rgba(60,60,67,0.42)";
  ctx.font = "700 13px -apple-system, BlinkMacSystemFont, 'SF Pro Display', Inter, sans-serif";
  ctx.fillText("Scan to pay", width / 2, logoY + logoSize + 54);

  const qrImage = await renderQrImage(options as Required<Pick<PaymentQrDownloadOptions, "qrValue" | "receiverAddress">> & PaymentQrDownloadOptions, 420);
  const qrSize = 420;
  const qrX = width / 2 - qrSize / 2;
  const qrY = logoY + logoSize + 76;
  ctx.drawImage(qrImage, qrX, qrY, qrSize, qrSize);

  let cursorY = qrY + qrSize + 42;
  if (displayCoin) {
    const amountText = displayAmount
      ? `${Number(displayAmount).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${displayCoin}`
      : displayCoin;
    ctx.fillStyle = "#0A1F1A";
    ctx.font = "800 34px -apple-system, BlinkMacSystemFont, 'SF Pro Display', Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(amountText, width / 2, cursorY);
    cursorY += 44;
  }

  drawSingleLineAddress(ctx, options.receiverAddress, width / 2, cursorY, cardW - 96, 14);

  ctx.strokeStyle = "rgba(10,31,26,0.06)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cardX + 40, cardY + cardH - 70);
  ctx.lineTo(cardX + cardW - 40, cardY + cardH - 70);
  ctx.stroke();
  drawDownloadFooter(ctx, width, cardY + cardH - 34, seraIcon);

  const a = document.createElement("a");
  a.href = canvas.toDataURL("image/png");
  a.download = options.filename || `serapay-qr-${safeFilename(merchantName)}-${safeFilename(displayCoin || "payment")}.png`;
  a.click();
}
