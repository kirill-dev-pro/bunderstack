import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { defineConfig } from "vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";

export default defineConfig({
  server: {
    port: 3000,
    fs: { allow: ["../.."] },
  },
  resolve: {
    tsconfigPaths: true,
  },
  ssr: {
    external: [
      "bunderstack",
      "better-auth",
      "@better-auth/core",
      "drizzle-orm",
      "@libsql/client",
      "hono",
      "defu",
      "drizzle-kit",
      "drizzle-kit/api",
    ],
  },
  plugins: [
    devtools(),
    tanstackStart({
      srcDirectory: "src",
    }),
    viteReact(),
    nitro(),
  ],
});
