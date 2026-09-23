import { fileURLToPath } from "node:url";

import { chainTargetFromEnv, sessionTargetFromEnv } from "../app/chain-target.mjs";

/*
 * The app's logic is ../app/src (wallet, deposits, fleets, sessions), imported as it is and
 * tested there; this project draws the pages around it. Its sources are TypeScript imported with
 * ".js" specifiers, so webpack is told to try ".ts" first, and they sit outside this folder.
 */
const target = chainTargetFromEnv(process.env);
const sessions = sessionTargetFromEnv(process.env);
const fleetApi = process.env.FLEET_API_ORIGIN || "https://chit.tools";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: { externalDir: true },
  env: { NEXT_PUBLIC_CHAIN_TARGET: JSON.stringify(target), NEXT_PUBLIC_SESSION_TARGET: JSON.stringify(sessions) },
  webpack(config, { webpack }) {
    config.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"], ".mjs": [".mts", ".mjs"] };
    config.resolve.modules = [...(config.resolve.modules ?? ["node_modules"]), fileURLToPath(new URL("./node_modules", import.meta.url))];
    config.plugins.push(new webpack.DefinePlugin({ __CHAIN_TARGET__: JSON.stringify({ chainId: target.chainId, chainName: target.chainName, rpcUrls: target.rpcUrls }) }));
    return config;
  },
  async rewrites() {
    return [
      // The pages and the logic still link to each other by their old file names.
      { source: "/app/:page.html", destination: "/app/:page" },
      // The service the pages sign against is the deployed one until this project is deployed beside it.
      { source: "/api/fleet/:path*", destination: `${fleetApi}/api/fleet/:path*` },
      { source: "/api/bot/:path*", destination: `${fleetApi}/api/bot/:path*` },
    ];
  },
};
export default nextConfig;
