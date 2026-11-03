// Lint config for the WebView layer.
//
// Those scripts run inside the app's own WebView: they are plain scripts (no modules),
// share a global namespace (`window`, `window.WoxiRender`, ...) and target the Chromium
// that ships with Android, so the browser globals apply and no bundler is involved.

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  js.configs.recommended,
  {
    files: ['app/src/main/assets/www/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        // Provided by the shell: index.html's pre-paint script sets the theme before
        // first paint, and NativeBridge publishes `window.WoxiNative`.
        WoxiNative: 'readonly',
        WoxiNativeCallbacks: 'writable',
      },
    },
    rules: {
      // Unused parameters and caught errors are sometimes intentional (feature
      // detection, ignored rejections). Unused variables are not.
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      // Scripts here rely on hoisting and on sharing state through `window`. The
      // recommended rules already cover the real mistakes (undefined globals, typos).
      'no-empty': ['error', { allowEmptyCatch: true }],
      // ESLint 10's new rule cannot see the two-path try/catch idiom used throughout
      // this code (`var x = null; try { x = ... } catch (err) {}`), so it reports
      // every initialisation as useless. Off until it handles that case.
      'no-useless-assignment': 'off',
    },
  },
];
