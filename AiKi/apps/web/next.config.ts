import type { NextConfig } from 'next'

const config: NextConfig = {
  // The contract package ships TypeScript source, not a build artifact, so the
  // seam stays a single source of truth rather than something we compile twice.
  transpilePackages: ['@aiki/contracts'],
  typedRoutes: true,
  // Next 16 writes AGENTS.md and CLAUDE.md into the app on first run. We do not
  // want tool-attribution files in this repo, so turn it off at the source rather
  // than gitignoring them and hoping.
  agentRules: false,
}

export default config
