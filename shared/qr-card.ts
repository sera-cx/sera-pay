import { formatDecimalAmountForDisplay } from "./decimal-input";

/** Rendering options shared by webpage downloads and the API. */
export interface PaymentQrCardOptions {
  qrValue: string;
  receiverAddress: string;
  amount?: string | null;
  coin?: string | null;
  merchantName?: string | null;
  merchantLogo?: string | null;
  fgColor?: string | null;
  bgColor?: string | null;
  qrStyle?: string | null;
  qrMode?: string | null;
  /** Fail if saved merchant branding cannot be loaded. */
  strictImages?: boolean;
  footerIcon?: string;
}

export interface QrCanvasRuntime {
  createCanvas(width: number, height: number): HTMLCanvasElement;
  loadImage(src: string): Promise<HTMLImageElement>;
  renderQr(options: PaymentQrCardOptions, size: number): Promise<CanvasImageSource>;
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
    ctx.font = `${weight} ${fontSize}px ui-monospace, SFMono-Regular, Menlo, Consolas, Inter, monospace`;
    return ctx.measureText(part).width;
  };
  const totalWidth = () => measure(parts.start, 800) + measure(parts.middle, 600) + measure(parts.end, 800);
  while (totalWidth() > maxWidth && fontSize > 8) fontSize -= 0.5;

  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  let cursor = x - totalWidth() / 2;
  const drawPart = (part: string, color: string, weight: number) => {
    if (!part) return;
    ctx.font = `${weight} ${fontSize}px ui-monospace, SFMono-Regular, Menlo, Consolas, Inter, monospace`;
    ctx.fillStyle = color;
    ctx.fillText(part, cursor, y);
    cursor += ctx.measureText(part).width;
  };
  drawPart(parts.start, "#0A1F1A", 800);
  drawPart(parts.middle, "rgba(60,60,67,0.28)", 600);
  drawPart(parts.end, "#0A1F1A", 800);
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

export async function renderPaymentQrCard(options: PaymentQrCardOptions, runtime: QrCanvasRuntime): Promise<string> {
  if (!options.qrValue || !options.receiverAddress) throw new Error("Missing QR payment details");

  const styles = ["classic", "rounded", "dots", "classy-rounded"];
  const color = (value: string | null | undefined, fallback: string) => /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value?.trim() || "") ? value!.trim() : fallback;
  options = { ...options,
    qrStyle: options.qrStyle === "classy" ? "classy-rounded" : styles.includes(options.qrStyle || "") ? options.qrStyle : "rounded",
    fgColor: color(options.fgColor, "#000000"), bgColor: color(options.bgColor, "#ffffff"),
  };

  const scale = 2;
  const width = 720;
  const height = 920;
  const canvas = runtime.createCanvas(width * scale, height * scale);
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

  const [logoImage, seraIcon] = await Promise.all([
    options.strictImages && options.merchantLogo
      ? runtime.loadImage(options.merchantLogo)
      : options.merchantLogo ? runtime.loadImage(options.merchantLogo).catch(() => null) : null,
    runtime.loadImage(options.footerIcon || "/favicon-32x32.png").catch(() => null),
  ]);

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

  const qrImage = await runtime.renderQr({ ...options, merchantLogo: logoImage ? options.merchantLogo : null }, 420);
  const qrSize = 420;
  const qrX = width / 2 - qrSize / 2;
  const qrY = logoY + logoSize + 76;
  ctx.drawImage(qrImage, qrX, qrY, qrSize, qrSize);

  let cursorY = qrY + qrSize + 42;
  if (displayCoin) {
    const amountText = displayAmount
      ? `${formatDecimalAmountForDisplay(displayAmount)} ${displayCoin}`
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

  return canvas.toDataURL("image/png");
}
