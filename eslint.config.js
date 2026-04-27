const security = require('eslint-plugin-security');
const jsdoc = require('eslint-plugin-jsdoc');
const globals = require('globals');

module.exports = [
  {
    ignores: ['coverage/**'],
  },
  {
    files: ['src/**/*.js', 'migrator-config.js', 'scripts/**/*.js'],
    plugins: { security, jsdoc },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      ...security.configs.recommended.rules,
      'security/detect-object-injection': 'off',
      'security/detect-unsafe-regex': 'off',
      'jsdoc/require-jsdoc': ['error', { require: { FunctionDeclaration: true, MethodDefinition: true } }],
      'jsdoc/require-description': 'error',
      'jsdoc/require-returns': 'error',
      'jsdoc/require-param': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'curly': 'error',
    },
  },
  {
    files: ['src/**/*.test.js', 'src/**/__tests__/**/*.js', 'src/__tests__/**/*.js', 'tests/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
        describe: 'readonly',
        test: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        beforeAll: 'readonly',
        beforeEach: 'readonly',
        afterAll: 'readonly',
        afterEach: 'readonly',
      },
    },
    rules: {
      'jsdoc/require-jsdoc': 'off',
      'jsdoc/require-description': 'off',
      'jsdoc/require-returns': 'off',
      'jsdoc/require-param': 'off',
      'security/detect-object-injection': 'off',
      'security/detect-non-literal-regexp': 'off',
    },
  },
  {
    files: ['src/**/__mocks__/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    rules: {
      'jsdoc/require-jsdoc': 'off',
      'jsdoc/require-description': 'off',
      'jsdoc/require-returns': 'off',
      'jsdoc/require-param': 'off',
    },
  },
];
