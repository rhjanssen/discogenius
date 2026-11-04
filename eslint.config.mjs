import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import jsxA11y from "eslint-plugin-jsx-a11y";
import tseslint from "typescript-eslint";

const jsxA11yWarnings = Object.fromEntries(
  Object.keys(jsxA11y.flatConfigs.recommended.rules).map((rule) => [rule, "warn"]),
);

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/.venv/**",
      "app/public/**",
      ".github/skills/**",
      ".ref_*/**",
      "config/**",
      "downloads/**",
      "library/**",
      "tmp/**",
      "test-results/**",
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["api/**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["app/**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
      "jsx-a11y": jsxA11y,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11yWarnings,
      // The upstream default also treats image lifecycle callbacks (onLoad and
      // onError) as user interaction. Keep the rule focused on actual input
      // handlers; click-specific rules still catch pointer-only controls.
      "jsx-a11y/no-noninteractive-element-interactions": ["warn", {
        handlers: [
          "onClick",
          "onDoubleClick",
          "onMouseDown",
          "onMouseUp",
          "onKeyDown",
          "onKeyUp",
          "onKeyPress",
          "onFocus",
          "onBlur",
        ],
      }],
      "react-refresh/only-export-components": ["warn", {
        allowConstantExport: true,
        // This module intentionally exports its co-located column-definition
        // hook alongside the artists-tab components. Hooks do not hold module
        // state and are safe across Fast Refresh boundaries.
        allowExportNames: ["useLibraryArtistColumns"],
      }],
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    // Issue #80: Fluent tokens + makeStyles only in these files.
    files: [
      "app/src/components/Layout.tsx",
      "app/src/components/FilterMenu.tsx",
      "app/src/components/ui/ProviderMark.tsx",
      "app/src/components/ui/LoadingSkeletons.tsx",
      "app/src/components/ui/QualityBadge.tsx",
      "app/src/components/mediafiles/FileMaintenanceDialogs.tsx",
      "app/src/pages/Auth.tsx",
      "app/src/pages/dashboard/ManualImportModal.tsx",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        { selector: "JSXAttribute[name.name='style']", message: "Use makeStyles/Fluent tokens instead of inline style." },
        { selector: "Literal[value=/#[0-9a-fA-F]{3,8}\\b/]", message: "Use Fluent tokens instead of hex colours." },
      ],
    },
  },
);
