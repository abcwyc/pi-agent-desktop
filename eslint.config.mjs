import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const eslintConfig = [
  {
    ignores: [
      ".claude/**",
      ".next/**",
      ".next-desktop/**",
      "test-results/**",
      "src-tauri/resources/server/**",
      "src-tauri/target/**",
      // demo/ is a separate Next.js project with its own lint config.
      "demo/**",
      // Generated, minified library bundles (scripts/build-preview-runtime.mjs).
      "public/preview-runtime/**",
    ],
  },
  ...coreWebVitals,
  ...typescript,
  {
    rules: {
      "react-hooks/immutability": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
];

export default eslintConfig;
