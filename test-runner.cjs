const { execSync } = require('child_process');
const result = execSync('node node_modules/jest-cli/bin/jest.js --runInBand --forceExit --testPathPattern="tests/contract/indexerResponseContract" --verbose', {
  cwd: __dirname,
  stdio: 'inherit',
  env: { ...process.env, NODE_OPTIONS: '--no-warnings' },
});
process.exit(result.status);
