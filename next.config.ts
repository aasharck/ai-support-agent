import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Loaded from node_modules at runtime instead of bundled: PGlite and pgvector ship
  // WebAssembly and data files, and unpdf ships its own PDF.js build.
  serverExternalPackages: ["@electric-sql/pglite", "@electric-sql/pglite-pgvector", "unpdf", "pg"],
};

export default nextConfig;
