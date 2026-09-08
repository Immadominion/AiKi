'use client'

import { Canvas, useFrame, useThree } from '@react-three/fiber'
import type { MotionValue } from 'motion/react'
import {
  Component,
  type ErrorInfo,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { ACESFilmicToneMapping, PCFShadowMap, SRGBColorSpace } from 'three'
import styles from './landing.module.css'
import { MarketWorld } from './MarketWorld'
import type { LandingAgentNode, LandingMarketAggregate } from './market-data'

const DPR_TIERS = [1, 1.5, 2] as const
const QUALITY_COOLDOWN_MS = 5_000

/* ─────────────────────────────────────────────────────────
 * SCENE BOOT STORYBOARD
 *
 *    0ms   light market-map placeholder is already visible
 *  frame   loaded town paints once behind the placeholder
 * +200ms   placeholder fades away to reveal that exact frame
 * ───────────────────────────────────────────────────────── */
const SCENE_BOOT = {
  fadeMs: 200,
} as const

function average(samples: readonly number[]) {
  return samples.reduce((total, sample) => total + sample, 0) / Math.max(samples.length, 1)
}

/**
 * Resolution follows sustained rendering cost, never a single bad frame.
 * Geometry and story state stay intact while only pixel density changes.
 */
function AdaptiveQuality({ reducedMotion }: { reducedMotion: boolean }) {
  const { setDpr } = useThree()
  const tier = useRef(0)
  const maximumTier = useRef(0)
  const slowWindow = useRef<number[]>([])
  const fastWindow = useRef<number[]>([])
  const lastChange = useRef(0)

  useEffect(() => {
    const deviceDpr = Math.min(window.devicePixelRatio || 1, 2)
    maximumTier.current = deviceDpr >= 2 ? 2 : deviceDpr >= 1.5 ? 1 : 0
    tier.current = reducedMotion ? Math.min(1, maximumTier.current) : maximumTier.current
    setDpr(DPR_TIERS[tier.current] ?? 1)
    slowWindow.current = []
    fastWindow.current = []
    lastChange.current = performance.now() - QUALITY_COOLDOWN_MS
  }, [reducedMotion, setDpr])

  useFrame((_, delta) => {
    if (document.hidden || delta <= 0 || delta > 0.25) {
      slowWindow.current = []
      fastWindow.current = []
      return
    }

    const frameTime = delta * 1_000
    slowWindow.current.push(frameTime)
    fastWindow.current.push(frameTime)
    if (slowWindow.current.length > 60) slowWindow.current.shift()
    if (fastWindow.current.length > 180) fastWindow.current.shift()

    const now = performance.now()
    if (now - lastChange.current < QUALITY_COOLDOWN_MS) return

    let nextTier = tier.current
    if (slowWindow.current.length === 60 && average(slowWindow.current) > 20) {
      nextTier = Math.max(0, tier.current - 1)
    } else if (fastWindow.current.length === 180 && average(fastWindow.current) < 14) {
      nextTier = Math.min(maximumTier.current, tier.current + 1)
    }

    if (nextTier === tier.current) return
    tier.current = nextTier
    setDpr(DPR_TIERS[nextTier] ?? 1)
    lastChange.current = now
    slowWindow.current = []
    fastWindow.current = []
  })

  return null
}

function SceneFallback({ onReady }: { onReady: () => void }) {
  useEffect(() => onReady(), [onReady])

  return (
    <div
      className={styles.sceneFallback}
      role="img"
      aria-label="Abstract map of the AiKi Agent Market"
    >
      <span className={styles.fallbackRing} />
      <span className={styles.fallbackPath} />
      <span className={styles.fallbackNode} />
    </div>
  )
}

class SceneBoundary extends Component<
  { children: ReactNode; onFallback: () => void },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('The Agent Market scene could not start.', error, info.componentStack)
  }

  render() {
    if (this.state.failed) {
      return <SceneFallback onReady={this.props.onFallback} />
    }
    return this.props.children
  }
}

/** Report only after the loaded world has reached the screen once. */
function FirstSceneFrame({ onReady }: { onReady: () => void }) {
  const reported = useRef(false)

  useFrame(() => {
    if (reported.current) return
    reported.current = true
    onReady()
  })

  return null
}

export default function MarketCanvas({
  progress,
  exploreMode,
  exploreResetKey,
  reducedMotion,
  aggregate,
  agents,
  selectedAgentId,
  onSelectAgent,
}: {
  progress: MotionValue<number>
  exploreMode: boolean
  exploreResetKey?: number | undefined
  reducedMotion: boolean
  aggregate: LandingMarketAggregate
  agents: readonly LandingAgentNode[]
  selectedAgentId: string | null
  onSelectAgent: (agent: LandingAgentNode) => void
}) {
  const [sceneReady, setSceneReady] = useState(false)
  const markSceneReady = useCallback(() => setSceneReady(true), [])

  return (
    <SceneBoundary onFallback={markSceneReady}>
      <Canvas
        shadows
        dpr={reducedMotion ? [1, 1.5] : [1, 2]}
        camera={{ position: [15, 11, 20], fov: 36, near: 0.1, far: 120 }}
        gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }}
        style={{ background: '#f4f6ff' }}
        onCreated={({ gl }) => {
          gl.setClearColor('#f4f6ff', 1)
          gl.outputColorSpace = SRGBColorSpace
          gl.toneMapping = ACESFilmicToneMapping
          gl.toneMappingExposure = 1.12
          gl.shadowMap.type = PCFShadowMap
        }}
        fallback={<SceneFallback onReady={markSceneReady} />}
      >
        <AdaptiveQuality reducedMotion={reducedMotion} />
        <Suspense fallback={null}>
          <MarketWorld
            progress={progress}
            exploreMode={exploreMode}
            exploreResetKey={exploreResetKey}
            reducedMotion={reducedMotion}
            aggregate={aggregate}
            agents={agents}
            selectedAgentId={selectedAgentId}
            onSelectAgent={onSelectAgent}
          />
          <FirstSceneFrame onReady={markSceneReady} />
        </Suspense>
      </Canvas>
      <div
        className={styles.sceneLoading}
        aria-hidden="true"
        style={{
          zIndex: 1,
          pointerEvents: 'none',
          opacity: sceneReady ? 0 : 1,
          visibility: sceneReady ? 'hidden' : 'visible',
          transition: reducedMotion
            ? 'none'
            : `opacity ${SCENE_BOOT.fadeMs}ms cubic-bezier(0, 0, 0.2, 1), visibility 0s linear ${SCENE_BOOT.fadeMs}ms`,
        }}
      >
        <span />
        <span />
        <span />
      </div>
    </SceneBoundary>
  )
}
