import { jsxLocPlugin } from "@builder.io/vite-plugin-jsx-loc";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

const plugins = [react(), tailwindcss(), jsxLocPlugin()];

export default defineConfig(() => ({
    plugins,
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "client", "src"),
        "@shared": path.resolve(import.meta.dirname, "shared"),
        "@assets": path.resolve(import.meta.dirname, "attached_assets"),
      },
    },
    envDir: path.resolve(import.meta.dirname),
    envPrefix: ["VITE_"],
    root: path.resolve(import.meta.dirname, "client"),
    publicDir: path.resolve(import.meta.dirname, "client", "public"),
    build: {
      outDir: path.resolve(import.meta.dirname, "dist/public"),
      emptyOutDir: true,
      chunkSizeWarningLimit: 4000,
      // Use esbuild for minification (faster, less memory) instead of Rollup's default Terser
      // The @privy-io/react-auth pre-bundle is already minified by esbuild
      minify: "esbuild",
      rollupOptions: {
        // Externalize packages that are dynamically imported by @privy-io/react-auth
        // but are not installed as dependencies (optional peer deps)
        external: ["@farcaster/mini-app-solana", "jsdom-testing-mocks", "ws"],
        onwarn(warning, warn) {
          // Suppress the thousands of /*#__PURE__*/ annotation warnings from @privy-io/react-auth
          // These are harmless and just slow down the build output
          if (warning.code === "INVALID_ANNOTATION" || warning.message?.includes("/*#__PURE__*/")) {
            return;
          }
          warn(warning);
        },
      },
    },
    server: {
      host: true,
      allowedHosts: [
        ".sera.cx",
        "localhost",
        "127.0.0.1",
      ],
      fs: {
        strict: true,
        deny: ["**/.*"],
      },
    },
}));
