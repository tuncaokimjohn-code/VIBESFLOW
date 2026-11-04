import { fileURLToPath } from "node:url";
/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: fileURLToPath(new URL(".", import.meta.url)),
  // Lazy optional driver loading must include its files after external install.
  // QA must still inspect the final .nft trace before enabling production.
  outputFileTracingIncludes: { "/api/meta-direct": ["./node_modules/@neondatabase/serverless/**/*"] },
  // Use the installed TypeScript 6 compiler API. The CLI remains checked
  // separately; no type errors are ignored and no dependencies are installed.
  experimental: { useTypeScriptCli: false },
};
export default nextConfig;
