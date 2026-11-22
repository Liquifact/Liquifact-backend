'use strict';

const fs = require('fs');
const path = require('path');

function collectEnvReferences(rootDir) {
  const sourceFiles = fs
    .readdirSync(rootDir, { recursive: true })
    .filter(f => f.endsWith('.js') && !f.includes('node_modules'));

  const references = new Set();

  for (const file of sourceFiles) {
    const fullPath = path.join(rootDir, file);
    const source = fs.readFileSync(fullPath, 'utf8');

    const processEnvMatches = source.match(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g);
    if (processEnvMatches) {
      for (const match of processEnvMatches) {
        const name = match.replace('process.env.', '');
        references.add(name);
      }
    }

    const envMatches = source.match(/\benv\.([A-Za-z_][A-Za-z0-9_]*)/g);
    if (envMatches) {
      for (const match of envMatches) {
        const name = match.replace('env.', '');
        references.add(name);
      }
    }
  }

  const intrinsicExclusions = new Set(['NODE_ENV', 'PORT']);
  for (const intrinsic of intrinsicExclusions) {
    references.delete(intrinsic);
  }

  return [...references].sort();
}

function readEnvExample(rootDir) {
  const examplePath = path.join(rootDir, '.env.example');
  if (!fs.existsSync(examplePath)) {
    return new Set();
  }
  const content = fs.readFileSync(examplePath, 'utf8');
  const documented = new Set();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (match) {
      documented.add(match[1]);
    }
  }
  return documented;
}

const rootDir = path.resolve(__dirname, '..');

test('env-example documents all source-referenced environment variables', () => {
  const sourceRefs = collectEnvReferences(path.join(rootDir, 'src'));
  const documented = readEnvExample(rootDir);

  const undocumented = sourceRefs.filter(ref => !documented.has(ref));

  expect(undocumented).toHaveLength(0, [
    'The following environment variables are referenced in source code but',
    'not documented in .env.example:',
    ...undocumented.map(ref => `  - ${ref}`),
    '',
    'Please add these variables to .env.example with a description and',
    'placeholder value where appropriate.',
  ].join('\n'));
});
