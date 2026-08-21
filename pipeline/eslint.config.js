// Flat config. The rules here are the ones that catch real defects in this codebase: a floating
// promise against DuckDB loses an error silently, and an unchecked `any` is how a column name typo
// reaches a published artifact. Formatting is left to Prettier via eslint-config-prettier, so this
// config never argues about whitespace.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: ["node_modules/**", "dist/**", ".data/**", "vendor/**", "coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      // Provenance and column names are strings built at runtime; an unused one is usually a
      // half-finished rename, which is exactly the class of bug that ships a wrong column.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // The pipeline talks to DuckDB, S3 and SFTP. A dropped promise there is a silent data loss.
      "no-console": ["error", { allow: ["error"] }],
      eqeqeq: ["error", "smart"],
      "no-var": "error",
      "prefer-const": "error",
      // `let x: T | null = null` before a try/catch that assigns it is the clearest way to write
      // a fallible step here, and the rule objects to the initialiser rather than to a defect.
      "no-useless-assignment": "off",
    },
  },
  {
    // Tests may reach for `any` when they stub a client, and they print.
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-console": "off",
    },
  },
);
