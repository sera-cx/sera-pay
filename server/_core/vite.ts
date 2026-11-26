import express, { type Express } from "express";
import fs from "fs";
import { type Server } from "http";
import { nanoid } from "nanoid";
import path from "path";
import { guideMetadata, renderGuideMetadata } from "../../shared/guide-metadata";

/**
 * Paths that are asking for a file, not for a page.
 *
 * The dev fallback below answers unmatched routes with index.html so that deep
 * links survive a refresh. Applying that to an asset request turns into a 500:
 * Vite derives its inline-<style> proxy id from the
 * request path, so a URL ending in ".json" yields the module id
 * "/missing.json?html-proxy&direct&index=0.css". That id matches the vite:json
 * plugin's filter (/\.json(?:$|\?)/), so the plugin is handed the stylesheet
 * from index.html, tries to JSON.parse it, and throws "Failed to parse JSON
 * file." — surfacing as a 500 and a stack trace in the terminal for what should
 * have been a plain 404. Any missing .json under the app's origin does it, and
 * Chrome DevTools requests exactly one of those on every page load.
 *
 * Dev only. The production fallback is deliberately left as it was: it runs no
 * Vite transform, so it cannot hit this, and changing what it returns for a
 * missing asset would be a live behaviour change this bug does not require.
 *
 * Matched against a known extension list rather than "contains a dot", so a
 * route parameter that happens to carry one is still served the app.
 */
const STATIC_ASSET_PATH =
  /\.(?:json|webmanifest|js|mjs|cjs|css|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf|eot|txt|xml|pdf|mp4|webm|wasm)$/i;

function isStaticAssetRequest(originalUrl: string): boolean {
  const pathname = originalUrl.split("?")[0];
  // Decode first: "/x%2Ejson" carries no literal extension, so an undecoded
  // test waves it through and it lands back on the crash this guard exists to
  // prevent. Malformed escapes throw, in which case the raw path is all we have.
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch { /* keep the raw path */ }
  return STATIC_ASSET_PATH.test(decoded) || STATIC_ASSET_PATH.test(pathname);
}

export async function setupVite(app: Express, server: Server) {
  const { createServer: createViteServer } = await import("vite");

  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true as const,
  };

  const vite = await createViteServer({
    configFile: path.resolve(import.meta.dirname, "../..", "vite.config.ts"),
    server: serverOptions,
    appType: "custom",
  });

  app.use(vite.middlewares);
  app.use("*", async (req, res, next) => {
    const url = req.originalUrl;

    // Vite's own middlewares above already served every asset that exists, so
    // anything reaching here with a file extension is genuinely missing.
    if (isStaticAssetRequest(url)) {
      res.status(404).end();
      return;
    }

    try {
      const clientTemplate = path.resolve(
        import.meta.dirname,
        "../..",
        "client",
        "index.html"
      );

      // always reload the index.html file from disk incase it changes
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`
      );
      const metadata = guideMetadata(url);
      if (metadata) template = renderGuideMetadata(template, metadata);
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}

export function serveStatic(app: Express) {
  const distPath =
    process.env.NODE_ENV === "development"
      ? path.resolve(import.meta.dirname, "../..", "dist", "public")
      : path.resolve(import.meta.dirname, "public");
  if (!fs.existsSync(distPath)) {
    console.error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`
    );
  }

  // Hashed assets (/assets/*.js, /assets/*.css) — immutable, 1 year cache
  app.use("/assets", express.static(path.join(distPath, "assets"), {
    maxAge: "1y",
    immutable: true,
  }));

  // All other static files (favicon, robots.txt, etc.) — short cache
  app.use(express.static(distPath, {
    maxAge: "1h",
    setHeaders(res, filePath) {
      // index.html must never be cached so new deployments are picked up immediately
      if (filePath.endsWith("index.html")) {
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      }
    },
  }));

  // fall through to index.html if the file doesn't exist
  app.use("*", (req, res, next) => {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    const entry = path.resolve(distPath, "index.html");
    const metadata = guideMetadata(req.originalUrl);
    if (!metadata) return res.sendFile(entry);
    fs.promises.readFile(entry, "utf8")
      .then(html => res.type("html").send(renderGuideMetadata(html, metadata)))
      .catch(next);
  });
}
