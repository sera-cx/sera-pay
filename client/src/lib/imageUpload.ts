export const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;

const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
export const MAX_RENDERED_IMAGE_BYTES = 5 * 1024 * 1024;

type UploadImageMime = "image/jpeg" | "image/png" | "image/webp";

function getDataUrlMimeType(dataUrl: string): UploadImageMime | null {
  const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,/i);
  return match ? (match[1].toLowerCase() as UploadImageMime) : null;
}

function preservesTransparency(mimeType: string | null | undefined) {
  return mimeType === "image/png" || mimeType === "image/webp";
}

export type PreparedImage = {
  dataUrl: string;
  width: number;
  height: number;
  originalBytes: number;
  outputBytes: number;
};

export function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Unable to read image"));
    reader.readAsDataURL(file);
  });
}

export function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Unable to render image"));
    image.src = src;
  });
}

export function dataUrlBytes(dataUrl: string) {
  const base64 = dataUrl.split(",")[1] || "";
  return Math.floor((base64.length * 3) / 4);
}

export async function prepareImageForUpload(file: File, options: { maxDimension?: number; quality?: number } = {}): Promise<PreparedImage> {
  if (!SUPPORTED_IMAGE_TYPES.has(file.type)) {
    throw new Error("Use a PNG, JPG, or WebP image.");
  }
  if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
    throw new Error("Image must be 10 MB or smaller.");
  }

  const source = await readFileAsDataUrl(file);
  const image = await loadImage(source);
  const maxDimension = options.maxDimension ?? 1600;
  const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height));
  const width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
  const height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Unable to prepare image");
  context.imageSmoothingQuality = "high";
  if (!preservesTransparency(file.type)) {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
  }
  context.drawImage(image, 0, 0, width, height);
  const outputType = preservesTransparency(file.type) ? (file.type as UploadImageMime) : "image/jpeg";
  const dataUrl = canvas.toDataURL(outputType, options.quality ?? 0.86);

  return {
    dataUrl,
    width,
    height,
    originalBytes: file.size,
    outputBytes: dataUrlBytes(dataUrl),
  };
}

export async function renderCroppedImageForUpload({
  source,
  crop,
  outputWidth = 1600,
  outputHeight = 1200,
  quality = 0.88,
  maxBytes = MAX_RENDERED_IMAGE_BYTES,
}: {
  source: string;
  crop: { x: number; y: number; width: number; height: number };
  outputWidth?: number;
  outputHeight?: number;
  quality?: number;
  maxBytes?: number;
}): Promise<PreparedImage> {
  const image = await loadImage(source);
  const canvas = document.createElement("canvas");
  canvas.width = outputWidth;
  canvas.height = outputHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Unable to prepare image");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  const sourceMimeType = getDataUrlMimeType(source);
  const shouldPreserveTransparency = preservesTransparency(sourceMimeType);
  if (!shouldPreserveTransparency) {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, outputWidth, outputHeight);
  }
  context.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, outputWidth, outputHeight);

  let nextQuality = quality;
  let outputType: UploadImageMime = shouldPreserveTransparency && sourceMimeType ? sourceMimeType : "image/jpeg";
  let dataUrl = canvas.toDataURL(outputType, nextQuality);
  if (shouldPreserveTransparency && outputType === "image/png" && dataUrlBytes(dataUrl) > maxBytes) {
    outputType = "image/webp";
    nextQuality = quality;
    dataUrl = canvas.toDataURL(outputType, nextQuality);
  }
  while ((outputType === "image/jpeg" || outputType === "image/webp") && dataUrlBytes(dataUrl) > maxBytes && nextQuality > 0.62) {
    nextQuality -= 0.06;
    dataUrl = canvas.toDataURL(outputType, nextQuality);
  }
  if (dataUrlBytes(dataUrl) > maxBytes) {
    throw new Error("Image must be smaller after cropping. Try zooming in or using a smaller image.");
  }

  return {
    dataUrl,
    width: outputWidth,
    height: outputHeight,
    originalBytes: dataUrlBytes(source),
    outputBytes: dataUrlBytes(dataUrl),
  };
}
