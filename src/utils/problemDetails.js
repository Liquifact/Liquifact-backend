/**
 * RFC 7807 (Problem Details for HTTP APIs) Formatter.
 * Takes error data and formats it into a standard JSON object.
 */
function formatProblemDetails({
  type = 'about:blank',
  title = 'An unexpected error occurred',
  status = 500,
  detail,
  instance,
  stack,
  isProduction = process.env.NODE_ENV === 'production',
}) {
  const problem = {
    type,
    title,
    status,
    detail,
    instance,
  };

  // Only include stack trace if NOT in production for security reasons
  if (!isProduction && stack) {
    problem.stack = stack;
  }

  return problem;
}

module.exports = formatProblemDetails;
