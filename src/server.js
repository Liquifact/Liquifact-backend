'use strict';

/**
 * Server entry point.
 * Binds the Express app to a port. Kept separate from app setup so
 * the app module can be imported in tests without starting a server.
 */

const app = require('./index');
const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`LiquiFact API running at http://localhost:${PORT}`);
});
