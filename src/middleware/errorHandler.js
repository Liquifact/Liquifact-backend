/**
 * Global error handling middleware
 * Ensures consistent error responses and prevents stack leaks in production.
 */
const errorHandler = (err, req, res, _next) => {
  console.error(err);

  const statusCode = err.statusCode || 500;

  res.status(statusCode).json({
    error: {
      message:
        process.env.NODE_ENV === 'production'
          ? 'Internal server error'
          : err.message,
      ...(process.env.NODE_ENV !== 'production' && {
        stack: err.stack,
      }),
    },
  });
};

module.exports = errorHandler;
