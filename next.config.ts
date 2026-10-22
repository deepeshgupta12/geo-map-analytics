import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  // A stray package-lock.json in the home directory made Turbopack pick the wrong
  // workspace root (and miss file changes). Pin it to this project.
  turbopack: { root: __dirname },
};

export default nextConfig;
