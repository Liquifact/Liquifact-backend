/**
 * LiquiFact API Gateway
 * Main entrance for the backend server.
 */

const app = require('./app');
require('dotenv').config();

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`LiquiFact API running at http://localhost:${PORT}`);
});
