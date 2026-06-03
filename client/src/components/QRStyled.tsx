import { useEffect, useRef } from "react";
import * as QRCodeGenerator from "qrcode";
import QRCodeStyling, { type Options } from "qr-code-styling";

export type QrStyle = "classic" | "rounded" | "dots" | "classy" | "classy-rounded";
export type QrMode = "standard" | "advanced";

type AutoQrPalette = {
  dotColor: string;
  finderColor: string;
  veilColor: string;
  gradientColors: string[];
  brandColors: RgbColor[];
  averageColor: RgbColor;
};

type RgbColor = { red: number; green: number; blue: number };

type LogoSample = {
  color: RgbColor;
  alpha: number;
};

const FALLBACK_AUTO_PALETTE: AutoQrPalette = {
  dotColor: "rgba(16, 16, 16, 0.78)",
  finderColor: "#101010",
  veilColor: "rgba(255,255,255,0.24)",
  gradientColors: ["#101010", "#4C8F6A", "#101010"],
  brandColors: [
    { red: 16, green: 16, blue: 16 },
    { red: 76, green: 143, blue: 106 },
  ],
  averageColor: { red: 245, green: 245, blue: 245 },
};

function clampColor(value: number) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function rgbToHex(red: number, green: number, blue: number) {
  return `#${[red, green, blue].map((value) => clampColor(value).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

function rgba(red: number, green: number, blue: number, alpha: number) {
  return `rgba(${clampColor(red)}, ${clampColor(green)}, ${clampColor(blue)}, ${alpha})`;
}

function mixRgb(color: { red: number; green: number; blue: number }, target: { red: number; green: number; blue: number }, amount: number) {
  return {
    red: color.red + (target.red - color.red) * amount,
    green: color.green + (target.green - color.green) * amount,
    blue: color.blue + (target.blue - color.blue) * amount,
  };
}

function rgbLuminance(red: number, green: number, blue: number) {
  return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
}

function rgbSaturation(red: number, green: number, blue: number) {
  const max = Math.max(red, green, blue) / 255;
  const min = Math.min(red, green, blue) / 255;
  if (max === min) return 0;
  const lightness = (max + min) / 2;
  return (max - min) / (1 - Math.abs(2 * lightness - 1));
}

function getAutoQrPalette(imageData: ImageData): AutoQrPalette {
  let red = 0;
  let green = 0;
  let blue = 0;
  let pixels = 0;
  let weightedRed = 0;
  let weightedGreen = 0;
  let weightedBlue = 0;
  let totalWeight = 0;
  const buckets = new Map<string, { red: number; green: number; blue: number; weight: number; count: number }>();

  for (let index = 0; index < imageData.data.length; index += 4) {
    const alpha = imageData.data[index + 3];
    if (alpha < 24) continue;
    const pixelRed = imageData.data[index];
    const pixelGreen = imageData.data[index + 1];
    const pixelBlue = imageData.data[index + 2];
    red += pixelRed;
    green += pixelGreen;
    blue += pixelBlue;
    pixels += 1;

    const saturation = rgbSaturation(pixelRed, pixelGreen, pixelBlue);
    const luminance = rgbLuminance(pixelRed, pixelGreen, pixelBlue);
    const usefulContrast = 1 - Math.abs(luminance - 0.42);
    const weight = Math.max(0, saturation - 0.08) * Math.max(0.2, usefulContrast);
    weightedRed += pixelRed * weight;
    weightedGreen += pixelGreen * weight;
    weightedBlue += pixelBlue * weight;
    totalWeight += weight;

    if (saturation > 0.12 && alpha > 80) {
      const key = `${Math.round(pixelRed / 32)}-${Math.round(pixelGreen / 32)}-${Math.round(pixelBlue / 32)}`;
      const bucket = buckets.get(key) || { red: 0, green: 0, blue: 0, weight: 0, count: 0 };
      const bucketWeight = Math.max(0.12, saturation) * (0.65 + Math.max(0, 0.65 - Math.abs(luminance - 0.45)));
      bucket.red += pixelRed * bucketWeight;
      bucket.green += pixelGreen * bucketWeight;
      bucket.blue += pixelBlue * bucketWeight;
      bucket.weight += bucketWeight;
      bucket.count += 1;
      buckets.set(key, bucket);
    }
  }

  if (!pixels) return FALLBACK_AUTO_PALETTE;
  let accent = totalWeight > 0.1
    ? { red: weightedRed / totalWeight, green: weightedGreen / totalWeight, blue: weightedBlue / totalWeight }
    : { red: red / pixels, green: green / pixels, blue: blue / pixels };

  const accentLuminance = rgbLuminance(accent.red, accent.green, accent.blue);
  if (accentLuminance > 0.6) accent = mixRgb(accent, { red: 0, green: 0, blue: 0 }, 0.34);
  if (accentLuminance < 0.18) accent = mixRgb(accent, { red: 255, green: 255, blue: 255 }, 0.16);

  const finder = mixRgb(accent, { red: 0, green: 0, blue: 0 }, rgbLuminance(accent.red, accent.green, accent.blue) > 0.46 ? 0.34 : 0.18);
  const averageLuminance = rgbLuminance(red / pixels, green / pixels, blue / pixels);
  const sampledBrandColors = Array.from(buckets.values())
    .filter((bucket) => bucket.weight > 0)
    .sort((first, second) => second.weight - first.weight)
    .slice(0, 6)
    .map((bucket) => {
      let color = { red: bucket.red / bucket.weight, green: bucket.green / bucket.weight, blue: bucket.blue / bucket.weight };
      const luminance = rgbLuminance(color.red, color.green, color.blue);
      if (luminance > 0.66) color = mixRgb(color, { red: 0, green: 0, blue: 0 }, 0.28);
      if (luminance < 0.2) color = mixRgb(color, { red: 255, green: 255, blue: 255 }, 0.12);
      return { red: clampColor(color.red), green: clampColor(color.green), blue: clampColor(color.blue) };
    });
  const accentColor = { red: clampColor(accent.red), green: clampColor(accent.green), blue: clampColor(accent.blue) };
  const finderColor = { red: clampColor(finder.red), green: clampColor(finder.green), blue: clampColor(finder.blue) };
  const averageColor = { red: clampColor(red / pixels), green: clampColor(green / pixels), blue: clampColor(blue / pixels) };
  const brandColors = sampledBrandColors.length >= 2 ? sampledBrandColors : [accentColor, finderColor];
  const gradientColors = Array.from(new Set([rgbToHex(accent.red, accent.green, accent.blue), ...brandColors.map((color) => rgbToHex(color.red, color.green, color.blue)), rgbToHex(finder.red, finder.green, finder.blue)]))
    .slice(0, 4);

  return {
    dotColor: rgba(accent.red, accent.green, accent.blue, averageLuminance > 0.72 ? 0.86 : 0.78),
    finderColor: rgbToHex(finder.red, finder.green, finder.blue),
    veilColor: averageLuminance > 0.74 ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.28)",
    gradientColors: gradientColors.length >= 2 ? gradientColors : [rgbToHex(accent.red, accent.green, accent.blue), rgbToHex(finder.red, finder.green, finder.blue)],
    brandColors,
    averageColor,
  };
}

function buildLinearGradient(colors: string[]) {
  const stops = colors.length > 1 ? colors : [colors[0] || "#101010", colors[0] || "#101010"];
  return {
    type: "linear",
    rotation: Math.PI * 0.16,
    colorStops: stops.map((color, index) => ({
      offset: stops.length === 1 ? 1 : index / (stops.length - 1),
      color,
    })),
  };
}

function parseHexColor(value: string, fallback: RgbColor): RgbColor {
  const hex = value.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(hex)) {
    return {
      red: parseInt(hex[0] + hex[0], 16),
      green: parseInt(hex[1] + hex[1], 16),
      blue: parseInt(hex[2] + hex[2], 16),
    };
  }
  if (/^[0-9a-f]{6,8}$/i.test(hex)) {
    return {
      red: parseInt(hex.slice(0, 2), 16),
      green: parseInt(hex.slice(2, 4), 16),
      blue: parseInt(hex.slice(4, 6), 16),
    };
  }
  return fallback;
}

function srgbToLinear(value: number) {
  const channel = clampColor(value) / 255;
  return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
}

function relativeLuminance(color: RgbColor) {
  return 0.2126 * srgbToLinear(color.red) + 0.7152 * srgbToLinear(color.green) + 0.0722 * srgbToLinear(color.blue);
}

function contrastRatio(first: RgbColor, second: RgbColor) {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function ensureQrContrast(color: RgbColor, background: RgbColor, minContrast = 3.35): RgbColor {
  let next = { ...color };
  const target = relativeLuminance(background) > 0.5
    ? { red: 0, green: 0, blue: 0 }
    : { red: 255, green: 255, blue: 255 };

  for (let step = 0; step < 10; step += 1) {
    if (contrastRatio(next, background) >= minContrast) return next;
    next = mixRgb(next, target, 0.2);
  }
  return {
    red: clampColor(next.red),
    green: clampColor(next.green),
    blue: clampColor(next.blue),
  };
}

function roundedRectPath(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.lineTo(x + width - safeRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  context.lineTo(x + width, y + height - safeRadius);
  context.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
  context.lineTo(x + safeRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  context.lineTo(x, y + safeRadius);
  context.quadraticCurveTo(x, y, x + safeRadius, y);
  context.closePath();
}

function fillRoundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  roundedRectPath(context, x, y, width, height, radius);
  context.fill();
}

function strokeRoundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  roundedRectPath(context, x, y, width, height, radius);
  context.stroke();
}

function getFallbackBrandColor(palette: AutoQrPalette, normalizedX: number, normalizedY: number) {
  const colors = palette.brandColors.length ? palette.brandColors : FALLBACK_AUTO_PALETTE.brandColors;
  const distanceFromCenter = Math.hypot(normalizedX - 0.5, normalizedY - 0.5);
  const ring = Math.min(colors.length - 1, Math.floor(distanceFromCenter * 3.2));
  const diagonalShift = Math.abs(Math.round((normalizedX - normalizedY) * 2));
  return colors[(ring + diagonalShift) % colors.length];
}

function sampleLogoColor(imageData: ImageData | null, normalizedX: number, normalizedY: number, fallback: RgbColor): LogoSample {
  if (!imageData) return { color: fallback, alpha: 0 };
  const centerX = Math.max(0, Math.min(imageData.width - 1, Math.round(normalizedX * (imageData.width - 1))));
  const centerY = Math.max(0, Math.min(imageData.height - 1, Math.round(normalizedY * (imageData.height - 1))));
  const radius = Math.max(1, Math.round(imageData.width / 96));
  let red = 0;
  let green = 0;
  let blue = 0;
  let weight = 0;
  let coverage = 0;
  let samples = 0;

  for (let y = Math.max(0, centerY - radius); y <= Math.min(imageData.height - 1, centerY + radius); y += 1) {
    for (let x = Math.max(0, centerX - radius); x <= Math.min(imageData.width - 1, centerX + radius); x += 1) {
      const index = (y * imageData.width + x) * 4;
      const alpha = imageData.data[index + 3] / 255;
      samples += 1;
      if (alpha < 0.08) continue;
      const pixelRed = imageData.data[index];
      const pixelGreen = imageData.data[index + 1];
      const pixelBlue = imageData.data[index + 2];
      const saturation = rgbSaturation(pixelRed, pixelGreen, pixelBlue);
      const pixelWeight = alpha * (0.78 + saturation * 0.55);
      red += pixelRed * pixelWeight;
      green += pixelGreen * pixelWeight;
      blue += pixelBlue * pixelWeight;
      weight += pixelWeight;
      coverage += alpha;
    }
  }

  if (weight <= 0.01) return { color: fallback, alpha: 0 };
  return {
    color: { red: red / weight, green: green / weight, blue: blue / weight },
    alpha: Math.min(1, coverage / Math.max(1, samples)),
  };
}

function isFinderModule(row: number, col: number, moduleCount: number) {
  const inTop = row < 7;
  const inBottom = row >= moduleCount - 7;
  const inLeft = col < 7;
  const inRight = col >= moduleCount - 7;
  return (inTop && inLeft) || (inTop && inRight) || (inBottom && inLeft);
}

function getLogoImageData(image: HTMLImageElement, sampleSize = 224) {
  const canvas = document.createElement("canvas");
  canvas.width = sampleSize;
  canvas.height = sampleSize;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  const imageWidth = image.naturalWidth || image.width || sampleSize;
  const imageHeight = image.naturalHeight || image.height || sampleSize;
  const scale = Math.min(sampleSize / imageWidth, sampleSize / imageHeight);
  const drawWidth = imageWidth * scale;
  const drawHeight = imageHeight * scale;
  context.clearRect(0, 0, sampleSize, sampleSize);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, (sampleSize - drawWidth) / 2, (sampleSize - drawHeight) / 2, drawWidth, drawHeight);
  return context.getImageData(0, 0, sampleSize, sampleSize);
}

function drawFinderCorner(
  context: CanvasRenderingContext2D,
  startCol: number,
  startRow: number,
  moduleSize: number,
  offset: number,
  palette: AutoQrPalette,
  backgroundColor: string,
  backgroundRgb: RgbColor,
  index: number,
) {
  const x = offset + startCol * moduleSize;
  const y = offset + startRow * moduleSize;
  const size = moduleSize * 7;
  const outerBase = parseHexColor(palette.finderColor, palette.brandColors[index % palette.brandColors.length] || FALLBACK_AUTO_PALETTE.brandColors[0]);
  const innerBase = palette.brandColors[(index + 1) % palette.brandColors.length] || outerBase;
  const outer = ensureQrContrast(outerBase, backgroundRgb, 4.5);
  const inner = ensureQrContrast(innerBase, backgroundRgb, 4.15);
  const outline = ensureQrContrast(mixRgb(outer, { red: 0, green: 0, blue: 0 }, 0.28), backgroundRgb, 5);

  context.fillStyle = rgba(outer.red, outer.green, outer.blue, 1);
  fillRoundedRect(context, x, y, size, size, moduleSize * 1.45);
  context.fillStyle = backgroundColor;
  fillRoundedRect(context, x + moduleSize * 1.05, y + moduleSize * 1.05, moduleSize * 4.9, moduleSize * 4.9, moduleSize * 0.98);
  context.fillStyle = rgba(inner.red, inner.green, inner.blue, 1);
  fillRoundedRect(context, x + moduleSize * 2.05, y + moduleSize * 2.05, moduleSize * 2.9, moduleSize * 2.9, moduleSize * 0.65);
  context.lineWidth = Math.max(1, moduleSize * 0.18);
  context.strokeStyle = rgba(outline.red, outline.green, outline.blue, 0.56);
  strokeRoundedRect(context, x + moduleSize * 0.08, y + moduleSize * 0.08, size - moduleSize * 0.16, size - moduleSize * 0.16, moduleSize * 1.36);
}

function drawLogoBackground(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  width: number,
  height: number,
  backgroundColor: string,
) {
  const imageWidth = image.naturalWidth || image.width;
  const imageHeight = image.naturalHeight || image.height;
  if (!imageWidth || !imageHeight) return;

  const scale = Math.min(width / imageWidth, height / imageHeight) * 0.94;
  const drawWidth = imageWidth * scale;
  const drawHeight = imageHeight * scale;
  const drawX = x + (width - drawWidth) / 2;
  const drawY = y + (height - drawHeight) / 2;

  context.save();
  roundedRectPath(context, x, y, width, height, Math.max(8, width * 0.035));
  context.clip();
  context.globalAlpha = 0.18;
  context.drawImage(image, drawX, drawY, drawWidth, drawHeight);
  context.globalAlpha = 0.34;
  context.fillStyle = backgroundColor;
  context.fillRect(x, y, width, height);
  context.globalAlpha = 0.06;
  context.drawImage(image, drawX, drawY, drawWidth, drawHeight);
  context.restore();
}

function drawAdvancedQrCanvas({
  canvas,
  value,
  size,
  bgColor,
  style,
  palette,
  imageData,
  logoImage,
}: {
  canvas: HTMLCanvasElement;
  value: string;
  size: number;
  bgColor: string;
  style: QrStyle;
  palette: AutoQrPalette;
  imageData: ImageData | null;
  logoImage?: HTMLImageElement;
}) {
  const context = canvas.getContext("2d");
  if (!context) return;
  const pixelRatio = Math.max(1, Math.min(3, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1));
  canvas.width = Math.round(size * pixelRatio);
  canvas.height = Math.round(size * pixelRatio);
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, size, size);
  context.fillStyle = bgColor;
  context.fillRect(0, 0, size, size);

  let qr;
  try {
    qr = QRCodeGenerator.create(value || " ", { errorCorrectionLevel: "H" });
  } catch {
    return;
  }

  const moduleCount = qr.modules.size;
  const quietModules = 4;
  const moduleSize = size / (moduleCount + quietModules * 2);
  const offset = quietModules * moduleSize;
  const backgroundRgb = parseHexColor(bgColor, { red: 255, green: 255, blue: 255 });

  if (logoImage) {
    drawLogoBackground(context, logoImage, offset, offset, moduleSize * moduleCount, moduleSize * moduleCount, bgColor);
  }

  for (let row = 0; row < moduleCount; row += 1) {
    for (let col = 0; col < moduleCount; col += 1) {
      if (!qr.modules.get(row, col) || isFinderModule(row, col, moduleCount)) continue;

      const normalizedX = (col + 0.5) / moduleCount;
      const normalizedY = (row + 0.5) / moduleCount;
      const fallbackColor = getFallbackBrandColor(palette, normalizedX, normalizedY);
      const logoSample = sampleLogoColor(imageData, normalizedX, normalizedY, fallbackColor);
      const sampledColor = logoSample.alpha > 0.03 ? logoSample.color : fallbackColor;
      const reserved = Boolean(qr.modules.isReserved(row, col));
      const saturated = rgbSaturation(sampledColor.red, sampledColor.green, sampledColor.blue);
      const contrasted = ensureQrContrast(sampledColor, backgroundRgb, reserved ? 4.2 : 3.35);
      const seed = (row * 31 + col * 17) % 13;
      const brandPresence = Math.min(1, logoSample.alpha + saturated * 0.35);
      const baseScale = style === "classic" ? 0.84 : style === "dots" ? 0.7 : style === "classy" ? 0.76 : style === "classy-rounded" ? 0.78 : 0.8;
      const dotSize = moduleSize * Math.min(0.92, (reserved ? 0.84 : baseScale) + brandPresence * 0.1 + (seed === 0 ? 0.04 : 0));
      const x = offset + col * moduleSize + (moduleSize - dotSize) / 2;
      const y = offset + row * moduleSize + (moduleSize - dotSize) / 2;

      context.fillStyle = rgba(contrasted.red, contrasted.green, contrasted.blue, reserved ? 0.98 : 0.91);
      if (style === "dots") {
        context.beginPath();
        context.arc(x + dotSize / 2, y + dotSize / 2, dotSize / 2, 0, Math.PI * 2);
        context.fill();
      } else if (style === "classic") {
        context.fillRect(x, y, dotSize, dotSize);
      } else if (style === "classy") {
        roundedRectPath(context, x, y, dotSize, dotSize, dotSize * 0.2);
        context.transform(1, 0, seed % 2 === 0 ? 0.12 : -0.12, 1, 0, 0);
        context.fill();
        context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      } else {
        const radius = reserved ? dotSize * 0.34 : dotSize * (style === "classy-rounded" ? 0.28 : seed % 5 === 0 ? 0.34 : 0.48);
        fillRoundedRect(context, x, y, dotSize, dotSize, radius);
      }
    }
  }

  drawFinderCorner(context, 0, 0, moduleSize, offset, palette, bgColor, backgroundRgb, 0);
  drawFinderCorner(context, moduleCount - 7, 0, moduleSize, offset, palette, bgColor, backgroundRgb, 1);
  drawFinderCorner(context, 0, moduleCount - 7, moduleSize, offset, palette, bgColor, backgroundRgb, 2);
}

export function buildQrOptions(
  value: string,
  size: number,
  fgColor: string,
  bgColor: string,
  style: QrStyle,
  logo?: string,
  mode: QrMode = "standard",
  finderColor?: string,
  gradientColors?: string[],
): Options {
  const quietZone = Math.max(8, Math.round(size * 0.04));
  const advancedMode = mode === "advanced";
  const centerLogo = advancedMode ? undefined : logo;
  const base: Options = {
    width: size,
    height: size,
    data: value,
    type: "svg",
    margin: quietZone,
    backgroundOptions: { color: advancedMode ? "transparent" : bgColor } as any,
    dotsOptions: { color: fgColor },
    cornersSquareOptions: { color: fgColor },
    cornersDotOptions: { color: fgColor },
    ...(centerLogo
      ? {
          image: centerLogo,
          qrOptions: { errorCorrectionLevel: "H" },
          // imageSize 0.28 = logo occupies ~28% of QR width (up from 0.18)
          imageOptions: { hideBackgroundDots: true, imageSize: 0.28, margin: 3, crossOrigin: "anonymous" },
        }
      : {
          qrOptions: { errorCorrectionLevel: advancedMode ? "H" : "M" },
        }),
  };

  if (advancedMode) {
    return {
      ...base,
      dotsOptions: { ...base.dotsOptions, type: "dots", gradient: buildLinearGradient(gradientColors || [fgColor]) } as any,
      cornersSquareOptions: { ...base.cornersSquareOptions, color: finderColor || fgColor, type: "extra-rounded" },
      cornersDotOptions: { ...base.cornersDotOptions, color: finderColor || fgColor, type: "dot" },
    };
  }

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
  const advancedMode = mode === "advanced" && Boolean(logo);

  useEffect(() => {
    if (!containerRef.current || advancedMode) return;
    containerRef.current.innerHTML = "";
    const qr = new QRCodeStyling(buildQrOptions(value, size, fgColor, bgColor, style, logo, "standard"));
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
  }, [value, size, fgColor, bgColor, style, logo, advancedMode]);

  useEffect(() => {
    if (!advancedMode || !logo || !canvasRef.current) return;
    let cancelled = false;
    const canvas = canvasRef.current;
    drawAdvancedQrCanvas({ canvas, value, size, bgColor, style, palette: FALLBACK_AUTO_PALETTE, imageData: null });
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      if (cancelled) return;
      let imageData: ImageData | null = null;
      let palette = FALLBACK_AUTO_PALETTE;
      try {
        imageData = getLogoImageData(image);
        if (imageData) palette = getAutoQrPalette(imageData);
      } catch {
        imageData = null;
      }
      drawAdvancedQrCanvas({ canvas, value, size, bgColor, style, palette, imageData, logoImage: image });
    };
    image.onerror = () => {
      if (!cancelled) drawAdvancedQrCanvas({ canvas, value, size, bgColor, style, palette: FALLBACK_AUTO_PALETTE, imageData: null });
    };
    image.src = logo;
    return () => { cancelled = true; };
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
