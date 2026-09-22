import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Bulk CSV uploads (employees, salary, attendance) post the file through a Server
      // Action; the 1MB default is too small for larger attendance sheets.
      bodySizeLimit: "5mb",
    },
  },
};

export default nextConfig;
