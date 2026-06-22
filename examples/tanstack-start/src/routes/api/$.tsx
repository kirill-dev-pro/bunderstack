import { createFileRoute } from "@tanstack/react-router";
import { app } from "~/bunderstack";

export const Route = createFileRoute("/api/$")({
  server: {
    handlers: {
      GET: ({ request }) => app.handler(request),
      POST: ({ request }) => app.handler(request),
    },
  },
});
