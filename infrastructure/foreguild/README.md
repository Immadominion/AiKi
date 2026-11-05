# Foreguild publication route

The public AiKi website uses Cloudflare Pages. Its production deployment was an ad-hoc upload on 1 October 2026, with no recorded commit hash. GitHub main also deploys to Vercel.

Worker `aiki-foreguild` serves only these routes:

- `www.useaiki.xyz/foreguild`
- `www.useaiki.xyz/foreguild/*`

The Worker reads the public proposal files from `https://aiki-web.vercel.app`. Source files live in `apps/web/public/foreguild/2026-11-05`. The page rewrite lives in `apps/web/next.config.ts`.

Only GET and HEAD requests are accepted. Cookies and authorization headers are not forwarded. No secrets or storage bindings are required. Other AiKi paths remain on Pages.

Cloudflare account: `b635d2c7967268309b1384eb4ffe5093`.
Zone: `73ce9b50a0958756beaa890d82612858`.
Compatibility date: `2026-11-05`.

Published through the documented Worker script upload and route APIs using the existing account login. To remove this publication route, delete the two Worker routes first. That returns those paths to the existing Pages site. Keep the route while the contest entry links to these files.
