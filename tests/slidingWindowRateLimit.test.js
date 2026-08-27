"use strict";

const express = require("express");
const request = require("supertest");
const {
  createSlidingWindowRateLimiter,
  DEFAULT_MAX_REQUESTS,
  DEFAULT_WINDOW_MS,
  identityFor,
  readConfig,
} = require("../src/middleware/slidingWindowRateLimit");

let currentTime = Date.now();

function setClock(value) {
  currentTime = value;
}

function makeApp(options = {}) {
  const app = express();
  const limiter = createSlidingWindowRateLimiter({
    clock: () => currentTime,
    ...options,
  });
  app.post("/test", limiter, (req, res) =>
    res.status(201).json({ accepted: true }),
  );
  return { app, limiter };
}

function invoke(limiter, req = { ip: "127.0.0.1" }) {
  const response = {
    body: undefined,
    headers: {},
    statusCode: 200,
    set(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
    },
  };
  let continued = false;
  limiter(req, response, () => {
    continued = true;
  });
  return { ...response, continued };
}

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.PERSISTENCE_RATE_LIMIT_WINDOW_MS;
  delete process.env.PERSISTENCE_RATE_LIMIT_MAX_REQUESTS;
});

describe("bounded sliding-window persistence limiter", () => {
  test("allows requests below the configured limit", async () => {
    const { app } = makeApp({ windowMs: 60_000, maxRequests: 3 });
    setClock(1_000);

    const first = await request(app).post("/test");
    const second = await request(app).post("/test");
    const third = await request(app).post("/test");

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(third.status).toBe(201);
    expect(first.headers["ratelimit-limit"]).toBe("3");
    expect(first.headers["ratelimit-remaining"]).toBe("2");
    expect(third.headers["ratelimit-remaining"]).toBe("0");
  });

  test("returns a stable structured 429 response at the limit", async () => {
    const { app } = makeApp({ windowMs: 60_000, maxRequests: 2 });
    setClock(10_000);
    await request(app).post("/test");
    await request(app).post("/test");

    const limited = await request(app).post("/test");

    expect(limited.status).toBe(429);
    expect(limited.body).toEqual(
      expect.objectContaining({
        error: "Too Many Requests",
        type: "rate_limited",
        code: "RATE_LIMIT_EXCEEDED",
        retryAfter: expect.any(Number),
      }),
    );
    expect(limited.headers["retry-after"]).toBe(
      String(limited.body.retryAfter),
    );
    expect(limited.headers["ratelimit-remaining"]).toBe("0");
    expect(limited.headers["ratelimit-reset"]).toBe(
      limited.headers["retry-after"],
    );
  });

  test("retains previous-window pressure at the boundary", async () => {
    const { app } = makeApp({ windowMs: 60_000, maxRequests: 3 });
    setClock(0);
    await request(app).post("/test");
    await request(app).post("/test");
    await request(app).post("/test");

    setClock(60_000);
    const boundary = await request(app).post("/test");

    expect(boundary.status).toBe(429);
    expect(boundary.headers["retry-after"]).toBe("1");
  });

  test("releases previous-window pressure gradually rather than resetting twice", async () => {
    const { app } = makeApp({ windowMs: 60_000, maxRequests: 3 });
    setClock(0);
    await request(app).post("/test");
    await request(app).post("/test");
    await request(app).post("/test");

    setClock(60_000);
    const stillBlocked = await request(app).post("/test");
    expect(stillBlocked.status).toBe(429);

    setClock(119_999);
    const released = await request(app).post("/test");
    expect(released.status).toBe(201);
    expect(released.headers["ratelimit-remaining"]).toBe("1");
  });

  test("resets after both counter windows have elapsed", async () => {
    const { app, limiter } = makeApp({ windowMs: 1_000, maxRequests: 2 });
    setClock(5_000);
    await request(app).post("/test");
    await request(app).post("/test");
    setClock(7_001);

    const afterExpiry = await request(app).post("/test");

    expect(afterExpiry.status).toBe(201);
    expect(limiter.store.size).toBe(1);
  });

  test("keeps two API keys in independent tenant budgets", async () => {
    const { app } = makeApp({ windowMs: 60_000, maxRequests: 2 });
    setClock(10_000);
    const keyA = "tenant-a-secret";
    const keyB = "tenant-b-secret";

    await request(app).post("/test").set("X-API-Key", keyA);
    await request(app).post("/test").set("X-API-Key", keyA);
    const limitedA = await request(app).post("/test").set("X-API-Key", keyA);
    const firstB = await request(app).post("/test").set("X-API-Key", keyB);

    expect(limitedA.status).toBe(429);
    expect(firstB.status).toBe(201);
  });

  test("uses a digest for API-key identity and never stores the secret", () => {
    const req = { apiKey: "super-secret-key", ip: "127.0.0.1" };
    const key = identityFor(req);

    expect(key).toMatch(/^persistence:apikey:[a-f0-9]{64}$/);
    expect(key).not.toContain(req.apiKey);
  });

  test("falls back to the IP address when no API key is authenticated", () => {
    expect(identityFor({ ip: "192.0.2.10", socket: {} })).toBe(
      "persistence:ip:192.0.2.10",
    );
    expect(identityFor({ socket: { remoteAddress: "192.0.2.11" } })).toBe(
      "persistence:ip:192.0.2.11",
    );
  });

  test("uses safe defaults for missing, malformed, zero, and oversized settings", () => {
    expect(readConfig({})).toEqual({
      windowMs: DEFAULT_WINDOW_MS,
      maxRequests: DEFAULT_MAX_REQUESTS,
    });
    expect(
      readConfig({
        PERSISTENCE_RATE_LIMIT_WINDOW_MS: "not-a-number",
        PERSISTENCE_RATE_LIMIT_MAX_REQUESTS: "0",
      }),
    ).toEqual({
      windowMs: DEFAULT_WINDOW_MS,
      maxRequests: DEFAULT_MAX_REQUESTS,
    });
    expect(
      readConfig({
        PERSISTENCE_RATE_LIMIT_WINDOW_MS: String(25 * 60 * 60 * 1000),
        PERSISTENCE_RATE_LIMIT_MAX_REQUESTS: String(2_000_000),
      }),
    ).toEqual({
      windowMs: DEFAULT_WINDOW_MS,
      maxRequests: DEFAULT_MAX_REQUESTS,
    });
  });

  test("does not grow state when rejected requests are retried", async () => {
    const { limiter } = makeApp({ windowMs: 60_000, maxRequests: 1 });
    setClock(10_000);
    expect(invoke(limiter).statusCode).toBe(200);
    for (let i = 0; i < 50; i += 1) {
      expect(invoke(limiter).statusCode).toBe(429);
    }

    expect(limiter.store.size).toBe(1);
    const bucket = [...limiter.store.values()][0];
    expect(bucket.currentCount).toBe(1);
    expect(bucket.previousCount).toBe(0);
    expect(Object.keys(bucket)).toHaveLength(4);
  });

  test("normalizes a fresh app per limiter instance without sharing process state", async () => {
    setClock(1_000);
    const first = makeApp({ windowMs: 60_000, maxRequests: 1 });
    const second = makeApp({ windowMs: 60_000, maxRequests: 1 });

    const firstHit = await request(first.app).post("/test");
    const secondHit = await request(second.app).post("/test");

    expect(firstHit.status).toBe(201);
    expect(secondHit.status).toBe(201);
    expect(first.limiter.store).not.toBe(second.limiter.store);
  });

  test("supports a caller-provided store for controlled lifecycle management", async () => {
    const store = new Map();
    const { app, limiter } = makeApp({
      windowMs: 10_000,
      maxRequests: 1,
      store,
    });
    setClock(2_000);

    const response = await request(app).post("/test");

    expect(response.status).toBe(201);
    expect(limiter.store).toBe(store);
    expect(store.size).toBe(1);
  });

  test("exposes a deterministic prune hook for operators and tests", async () => {
    const { app, limiter } = makeApp({ windowMs: 1_000, maxRequests: 1 });
    setClock(1_000);
    await request(app).post("/test");
    expect(limiter.store.size).toBe(1);

    setClock(3_001);
    expect(limiter.prune()).toBe(1);
    expect(limiter.store.size).toBe(0);
  });
});
