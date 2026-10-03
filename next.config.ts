import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // static export — no node server. Deployed as a private S3 bucket behind
  // CloudFront (origin access control), which also gives it https: the
  // vault needs WebCrypto, and browsers only offer that on a secure origin.
  output: "export",
  // every route becomes <route>/index.html, linked as "/setup/". S3's
  // index-document rule doesn't apply behind OAC, so a CloudFront Function
  // on viewer request rewrites a path ending in "/" to ".../index.html".
  trailingSlash: true,
};

export default nextConfig;
