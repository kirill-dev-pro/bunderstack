// src/handler.ts
import { Hono } from "hono";

interface HandlerParts {
  crudRouter: Hono;
  authHandler?: (req: Request) => Promise<Response>;
  storageRouter?: Hono;
}

export function buildHandler(parts: HandlerParts): {
  handler: (req: Request) => Promise<Response>;
  router: Hono;
} {
  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok" }));
  app.route("/api", parts.crudRouter);

  if (parts.authHandler) {
    app.on(["GET", "POST"], "/auth/*", (c) => parts.authHandler!(c.req.raw));
  }

  if (parts.storageRouter) {
    app.route("/files", parts.storageRouter);
  }

  const handler = (req: Request): Promise<Response> => Promise.resolve(app.fetch(req));
  return { handler, router: app };
}
