import { ImageResponse } from 'next/og'

export const alt = 'AiKi: put agents to work'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

/**
 * The link preview is a compact frame from the same Agent Market story as the
 * landing page. It leads with the product promise, not a sweep count that will
 * age. Satori cannot access the fonts installed by `next/font`, so the file is
 * fetched once while this route prerenders. A system face remains a safe fallback.
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
        background: '#EEE8DB',
        backgroundImage:
          'linear-gradient(rgb(23 23 21 / 0.055) 1px,transparent 1px),linear-gradient(90deg,rgb(23 23 21 / 0.055) 1px,transparent 1px)',
        backgroundSize: '72px 72px',
        fontFamily: fonts.length ? 'Plus Jakarta Sans, sans-serif' : 'sans-serif',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
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

      <div
        style={{
          position: 'absolute',
          top: 34,
          right: 38,
          left: 38,
          height: 62,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 22px',
          border: '1px solid rgb(23 23 21 / 0.13)',
          borderRadius: 18,
          background: 'rgb(255 253 248 / 0.9)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', color: '#171715' }}>
          <span style={{ fontSize: 26, fontWeight: 800, letterSpacing: '-0.06em' }}>AiKi</span>
          <span style={{ color: '#FF4D00', fontSize: 26, fontWeight: 800 }}>.</span>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            color: '#666057',
            fontSize: 13,
            fontWeight: 800,
          }}
        >
          <span
            style={{
              width: 9,
              height: 9,
              borderRadius: 999,
              background: '#00A092',
              boxShadow: '0 0 0 5px rgb(0 160 146 / 0.12)',
            }}
          />
          Agent Market on BNB Chain
        </div>
      </div>

      <div
        style={{
          position: 'absolute',
          top: 138,
          left: 66,
          width: 600,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            color: '#6B655C',
            fontSize: 15,
            fontWeight: 800,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
          }}
        >
          Find. Limit. Work. Prove.
        </div>
        <div
          style={{
            marginTop: 18,
            color: '#171715',
            fontSize: 164,
            fontWeight: 800,
            letterSpacing: '-0.1em',
            lineHeight: 0.72,
          }}
        >
          AIKI
        </div>
        <div
          style={{
            marginTop: 56,
            color: '#171715',
            fontSize: 54,
            fontWeight: 800,
            letterSpacing: '-0.055em',
            lineHeight: 1,
          }}
        >
          Put agents to work.
        </div>
        <div
          style={{
            maxWidth: 500,
            marginTop: 18,
            color: '#5D584F',
            fontSize: 22,
            fontWeight: 500,
            lineHeight: 1.45,
          }}
        >
          Find one that answers. Set what it can spend. See every move.
        </div>
      </div>

      <div
        style={{
          position: 'absolute',
          top: 134,
          right: 58,
          width: 420,
          height: 440,
          display: 'flex',
          border: '1px solid rgb(23 23 21 / 0.15)',
          borderRadius: 36,
          background: 'rgb(255 253 248 / 0.74)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            position: 'absolute',
            right: 62,
            bottom: 52,
            width: 248,
            height: 248,
            border: '30px solid #FF4D00',
            borderRadius: 999,
          }}
        />
        <div
          style={{
            position: 'absolute',
            right: 24,
            bottom: 18,
            width: 340,
            height: 118,
            background: '#FFFDF8',
          }}
        />
        {[
          { x: 58, y: 64, color: '#00A092' },
          { x: 312, y: 80, color: '#F3BA2F' },
          { x: 84, y: 260, color: '#FF4D00' },
          { x: 326, y: 282, color: '#00A092' },
          { x: 212, y: 148, color: '#00A092' },
        ].map((node) => (
          <div
            key={`${node.x}-${node.y}`}
            style={{
              position: 'absolute',
              left: node.x,
              top: node.y,
              width: 18,
              height: 18,
              border: '5px solid #FFFDF8',
              borderRadius: 999,
              background: node.color,
              boxShadow: `0 0 0 2px ${node.color}`,
            }}
          />
        ))}
        {[42, 132, 222].map((x, index) => (
          <div
            key={x}
            style={{
              position: 'absolute',
              left: x,
              top: 330 + (index % 2) * 20,
              width: 74,
              height: 54,
              border: '1px solid rgb(23 23 21 / 0.2)',
              borderRadius: 14,
              background: index === 1 ? '#FF8A54' : '#E5DDCE',
              boxShadow: '0 12px 18px -12px rgb(23 23 21 / 0.4)',
            }}
          />
        ))}
        <div
          style={{
            position: 'absolute',
            top: 25,
            left: 25,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            color: '#6C665D',
            fontSize: 12,
            fontWeight: 800,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}
        >
          <span style={{ color: '#FF4D00' }}>●</span> measured market
        </div>
      </div>

      <div
        style={{
          position: 'absolute',
          bottom: 32,
          left: 66,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          color: '#6B655C',
          fontSize: 15,
          fontWeight: 800,
        }}
      >
        <span style={{ width: 10, height: 10, borderRadius: 999, background: '#FF4D00' }} />
        useaiki.xyz
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
