/**
 * Middleware to simulate authentication by injecting a user with a role 
 * from the 'x-role' header.
 * 
 * @param {import('express').Request} req - Express request
 * @param {import('express').Response} res - Express response
 * @param {import('express').NextFunction} next - Express next function
 */
const mockAuth = (req, res, next) => {
  req.user = {
    role: req.headers['x-role'] || 'user'
  };
  next();
};

module.exports = mockAuth;
