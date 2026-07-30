/**
 * @fileoverview Snapshot tests for metrics error-response bodies.
 *
 * Locks the exact shape of the metrics error handler responses (400/404/409/500)
 * so accidental drift in field names, values, or status codes is caught by CI.
 *
 * The underlying middleware (`metricsErrorHandler`) emits a uniform structured
 * JSON body:
 *
 * ```json
 * {
 *   "error": {
 *     "code": "<METRICS_ERROR_CODES member>",
 *     "message": "<safe human-readable message>",
 *     "retryable": false
 *   }
 * }
 * ```
 *
 * Only `UPSTREAM_ERROR` has `retryable: true`.
 *
 * Coverage (per the issue brief):
 *   - 400 – validation error  (maps to VALIDATION_ERROR → HTTP 422)
 *   - 404 – not found         (maps to NOT_FOUND       → HTTP 404)
 *   - 409 – conflict          (not a known code; falls through to
 *                              INTERNAL_SERVER_ERROR → HTTP 500)
 *   - 500 – internal error    (maps to INTERNAL_SERVER_ERROR → HTTP 500)
 *
 * To intentionally update the snapshots after a contract change, run:
 *
 *     npx jest tests/metrics.errorSnapshot.test.js -u
 *
 * @module tests/metrics.errorSnapshot.test
 */

"use strict";

const request = require("supertest");
const express = require("express");

const {
  metricsErrorHandler,
  METRICS_ERROR_CODES,
} = require("../src/middleware/metricsErrorHandler");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a minimal Express app that throws a given error and has the
 * metricsErrorHandler mounted as error middleware.
 *
 * @param {object}   options
 * @param {Error}    options.err - The error object to throw.
 * @returns {import('express').Application}
 */
function buildApp({ err } = {}) {
  const app = express();

  app.get("/trigger", (_req, _res, next) => {
    next(err || new Error("test error"));
  });

  app.use(metricsErrorHandler);

  // Fallback — catches anything forwarded by metricsErrorHandler
  app.use((e, _req, res, _next) => {
    res.status(500).json({ fallback: true, message: e.message });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

describe("Metrics error-response body snapshots", () => {
  test("400 validation error — err.status 400 maps to VALIDATION_ERROR (HTTP 422)", async () => {
    const err = Object.assign(new Error("Invalid metric query parameter"), {
      status: 400,
    });
    const app = buildApp({ err });
    const response = await request(app).get("/trigger").expect(422);

    expect(response.headers["content-type"]).toBe(
      "application/json; charset=utf-8",
    );
    expect(response.body).toMatchSnapshot();
  });

  test("404 not found — err.code NOT_FOUND maps to NOT_FOUND (HTTP 404)", async () => {
    const err = Object.assign(new Error("Metric 'orders_per_sec' not found"), {
      code: METRICS_ERROR_CODES.NOT_FOUND,
    });
    const app = buildApp({ err });
    const response = await request(app).get("/trigger").expect(404);

    expect(response.headers["content-type"]).toBe(
      "application/json; charset=utf-8",
    );
    expect(response.body).toMatchSnapshot();
  });

  test("409 conflict — err.status 409 not in classification; falls to INTERNAL_SERVER_ERROR (HTTP 500)", async () => {
    const err = Object.assign(
      new Error("Concurrent metric update conflict"),
      { status: 409 },
    );
    const app = buildApp({ err });
    const response = await request(app).get("/trigger").expect(500);

    expect(response.headers["content-type"]).toBe(
      "application/json; charset=utf-8",
    );
    expect(response.body).toMatchSnapshot();
  });

  test("500 internal server error — err.code INTERNAL_SERVER_ERROR (HTTP 500)", async () => {
    const err = Object.assign(
      new Error("Metrics registry crashed"),
      { code: METRICS_ERROR_CODES.INTERNAL_SERVER_ERROR },
    );
    const app = buildApp({ err });
    const response = await request(app).get("/trigger").expect(500);

    expect(response.headers["content-type"]).toBe(
      "application/json; charset=utf-8",
    );
    expect(response.body).toMatchSnapshot();
  });
});
