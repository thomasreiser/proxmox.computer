import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // static export — no node server, deployable straight to S3/any static host.
  output: "export",
  // plain S3 (no CloudFront rewrite function) only serves an index document
  // for keys ending in "/" — this makes /setup emit setup/index.html and
  // link to "/setup/" so S3's index-document rule actually resolves it.
  trailingSlash: true,
};

export default nextConfig;
