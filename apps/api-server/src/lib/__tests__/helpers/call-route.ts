/**
 * Invoke one express route handler without a socket.
 *
 * An express Router IS middleware, so it can be called directly with a plain
 * request/response pair. That keeps a route-level assertion (which status and
 * body a given order state produces) a unit test: no listening port, no
 * supertest, and the real routing, the real body, the real handler.
 */
import type { Router } from "express";

export interface RouteResult {
  status: number;
  body: any;
}

export function callRoute(
  router: Router,
  opts: { method: string; url: string; body?: unknown; user?: unknown },
): Promise<RouteResult> {
  return new Promise((resolve, reject) => {
    const req: any = {
      method: opts.method.toUpperCase(),
      url: opts.url,
      originalUrl: opts.url,
      baseUrl: "",
      body: opts.body ?? {},
      query: {},
      params: {},
      headers: {},
      // Set directly rather than through `authenticate`, which the caller mocks
      // out — this helper is for handler behaviour, not for the auth chain.
      user: opts.user,
      log: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
    };
    const res: any = {
      statusCode: 200,
      headersSent: false,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: unknown) {
        this.headersSent = true;
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
      send(payload: unknown) {
        this.headersSent = true;
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
      setHeader() {
        return this;
      },
      end() {
        this.headersSent = true;
        resolve({ status: this.statusCode, body: undefined });
        return this;
      },
    };
    (router as unknown as (req: unknown, res: unknown, next: (err?: unknown) => void) => void)(
      req,
      res,
      (err?: unknown) => (err ? reject(err) : resolve({ status: 404, body: null })),
    );
  });
}
