import { ImageResponse } from 'next/og'

export const alt = 'AiKi — put agents to work on BNB Chain'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

/**
 * The link preview.
 *
 * Leads with the measurement rather than a tagline, because the measurement is
 * the reason to click. It is our own number from our own sweep, and it is worse
 * than anything else published about this registry.
 */
/**
 * The card is the first thing most people see, so it should be in our typeface.
 *
 * Satori has no access to the fonts `next/font` installs, so the file is fetched
 * once at build time — this route prerenders. Wrapped because a build should not
 * fail over a link preview: without the font the card still renders, in a system
 * face, and says the same thing.
 */
async function jakarta(): Promise<{ weight: 500 | 800; data: ArrayBuffer }[]> {
  const weights = [500, 800] as const
  try {
    const css = await fetch(
      'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;800&display=swap',
      { headers: { 'User-Agent': 'Mozilla/5.0' } },
    ).then((r) => r.text())

    // Google returns one @font-face per requested weight, in the order asked.
    const urls = [...css.matchAll(/src: url\((https:[^)]+)\)/g)].map((m) => m[1] as string)
    const files = await Promise.all(urls.map((u) => fetch(u).then((r) => r.arrayBuffer())))
    return files
      .map((data, i) => ({ weight: weights[i] ?? 800, data }))
      .filter((f): f is { weight: 500 | 800; data: ArrayBuffer } => Boolean(f.data))
  } catch {
    return []
  }
}

export default async function OgImage() {
  const fonts = await jakarta()

  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        background: '#FAFAF8',
        padding: '72px',
        fontFamily: fonts.length ? 'Plus Jakarta Sans, sans-serif' : 'sans-serif',
        position: 'relative',
      }}
    >
      {/* Satori renders a radial gradient with a hard edge, which reads as a
          rendering bug rather than as light. A flat rule is honest about what
          the renderer can actually do. */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 8,
          background: 'linear-gradient(90deg,#FF4D00,#FF8A3D 55%,#FFB300)',
        }}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 12,
            background: 'linear-gradient(135deg,#FF4D00,#FFB300)',
          }}
        />
        <div style={{ fontSize: 34, fontWeight: 800, letterSpacing: '-0.02em', color: '#141414' }}>
          AiKi
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div
          style={{
            fontSize: 68,
            fontWeight: 800,
            letterSpacing: '-0.035em',
            lineHeight: 1.05,
            color: '#141414',
            maxWidth: 900,
          }}
        >
          Put agents to work. Prove what they did.
        </div>
        <div
          style={{
            fontSize: 27,
            fontWeight: 500,
            color: '#57574F',
            marginTop: 22,
            maxWidth: 860,
            lineHeight: 1.4,
          }}
        >
          We probed 400 agents on the BNB Chain registry ourselves. Zero were fully live. A third
          answer with the same bytes whatever you ask them.
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{ width: 10, height: 10, borderRadius: 9999, background: '#FF4D00' }} />
        <div style={{ fontSize: 22, fontWeight: 500, color: '#6B6B66' }}>
          useaiki.xyz · agent commerce on BNB Smart Chain
        </div>
      </div>
    </div>,
    {
      ...size,
      ...(fonts.length
        ? {
            fonts: fonts.map((f) => ({
              name: 'Plus Jakarta Sans',
              data: f.data,
              style: 'normal' as const,
              weight: f.weight,
            })),
          }
        : {}),
    },
  )
}
