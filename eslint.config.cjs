// Lint config for the WebView layer.
//
// Those scripts run inside the app's own WebView as ES modules (`index.html` loads one
// module, the rest is imported), so the module source type applies, no bundler is involved,
// and they target the Chromium that ships with Android: the browser globals apply.

const js = require("@eslint/js");
const globals = require("globals");
const tseslint = require("typescript-eslint");
const simpleImportSort = require("eslint-plugin-simple-import-sort");

const baseRules = {
  // Block-scoped bindings only: `const` by default, `let` when reassigned.
  "no-var": "error",
  "prefer-const": "error",
  // Unused parameters and caught errors are sometimes intentional (feature
  // detection, ignored rejections). Unused variables are not.
  "no-empty": ["error", { allowEmptyCatch: true }],
  "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
  // ESLint 10's new rule cannot see the two-path try/catch idiom used throughout
  // this code (`let x = null; try { x = ... } catch (err) {}`), so it reports
  // every initialization as useless. Off until it handles that case.
  "no-useless-assignment": "off",
  "simple-import-sort/imports": "error",
  "simple-import-sort/exports": "error",
};

const typeAwareRules = {
  // These are the type-aware checks the current code can adopt without a broad rewrite.
  "@typescript-eslint/await-thenable": "error",
  "@typescript-eslint/no-array-delete": "error",
  "@typescript-eslint/no-base-to-string": "error",
  "@typescript-eslint/no-duplicate-type-constituents": "error",
  "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: true }],
  "@typescript-eslint/no-for-in-array": "error",
  "@typescript-eslint/no-implied-eval": "error",
  "@typescript-eslint/no-misused-promises": "error",
  "@typescript-eslint/no-redundant-type-constituents": "error",
  "@typescript-eslint/no-unnecessary-type-assertion": "error",
  "@typescript-eslint/only-throw-error": "error",
  "@typescript-eslint/prefer-promise-reject-errors": "error",
  "@typescript-eslint/require-await": "error",
  "@typescript-eslint/return-await": "error",
  "@typescript-eslint/unbound-method": "error",
};

module.exports = [
  js.configs.recommended,
  {
    files: ["app/src/main/assets/www/js/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parser: tseslint.parser,
      parserOptions: {
        // Type-aware linting uses the TypeScript 6 compatibility package.
        // `pnpm types` still runs the native TypeScript 7 compiler.
        projectService: true,
        tsconfigRootDir: __dirname,
      },
      globals: {
        ...globals.browser,
        // Provided by the shell: index.html's pre-paint script sets the theme before
        // first paint, and NativeBridge publishes `window.WoxiNative`.
        WoxiNative: "readonly",
        WoxiNativeCallbacks: "writable",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
      "simple-import-sort": simpleImportSort,
    },
    rules: {
      ...baseRules,
      ...typeAwareRules,
    },
  },
  {
    files: ["tests/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parser: tseslint.parser,
      parserOptions: {
        // Tests build partial fixtures and mocks. This project supplies the type
        // information for type-aware linting without enabling checker diagnostics,
        // which would reject those deliberately partial values. The app project is
        // the one `pnpm types` checks.
        project: ["./tsconfig.lint-tests.json"],
        tsconfigRootDir: __dirname,
      },
      globals: { ...globals.node },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
      "simple-import-sort": simpleImportSort,
    },
    rules: {
      ...baseRules,
      ...typeAwareRules,
      // Node's `test()` registers a test with the runner and returns a promise
      // that the runner owns. The test file does not await each registration.
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          ignoreVoid: true,
          allowForKnownSafeCalls: [{ from: "package", name: "test", package: "node:test" }],
        },
      ],
    },
  },
];
