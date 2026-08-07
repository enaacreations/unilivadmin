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

/**
 * Optional request-logger stand-in. Some handlers' only observable output on a
 * rejected request is the log line (the SES/SNS verification split), so a test
 * has to be able to read it — otherwise the assertion degrades to "it returned
 * a status", which is precisely what could not tell a forgery from a broken
 * deployment in the first place.
 */
export interface CapturedLog {
  error: Array<unknown[]>;
  warn: Array<unknown[]>;
  info: Array<unknown[]>;
  debug: Array<unknown[]>;
}

export function newCapturedLog(): CapturedLog {
  return { error: [], warn: [], info: [], debug: [] };
}

export function callRoute(
  router: Router,
  opts: {
    method: string;
    url: string;
    body?: unknown;
    user?: unknown;
    headers?: Record<string, string>;
    log?: CapturedLog;
  },
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
      headers: opts.headers ?? {},
      // Set directly rather than through `authenticate`, which the caller mocks
      // out — this helper is for handler behaviour, not for the auth chain.
      user: opts.user,
      log: opts.log
        ? {
            error: (...a: unknown[]) => opts.log!.error.push(a),
            warn: (...a: unknown[]) => opts.log!.warn.push(a),
            info: (...a: unknown[]) => opts.log!.info.push(a),
            debug: (...a: unknown[]) => opts.log!.debug.push(a),
          }
        : { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
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
