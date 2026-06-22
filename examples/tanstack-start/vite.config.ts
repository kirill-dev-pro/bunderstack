import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { defineConfig } from "vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nitro } from "nitro/vite";

export default defineConfig({
  server: {
    port: 3000,
    // Allow Vite to serve files from the monorepo root so that
    // bunderstack's transitive deps (better-auth, defu, …) in the
    // root node_modules can be resolved during dev.
    fs: { allow: ["../.."] },
  },
  resolve: {
    tsconfigPaths: true,
  },
  // Externalize bunderstack and its server-only deps in SSR so
  // TanStack Start's server-fn scanner doesn't chase their imports
  // through the monorepo root, which would trigger the
  // ?server-fn-module-lookup path-outside-root error.
  ssr: {
    external: [
      "bunderstack",
      "better-auth",
      "@better-auth/core",
      "drizzle-orm",
      "@libsql/client",
      "hono",
      "defu",
    ],
  },
  plugins: [
    tailwindcss(),
    tanstackStart({
      srcDirectory: "src",
    }),
    viteReact(),
    nitro(),
  ],
});
