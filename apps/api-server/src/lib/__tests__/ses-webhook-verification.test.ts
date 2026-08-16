/**
 * SES/SNS signature verification — the DETECTOR, not just the guard.
 *
 * The sns-validator bundling defect stayed invisible for three rounds because
 * the broken build and a genuine forgery produced byte-identical 403s with no
 * log line: black-box probing of this endpoint literally could not tell them
 * apart, and proof had to come from inspecting the deployed bundle. So what is
 * asserted here is the DISTINCTION:
 *
 *   - an envelope the validator rejects        → 403, warn
 *   - our own deployment failing to verify one → 5xx, error, with the reason
 *
 * The response body stays free of internals in both cases; the detail belongs in
 * the log, which is why the log is an assertion target here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { callRoute, newCapturedLog } from "./helpers/call-route.js";

const TOPIC_ARN = vi.hoisted(() => {
  // routes/webhooks.ts → config/env.ts fails closed on a weak secret outside
  // development, and the TopicArn allowlist is fail-closed too — set both before
  // the module graph loads so verification, not configuration, decides these tests.
  const arn = "arn:aws:sns:ap-south-1:000000000000:uniliv-ses";
  process.env["SESSION_SECRET"] ??= "vitest-only-session-secret-vitest-only-session-secret";
  process.env["SES_SNS_TOPIC_ARN"] = arn;
  return arn;
});

/** How the mocked sns-validator behaves for the next request. */
const state = vi.hoisted(() => ({ fail: null as null | Error, constructorThrows: false }));

vi.mock("sns-validator", () => ({
  default: class {
    constructor() {
      // Stands in for the module not loading at all: an esbuild bundle without
      // sns-validator in it, or an export shape that is no longer a constructor.
      // Same catch, same INFRASTRUCTURE classification.
      if (state.constructorThrows) throw new Error("Cannot find module 'sns-validator'");
    }
    validate(_hash: unknown, cb: (err: unknown) => void) {
      cb(state.fail);
    }
  },
}));

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  const { fakeDb } = await import("./helpers/fake-db.js");
  return { ...actual, db: fakeDb };
});

const { default: webhooksRouter } = await import("../../routes/webhooks.js");

const envelope = (over: Record<string, unknown> = {}) => ({
  Type: "UnsubscribeConfirmation", // no side effects; verification is the subject
  MessageId: "msg-1",
  TopicArn: TOPIC_ARN,
  SigningCertURL: "https://sns.ap-south-1.amazonaws.com/SimpleNotificationService-x.pem",
  ...over,
});

async function post(body: unknown) {
  const log = newCapturedLog();
  const res = await callRoute(webhooksRouter, {
    method: "POST",
    url: "/webhooks/ses",
    body,
    log,
  });
  return { ...res, log };
}

/** Flatten a captured pino-style call ({ctx}, "msg") into something searchable. */
const said = (calls: Array<unknown[]>) => JSON.stringify(calls);

beforeEach(() => {
  state.fail = null;
  state.constructorThrows = false;
});

describe("POST /webhooks/ses signature verification", () => {
  it("accepts a validly signed envelope", async () => {
    const r = await post(envelope());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true });
  });

  it.each([
    ["The message signature is invalid."],
    ["Message missing required keys."],
    ["The certificate is located on an invalid domain."],
    ["The signature version 3 is not supported."],
  ])("answers 403 and WARNS when the envelope is rejected: %s", async (message) => {
    state.fail = new Error(message);
    const r = await post(envelope());

    expect(r.status).toBe(403);
    expect(r.body).toEqual({ success: false, error: "Invalid SNS signature" });
    // Rejection is a caller problem: warn, not error, but never silent.
    expect(r.log.warn.length).toBe(1);
    expect(r.log.error).toHaveLength(0);
    expect(said(r.log.warn)).toContain("REJECTED");
    expect(said(r.log.warn)).toContain(message);
  });

  it.each([
    // Certificate host resolved but the fetch failed — the deployment's egress,
    // not the sender's envelope.
    [Object.assign(new Error("getaddrinfo ENOTFOUND sns.ap-south-1.amazonaws.com"), {
      code: "ENOTFOUND",
    })],
    [new Error("Certificate could not be retrieved")],
    // An unrecognised failure defaults to INFRASTRUCTURE on purpose: a wrong 403
    // hides a broken deployment, a wrong 503 only makes SNS retry.
    [new Error("error:0909006C:PEM routines:get_name:no start line")],
  ])("answers 503 and logs an ERROR when verification itself fails: %s", async (err) => {
    state.fail = err;
    const r = await post(envelope());

    expect(r.status).toBe(503);
    expect(r.body).toEqual({ success: false, error: "Signature verification unavailable" });
    expect(r.log.error.length).toBe(1);
    expect(r.log.warn).toHaveLength(0);
    expect(said(r.log.error)).toContain("INFRASTRUCTURE");
    expect(said(r.log.error)).toContain(err.message);
  });

  it("answers 503 when the validator module does not load (the H3c defect)", async () => {
    // This is the exact production state that returned an indistinguishable 403
    // for three rounds. It must now be loud and it must not be a 403.
    state.constructorThrows = true;
    const r = await post(envelope());

    expect(r.status).toBe(503);
    expect(r.status).not.toBe(403);
    expect(said(r.log.error)).toContain("sns-validator failed to load");
  });

  it("puts the discriminating detail in the LOG, never in the response body", async () => {
    state.fail = new Error("Certificate could not be retrieved");
    const r = await post(envelope({ MessageId: "msg-42" }));

    const body = JSON.stringify(r.body);
    expect(body).not.toContain("Certificate");
    expect(body).not.toContain("msg-42");
    expect(body).not.toContain(TOPIC_ARN);

    const logged = said(r.log.error);
    expect(logged).toContain("msg-42");
    expect(logged).toContain(TOPIC_ARN);
    // The cert host is what tells "our SNS region is unreachable" apart from
    // "the sender pointed us at a URL that 404s".
    expect(logged).toContain("sns.ap-south-1.amazonaws.com");
  });

  it("still rejects a validly signed envelope from a foreign topic", async () => {
    // Verification passing is not authorisation: the TopicArn gate is downstream
    // of it and must not have been bypassed by the new branch.
    const r = await post(envelope({ TopicArn: "arn:aws:sns:us-east-1:999:someone-else" }));
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: "Unexpected SNS topic" });
  });
});
