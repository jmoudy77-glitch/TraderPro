import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: [
      "src/app/api/**",
      "src/components/charts/**",
      "src/components/modals/**",
      "src/components/hooks/**",
      "src/components/shell/AppShell.tsx",
      "src/components/state/ChartStateProvider.tsx",
      "src/components/watchlists/WatchlistsPanel.tsx",
      "src/lib/market-data/twelvedata.ts",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
