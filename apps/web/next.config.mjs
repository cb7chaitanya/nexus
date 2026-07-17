import { fileURLToPath } from "node:url";

// Pinned explicitly so the build doesn't depend on what other lockfiles
// happen to exist elsewhere on the machine running it (Next's root
// auto-detection otherwise walks up looking for one).
const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));

/** @type {import("next").NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: workspaceRoot,
  // Self-contained server bundle (server.js + only the node_modules it
  // actually traces as reachable) — the standard Docker-friendly output
  // mode; see apps/web/Dockerfile.
  output: "standalone",
};

export default nextConfig;
