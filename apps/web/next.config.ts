import type { NextConfig } from 'next'

/** A fixed, ignored target prevents an opt-in QA build from cleaning the live dev output. */
export function isolatedBuildDirectory(value: string | undefined) {
  if (value === undefined || value === '') return undefined
  if (value !== '.next-build-qa') throw new Error('AIKI_BUILD_DIR must be .next-build-qa when set.')
  return value
}
const buildDirectory = isolatedBuildDirectory(process.env.AIKI_BUILD_DIR)
const withoutPersistentCache = (webpackConfig: { cache?: unknown }) => {
  webpackConfig.cache = false
  return webpackConfig
}

/**
 * A `.js` specifier in TypeScript source means the TypeScript beside it.
 *
 * The contract package ships source rather than a build artifact, and its
 * source is written for `nodenext`, where a relative import inside an ESM
 * package must carry the extension the emitted JavaScript would have. Nothing
 * here ever emits that JavaScript: the API runs through tsx and this app
 * transpiles the package itself, so `./approval.js` only ever needs to find
 * `./approval.ts`.
 *
 * webpack does not do that on its own, and for a long time nothing noticed,
 * because every value this app took from the package came from a module with
 * no relative imports of its own and everything else was imported as a type
 * and erased. The first relative import on a reachable path failed the
 * production build after a green typecheck, green lint and a green test run,
 * none of which use this resolver. Declared here so the next one cannot.
 */
const resolveJsToTypeScript = (webpackConfig: {
  resolve?: { extensionAlias?: Record<string, string[]> }
}) => {
  webpackConfig.resolve ??= {}
  const resolve = webpackConfig.resolve
  resolve.extensionAlias = {
    ...resolve.extensionAlias,
    '.js': ['.ts', '.tsx', '.js'],
    '.mjs': ['.mts', '.mjs'],
  }
  return webpackConfig
}

export const webpack: NonNullable<NextConfig['webpack']> = (webpackConfig) => {
  resolveJsToTypeScript(webpackConfig)
  return buildDirectory ? withoutPersistentCache(webpackConfig) : webpackConfig
}

const config: NextConfig = {
  ...(buildDirectory
    ? { distDir: buildDirectory, typescript: { tsconfigPath: 'tsconfig.build-qa.json' } }
    : {}),
  webpack,
  // The contract package ships TypeScript source, not a build artifact, so the
  // seam stays a single source of truth rather than something we compile twice.
  transpilePackages: ['@aiki/contracts'],
  typedRoutes: true,
  // Next 16 writes AGENTS.md and CLAUDE.md into the app on first run. We do not
  // want tool-attribution files in this repo, so turn it off at the source rather
  // than gitignoring them and hoping.
  agentRules: false,
  // The dev overlay badge lands bottom-left, on top of a real control.
  devIndicators: false,

  /**
   * The API is served from this same origin, by proxy.
   *
   * The session is an HttpOnly SameSite=Lax cookie, and the browser only sends
   * one to the same SITE. Railway's generated hostnames sit under
   * `up.railway.app`, which is on the Public Suffix List, so two services there
   * are cross-site: the cookie would simply never be sent, sign-in would appear
   * to succeed, and every authenticated request would quietly be a 401.
   *
   * Proxying is not a workaround for that, it is the stricter arrangement. The
   * browser talks to exactly one origin, so the cookie is same-ORIGIN rather
   * than merely same-site, and there is no cross-origin request to configure
   * CORS for at all. API_PROXY_TARGET points at Railway's private network in
   * production, so this traffic never leaves their backbone.
   */
  async rewrites() {
    const target = process.env.API_PROXY_TARGET
    if (!target) return []
    return [
      { source: '/v1/:path*', destination: `${target}/v1/:path*` },
      { source: '/v2/:path*', destination: `${target}/v2/:path*` },
      { source: '/healthz', destination: `${target}/healthz` },
      /**
       * D8, the reciprocal proof, is checked at the AGENT'S OWN domain: a
       * verifier reads the registration file named on chain, then asks the host
       * it points at whether it acknowledges that agent id. Both halves have to
       * answer from the same origin, so if the manifest is served from here this
       * has to be too, or every first-party agent fails its own D8 check.
       */
      {
        source: '/.well-known/agent-registration.json',
        destination: `${target}/.well-known/agent-registration.json`,
      },
    ]
  },
}

export default config
