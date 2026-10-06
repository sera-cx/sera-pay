/** Keep the receipt preview and PDF fallback identical, including lowercase names. */
export function getReceiptInitial(name?: string | null): string {
  return Array.from(name?.trim() || "S")[0].toUpperCase();
}

/** Refresh branding at export time, including receipts for direct wallet payments. */
export async function getReceiptLogo(address: string | undefined, fallback: string): Promise<string> {
  if (!address) return fallback;
  try {
    const response = await fetch(`/api/merchant/public/${encodeURIComponent(address)}`, { cache: "no-store" });
    if (!response.ok) return fallback;
    const profile = await response.json();
    if (profile.logoData === null) return "";
    return typeof profile.logoData === "string" ? profile.logoData : fallback;
  } catch {
    return fallback;
  }
}

/** Decode browser-supported uploads to PNG without stretching the merchant's logo. */
export async function prepareReceiptLogo(source: string): Promise<string | null> {
  if (!source) return null;
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.crossOrigin = "anonymous";
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Unable to load receipt logo"));
      image.src = source;
    });
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height) return null;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 320;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.imageSmoothingQuality = "high";
    const scale = canvas.width / Math.max(width, height);
    const drawnWidth = width * scale;
    const drawnHeight = height * scale;
    context.drawImage(image, (canvas.width - drawnWidth) / 2, (canvas.height - drawnHeight) / 2, drawnWidth, drawnHeight);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}
