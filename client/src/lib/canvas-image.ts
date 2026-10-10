/** Load a canvas-safe image with bounded loading and optional unmount cleanup. */
export function loadCanvasImage(src: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const finish = (error?: Error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      image.onload = image.onerror = null;
      if (error) {
        image.removeAttribute("src");
        reject(error);
      } else {
        resolve(image);
      }
    };
    const abort = () => finish(new Error("Image loading cancelled"));
    const timer = setTimeout(() => finish(new Error("Image loading timed out")), 15000);
    image.crossOrigin = "anonymous";
    image.onload = () => finish();
    image.onerror = () => finish(new Error("Unable to load image"));
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    image.src = src;
  });
}
