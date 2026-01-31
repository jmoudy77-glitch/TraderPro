import { defineConfig } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  {
    ignores: [
      "realtime-ws/dist/**",
      "realtime-ws/.fly/**",
      ".next/**",
      "out/**",
      "build/**",
      "dist/**",
    ],
  },
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
      "src/app/actions/**",
      "src/lib/realtime/**",
      "src/components/realtime/**",
      "src/components/charts/HeldChartsGrid.tsx",
      "src/app/realtime-test/**",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
]);

export default eslintConfig;
