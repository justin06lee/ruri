import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Flat config. typescript-eslint's *untyped* recommended set on purpose:
 * the type-checked rules need a full program per run, which is most of a
 * `tsc` — `bun run typecheck` already does that, and lint should be quick
 * enough to run on every save.
 */
export default tseslint.config(
  {
    ignores: ["dist-*/**", "node_modules/**", "build/**", "web/public/**", ".claude/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // the plain-JS scripts (shot.mjs, chips.mjs) run under bun/node; the
    // TypeScript files get their globals from their tsconfig instead
    files: ["**/*.mjs"],
    languageOptions: { globals: { ...globals.node, Bun: "readonly" } },
  },
  {
    files: ["web/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks, "react-refresh": reactRefresh },
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },
  {
    rules: {
      // `catch {}` with a comment saying why is the house style; the
      // rule cannot see the comment
      "no-empty": ["error", { allowEmptyCatch: true }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },
);
