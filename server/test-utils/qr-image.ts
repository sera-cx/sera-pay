import { createRequire } from "node:module";
import jsQR from "jsqr";

// qrcode already ships pngjs as its PNG codec; no extra test dependency.
const require = createRequire(import.meta.url);
const { PNG } = createRequire(require.resolve("qrcode"))("pngjs");

export function decodeQrCard(dataUrl: string) {
  const png = PNG.sync.read(Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ""), "base64"));
  // Scan the QR area, excluding the merchant avatar and card text, as a
  // camera scanner would. Try export and display resolution.
  let decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  for (const size of [840, 420]) {
    if (decoded) break;
    const pixels = new Uint8ClampedArray(size * size * 4);
    const scale = 840 / size;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const source = ((460 + y * scale) * png.width + 300 + x * scale) * 4;
        pixels.set(png.data.subarray(source, source + 4), (y * size + x) * 4);
      }
    }
    decoded = jsQR(pixels, size, size);
  }
  return { width: png.width, height: png.height, value: decoded?.data };
}
