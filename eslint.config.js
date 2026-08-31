// Flat ESLint config for the whole repo: bridge (Node/CommonJS) and
// extension (browser + chrome.*). Run via `npm run lint` inside bridge/.
// Kept require-free so it works from the repo root without a root package.

const commonRules = {
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-undef': 'error',
  'no-dupe-keys': 'error',
  'no-unreachable': 'error',
  'no-constant-condition': ['error', { checkLoops: false }],
  'prefer-const': 'error',
  eqeqeq: ['error', 'smart'],
  'no-var': 'error',
};

const sharedGlobals = {
  console: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  URL: 'readonly',
  TextDecoder: 'readonly',
  Promise: 'readonly',
};

module.exports = [
  {
    ignores: ['**/node_modules/**', 'dist/**', 'build/**'],
  },
  {
    files: ['bridge/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        ...sharedGlobals,
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
      },
    },
    rules: commonRules,
  },
  {
    // Node script che vive nella cartella dell'estensione: non gira nel
    // browser, e senza questa riga il lint del repo non e' mai verde.
    files: ['extension/dev-watch.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...sharedGlobals, require: 'readonly', module: 'writable', process: 'readonly', __dirname: 'readonly' },
    },
    rules: commonRules,
  },
  {
    files: ['extension/**/*.js'],
    ignores: ['extension/dev-watch.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: {
        ...sharedGlobals,
        window: 'readonly',
        self: 'readonly',
        document: 'readonly',
        chrome: 'readonly',
        fetch: 'readonly',
        navigator: 'readonly',
        WebSocket: 'readonly',
        Node: 'readonly',
        CSS: 'readonly',
        AbortSignal: 'readonly',
        OffscreenCanvas: 'readonly',
        createImageBitmap: 'readonly',
        btoa: 'readonly',
        crypto: 'readonly',
        Uint8Array: 'readonly',
        EyeDropper: 'readonly',
        module: 'writable',
        PromptBuilder: 'readonly',
      },
    },
    rules: commonRules,
  },
];
