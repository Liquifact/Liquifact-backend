/**
 * @fileoverview Snapshot tests for persistence error-response bodies.
 *
 * Locks the exact RFC 7807 shape of the persistence-layer error
 * responses (400/404/409/500) used across the retention/policy routes,
 * so accidental drift in field names or values is caught by CI.
 *
 * @module tests/persistence.errors.snapshot.test
 */

"use strict";

const request = require("supertest");
const express = require("express");
const AppError = require("../src/errors/AppError");
const { problemJsonHandler } = require("../src/middleware/problemJson");

function buildApp(errorFactory) {
  const app = express();
  app.use((req, res, next) => {
    req.id = "snap-test-request-id";
    next();
  });
  app.get("/trigger", (req, res, next) => {
    next(errorFactory());
  });
  app.use(problemJsonHandler);
  return app;
}

describe("Persistence error-response body snapshots", () => {
  test("400 validation error (retention policy create)", async () => {
    const app = buildApp(
      () =>
        new AppError({
          type: "https://liquifact.com/probs/validation-error",
          title: "Validation Error",
          status: 400,
          detail: "name is required, type must be one of [invoice, document]",
        }),
    );
    const response = await request(app).get("/trigger").expect(400);
    expect(response.headers["content-type"]).toBe(
      "application/problem+json; charset=utf-8",
    );
    expect(response.body).toMatchSnapshot();
  });

  test("404 not found (retention policy lookup)", async () => {
    const app = buildApp(
      () =>
        new AppError({
          type: "https://liquifact.com/probs/not-found",
          title: "Policy Not Found",
          status: 404,
          detail: "Retention policy not found",
        }),
    );
    const response = await request(app).get("/trigger").expect(404);
    expect(response.headers["content-type"]).toBe(
      "application/problem+json; charset=utf-8",
    );
    expect(response.body).toMatchSnapshot();
  });

  test("409 conflict (retention policy already exists)", async () => {
    const app = buildApp(
      () =>
        new AppError({
          type: "https://liquifact.com/probs/conflict",
          title: "Policy Already Exists",
          status: 409,
          detail: "Policy 'default-invoice-policy' already exists for this tenant",
        }),
    );
    const response = await request(app).get("/trigger").expect(409);
    expect(response.headers["content-type"]).toBe(
      "application/problem+json; charset=utf-8",
    );
    expect(response.body).toMatchSnapshot();
  });

  test("500 internal server error (retention policy fetch failure)", async () => {
    const app = buildApp(
      () =>
        new AppError({
          type: "https://liquifact.com/probs/internal-server-error",
          title: "Internal Server Error",
          status: 500,
          detail: "Failed to fetch retention policies",
        }),
    );
    const response = await request(app).get("/trigger").expect(500);
    expect(response.headers["content-type"]).toBe(
      "application/problem+json; charset=utf-8",
    );
    expect(response.body).toMatchSnapshot();
  });
});
