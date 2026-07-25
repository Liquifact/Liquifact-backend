const formatProblemDetails = require("../../src/utils/problemDetails");

describe("problemDetails Formatter Unit Tests", () => {
  const mockError = {
    type: "https://example.com/probs/bad-request",
    title: "Bad Request",
    status: 400,
    detail: "The provided data is invalid.",
    instance: "/api/v1/resource",
    stack: "Error at line 1...",
  };

  test("should return a properly formatted object in development", () => {
    const problem = formatProblemDetails({ ...mockError, isProduction: false });

    expect(problem).toEqual({
      type: mockError.type,
      title: mockError.title,
      status: mockError.status,
      detail: mockError.detail,
      instance: mockError.instance,
      stack: mockError.stack,
    });
  });

  test("should hide stack trace when in production", () => {
    const problem = formatProblemDetails({ ...mockError, isProduction: true });

    expect(problem).not.toHaveProperty("stack");
    expect(problem.type).toBe(mockError.type);
    expect(problem.title).toBe(mockError.title);
    expect(problem.status).toBe(mockError.status);
    expect(problem.detail).toBe(mockError.detail);
    expect(problem.instance).toBe(mockError.instance);
  });

  test("should use sensible defaults if fields are missing", () => {
    const problem = formatProblemDetails({});

    expect(problem.type).toBe("about:blank");
    expect(problem.title).toBe("An unexpected error occurred");
    expect(problem.status).toBe(500);
  });

  test("should include custom extensions (code, retryable, retryHint) correctly formatted", () => {
    const problem = formatProblemDetails({
      status: 400,
      code: "VALIDATION_FAILED",
      retryable: false,
      retryHint: "Check inputs",
    });

    expect(problem.code).toBe("VALIDATION_FAILED");
    expect(problem.retryable).toBe(false);
    expect(problem.retry_hint).toBe("Check inputs");
  });

  test("should produce exact RFC 7807 shape with no unexpected fields", () => {
    const problem = formatProblemDetails({
      type: "https://example.com/probs/test",
      title: "Test Title",
      status: 422,
      detail: "A detail.",
      instance: "/test",
      code: "TEST_CODE",
      retryable: true,
      retryHint: "Wait and retry",
      isProduction: true,
    });

    // Only the fields we expect — no stack, no internal keys
    expect(Object.keys(problem).sort()).toEqual([
      "code",
      "detail",
      "instance",
      "retry_hint",
      "retryable",
      "status",
      "title",
      "type",
    ]);
  });

  test("should not include optional fields when not provided", () => {
    const problem = formatProblemDetails({
      type: "about:blank",
      title: "Test",
      status: 400,
      isProduction: false,
    });

    expect(problem).not.toHaveProperty("detail");
    expect(problem).not.toHaveProperty("instance");
    expect(problem).not.toHaveProperty("stack");
    expect(problem).not.toHaveProperty("code");
    expect(problem).not.toHaveProperty("retryable");
    expect(problem).not.toHaveProperty("retry_hint");
  });

  test("should never include stack when isProduction is true", () => {
    const problem = formatProblemDetails({
      status: 500,
      stack: "Error: something\n    at test.js:1:1",
      isProduction: true,
    });

    expect(problem).not.toHaveProperty("stack");
  });

  test("should never expose internal fields in output", () => {
    const problem = formatProblemDetails({
      status: 400,
      isProduction: true,
    });

    const keys = Object.keys(problem);
    expect(keys).not.toContain("stack");
    expect(keys).not.toContain("isProduction");
    expect(keys).not.toContain("retryHint"); // output uses retry_hint
  });

  test("should produce correct shape when consuming mapError-like input", () => {
    // mapError returns: { status, code, message, retryable, retryHint }
    const mapped = {
      status: 503,
      code: "UPSTREAM_ERROR",
      message: "Service unavailable.",
      retryable: true,
      retryHint: "Retry later.",
    };

    const problem = formatProblemDetails({
      type: "https://liquifact.com/probs/service-unavailable",
      title: mapped.message,
      status: mapped.status,
      detail: mapped.message,
      code: mapped.code,
      retryable: mapped.retryable,
      retryHint: mapped.retryHint,
      isProduction: true,
    });

    expect(problem).toEqual({
      type: "https://liquifact.com/probs/service-unavailable",
      title: "Service unavailable.",
      status: 503,
      detail: "Service unavailable.",
      code: "UPSTREAM_ERROR",
      retryable: true,
      retry_hint: "Retry later.",
    });
  });
});
