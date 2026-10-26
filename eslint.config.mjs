import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const nodeOnly = [
  { group: ["react", "react/*", "react-dom", "react-dom/*"], message: "Code loaded by Node must stay framework free." },
  { group: ["next", "next/*"], message: "Code loaded by Node must stay framework free." },
  { group: ["three", "three/*", "@react-three/*"], message: "Code loaded by Node must stay framework free." },
  { group: ["@/*"], message: "Node cannot resolve the @/ alias. Use a relative import with a .ts extension." },
];

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    // Hard rule 1: src/shared is loaded directly by Node (server + tests).
    files: ["src/shared/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...nodeOnly,
            { group: ["@anthropic-ai/*"], message: "Domain types must not depend on Claude Agent SDK types." },
          ],
        },
      ],
    },
  },
  {
    // The server and scripts run under Node/tsx and import src/shared with relative .ts paths.
    files: ["server/**/*.ts", "scripts/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: nodeOnly }],
    },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "reference/**",
    "data/**",
    ".beads/**",
    ".npm-cache/**",
    ".tmp/**",
  ]),
]);
