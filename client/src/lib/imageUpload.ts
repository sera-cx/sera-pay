export const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;

const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export type PreparedImage = {
  dataUrl: string;
  width: number;
  height: number;
  originalBytes: number;
  outputBytes: number;
};

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Unable to read image"));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Unable to render image"));
    image.src = src;
  });
}

function dataUrlBytes(dataUrl: string) {
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
  context.drawImage(image, 0, 0, width, height);
  const dataUrl = canvas.toDataURL("image/jpeg", options.quality ?? 0.86);

  return {
    dataUrl,
    width,
    height,
    originalBytes: file.size,
    outputBytes: dataUrlBytes(dataUrl),
  };
}