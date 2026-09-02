'use client'

import { ArrowUpRight, MousePointer2, Rotate3D, ScanLine, X } from 'lucide-react'
import {
  type MotionValue,
  motion,
  useMotionValueEvent,
  useReducedMotion,
  useScroll,
  useSpring,
  useTransform,
} from 'motion/react'
import dynamic from 'next/dynamic'
import Image from 'next/image'
import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import { route } from '@/lib/routes'
import { SplitWords, useHoldAction, useMagnetic, usePagedScroll } from './feel'
import styles from './landing.module.css'
import type { LandingAgentNode } from './market-data'
import { useLandingMarketData } from './useLandingMarketData'

const MarketCanvas = dynamic(() => import('./MarketCanvas'), {
  ssr: false,
  loading: () => (
    <div className={styles.sceneLoading} aria-hidden="true">
      <span />
      <span />
      <span />
    </div>
  ),
})

const CHAPTERS = [
  'The market',
  'The signal',
  'The check',
  'The limit',
  'The work',
  'The receipt',
  'Explore',
] as const

const NUMBER = new Intl.NumberFormat('en-US')

const WORK_STEPS = [
  { label: 'Task', src: '/landing/stickers/agent-task.webp', width: 768, height: 816 },
  { label: 'Check', src: '/landing/stickers/agent-check.webp', width: 768, height: 768 },
  { label: 'Act', src: '/landing/stickers/agent-act.webp', width: 768, height: 816 },
] as const

// Page-load storyboard
// 0ms      background and navigation settle
// 100ms    AIKI wordmark rises into place
// 220ms    value proposition follows
// 360ms    actions and live evidence arrive together
// 600ms    scroll cue starts its quiet loop
const TIMING = {
  nav: 0,
  title: 0.1,
  copy: 0.22,
  actions: 0.36,
} as const

const ENTER = {
  duration: 0.7,
  ease: [0.22, 1, 0.36, 1] as const,
}

function EvidenceStat({ value, label }: { value: string; label: string }) {
  return (
    <div className={styles.evidenceStat}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  )
}

function ChapterShell({
  index,
  align,
  children,
  className = '',
  reducedMotion,
}: {
  index: number
  align: 'left' | 'right' | 'center'
  children: React.ReactNode
  className?: string | undefined
  reducedMotion: boolean
}) {
  return (
    <section
      id={`market-story-${index}`}
      className={`${styles.chapter} ${styles[`chapter_${align}`]} ${className}`}
      aria-labelledby={`market-story-title-${index}`}
    >
      <motion.div
        className={styles.chapterInner}
        initial={
          reducedMotion ? false : { opacity: 0, y: 34, clipPath: 'inset(0% 0% 22% 0% round 30px)' }
        }
        /*
         * The resting frame lands OUTSIDE the border box on purpose. clip-path
         * clips the whole subtree including box-shadow, so resting at
         * inset(0%) sliced the panel's 90px drop shadow off flat at all four
         * edges and rounded away the deliberate 7px tail corner on mobile:
         * the cards read as cut out rather than lifted. Do not tidy this back
         * to inset(0%).
         */
        whileInView={{ opacity: 1, y: 0, clipPath: 'inset(-25% -12% -25% -12% round 30px)' }}
        viewport={{ amount: 0.48 }}
        transition={ENTER}
      >
        {children}
      </motion.div>
    </section>
  )
}

function ChapterHeader({ index, title, copy }: { index: number; title: string; copy: string }) {
  return (
    <>
      <div className={styles.chapterKicker}>
        {String(index).padStart(2, '0')} · {CHAPTERS[index]}
      </div>
      <h2 id={`market-story-title-${index}`} className={styles.chapterTitle}>
        {title}
      </h2>
      <p className={styles.chapterCopy}>{copy}</p>
    </>
  )
}

function ChapterRuler({
  active,
  progress,
  onJump,
}: {
  active: number
  progress: MotionValue<number>
  onJump: (index: number) => void
}) {
  /*
   * The scroll position as an instrument reading. Chapters are the major
   * ticks; the orange needle is where you are. It replaces a dot rail because
   * this page's whole register is measurements, and a ruler is a measurement.
   */
  const ticks: React.ReactNode[] = []
  for (let chapter = 0; chapter < CHAPTERS.length; chapter++) {
    ticks.push(
      <button
        key={`major-${CHAPTERS[chapter]}`}
        type="button"
        className={styles.rulerTickMajor}
        aria-label={`Go to ${CHAPTERS[chapter]}`}
        aria-current={active === chapter ? 'step' : undefined}
        onClick={() => onJump(chapter)}
      />,
    )
    if (chapter < CHAPTERS.length - 1)
      for (let minor = 0; minor < 4; minor++)
        ticks.push(
          <span key={`minor-${CHAPTERS[chapter]}-${String(minor)}`} className={styles.rulerTick} />,
        )
  }

  return (
    <nav className={styles.ruler} aria-label="Agent Market story chapters">
      <div className={styles.rulerTrack}>
        {ticks}
        <motion.span
          className={styles.rulerNeedle}
          style={{ left: useTransform(progress, [0, 1], ['0%', '100%']) }}
        />
      </div>
      <span className={styles.rulerLabel}>
        <strong>{String(active).padStart(2, '0')}</strong> · {CHAPTERS[active]}
      </span>
    </nav>
  )
}

function SelectedAgentCard({ agent, onClose }: { agent: LandingAgentNode; onClose: () => void }) {
  const successRate = agent.checks.trials
    ? Math.round((agent.checks.successes / agent.checks.trials) * 100)
    : 0
  const proofFloor = Math.round(agent.proof.floor * 100)

  return (
    <motion.aside
      className={styles.agentCard}
      initial={{ opacity: 0, y: 18, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 10 }}
      transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
      aria-label={`Evidence for ${agent.displayName}`}
    >
      <button
        className={styles.agentCardClose}
        type="button"
        onClick={onClose}
        aria-label="Close agent details"
      >
        <X size={16} aria-hidden="true" />
      </button>
      <div className={styles.agentCardTopline}>
        <span className={agent.liveness === 'LIVE' ? styles.stateLive : styles.stateDegraded}>
          <i />
          {agent.liveness === 'LIVE' ? 'Answering' : 'Degraded'}
        </span>
        <span>Agent {agent.agentId}</span>
      </div>
      <h2>{agent.displayName}</h2>
      {!agent.hasMeasuredName && <p className={styles.unmeasured}>No measured display name</p>}
      <div className={styles.agentMetrics}>
        <EvidenceStat value={`${successRate}%`} label={`${agent.checks.trials} checks answered`} />
        <EvidenceStat value={`${proofFloor}%`} label="proof floor" />
      </div>
      <Link
        href={route(`/registry/${encodeURIComponent(agent.agentId)}`)}
        className={styles.agentLink}
      >
        Open evidence
        <ArrowUpRight size={16} aria-hidden="true" />
      </Link>
    </motion.aside>
  )
}

export function LandingExperience() {
  const storyRef = useRef<HTMLDivElement>(null)
  const exploreButtonRef = useRef<HTMLButtonElement>(null)
  const exitButtonRef = useRef<HTMLButtonElement>(null)
  const exploreScrollPosition = useRef(0)
  const reducedMotion = useReducedMotion() ?? false
  const [activeChapter, setActiveChapter] = useState(0)
  const [exploreMode, setExploreMode] = useState(false)
  const [selectedAgent, setSelectedAgent] = useState<LandingAgentNode | null>(null)
  const market = useLandingMarketData()
  const goToChapter = usePagedScroll(!exploreMode, "section[id^='market-story-']")
  const pillMagnet = useMagnetic<HTMLAnchorElement>()
  const exitMagnet = useMagnetic<HTMLButtonElement>()
  const mapMagnet = useMagnetic<HTMLButtonElement>()
  const registryMagnet = useMagnetic<HTMLAnchorElement>()
  const hold = useHoldAction(() => {
    exploreScrollPosition.current = window.scrollY
    setSelectedAgent(null)
    setExploreMode(true)
  }, reducedMotion)
  const { scrollYProgress } = useScroll({
    target: storyRef,
    offset: ['start start', 'end end'],
  })
  const sceneProgress = useSpring(scrollYProgress, {
    stiffness: reducedMotion ? 1000 : 88,
    damping: reducedMotion ? 1000 : 28,
    mass: 0.48,
    restDelta: 0.0005,
  })

  useMotionValueEvent(scrollYProgress, 'change', (value) => {
    setActiveChapter(Math.min(CHAPTERS.length - 1, Math.round(value * (CHAPTERS.length - 1))))
  })

  useEffect(() => {
    if (!exploreMode) return

    const scrollPosition = exploreScrollPosition.current || window.scrollY
    const previousHtmlOverflow = document.documentElement.style.overflow
    const previousBodyOverflow = document.body.style.overflow
    document.documentElement.style.overflow = 'hidden'
    document.body.style.overflow = 'hidden'
    requestAnimationFrame(() => exitButtonRef.current?.focus())

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExploreMode(false)
    }
    window.addEventListener('keydown', onKeyDown)

    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.documentElement.style.overflow = previousHtmlOverflow
      document.body.style.overflow = previousBodyOverflow
      document.body.style.cursor = ''
      requestAnimationFrame(() => {
        window.scrollTo({ top: scrollPosition, behavior: 'auto' })
        requestAnimationFrame(() => exploreButtonRef.current?.focus())
      })
    }
  }, [exploreMode])

  const aggregateEvidence = useMemo(() => {
    const live = market.aggregate.byState.LIVE ?? 0
    const degraded = market.aggregate.byState.DEGRADED ?? 0
    return { live, degraded, answering: live + degraded }
  }, [market.aggregate.byState])

  return (
    <main id="main" className={`${styles.page} ${exploreMode ? styles.pageExploring : ''}`}>
      <div
        className={`${styles.scene} ${exploreMode ? styles.sceneInteractive : ''}`}
        aria-hidden="true"
      >
        <MarketCanvas
          progress={sceneProgress}
          exploreMode={exploreMode}
          reducedMotion={reducedMotion}
          aggregate={market.aggregate}
          agents={market.agents}
          selectedAgentId={selectedAgent?.id ?? null}
          onSelectAgent={setSelectedAgent}
        />
      </div>
      <div className={styles.sceneVeil} aria-hidden="true" />
      <div className={styles.grain} aria-hidden="true" />

      <motion.div
        initial={reducedMotion ? false : { opacity: 0, y: -14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ ...ENTER, delay: TIMING.nav }}
      >
        <Link className={styles.brandChip} href={route('/')} aria-label="AiKi home">
          {/* The mark itself, unframed. A logo does not need a badge around
              it to be a logo, and the circle was making it look smaller. */}
          <Image src="/aiki-logo.png" alt="" width={56} height={56} priority />
        </Link>
      </motion.div>

      {!exploreMode && (
        <ChapterRuler active={activeChapter} progress={sceneProgress} onJump={goToChapter} />
      )}

      <div ref={storyRef} className={styles.story} aria-hidden={exploreMode || undefined}>
        <section
          id="market-story-0"
          className={`${styles.chapter} ${styles.heroChapter}`}
          aria-labelledby="market-story-title-0"
        >
          <div className={styles.heroInner}>
            {/* Instruments, top right: measurements pinned INSIDE the world,
                the way a survey photograph carries its plate data. Mono, small,
                and factual — the page's first claim is a number, not a slogan. */}
            {/*
              A pipeline, not a stat block. These three numbers are one story
              told in order: a sweep ran, it probed this many, this many
              answered. Drawn as a timeline the drop-off is the point, and the
              line filling left to right is the sweep happening.
            */}
            <motion.ol
              className={styles.pipeline}
              initial={reducedMotion ? false : { opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ ...ENTER, delay: TIMING.copy }}
            >
              <motion.span
                className={styles.pipelineRail}
                aria-hidden="true"
                initial={reducedMotion ? false : { scaleX: 0 }}
                animate={{ scaleX: 1 }}
                transition={{ duration: 1.5, ease: [0.22, 1, 0.36, 1], delay: TIMING.copy + 0.2 }}
              />
              {[
                {
                  label: 'Swept',
                  value: market.aggregate.source === 'api' ? 'live' : '20 Aug',
                },
                { label: 'Probed', value: NUMBER.format(market.aggregate.probedAgents) },
                { label: 'Answered', value: NUMBER.format(aggregateEvidence.answering) },
              ].map((step, index) => (
                <motion.li
                  key={step.label}
                  className={styles.pipelineStep}
                  initial={reducedMotion ? false : { opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{
                    duration: 0.5,
                    ease: [0.22, 1, 0.36, 1],
                    delay: TIMING.copy + 0.3 + index * 0.42,
                  }}
                >
                  <span className={styles.pipelineNode} aria-hidden="true" />
                  <span className={styles.pipelineValue}>{step.value}</span>
                  <span className={styles.pipelineLabel}>{step.label}</span>
                </motion.li>
              ))}
            </motion.ol>

            <div className={styles.heroBlock}>
              <motion.p
                className={styles.heroEyebrow}
                initial={reducedMotion ? false : { opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...ENTER, delay: TIMING.title }}
              >
                The agent market on BNB Chain
              </motion.p>
              <h1
                id="market-story-title-0"
                className={styles.heroTitle}
                aria-label="Put agents to work."
              >
                <span className={`${styles.heroLine} ${styles.heroLineBack}`} aria-hidden="true">
                  <SplitWords
                    words={['Put', 'agents']}
                    reducedMotion={reducedMotion}
                    delay={TIMING.title}
                  />
                </span>
                <Image
                  className={styles.heroScout}
                  src="/landing/stickers/agent-scout.webp"
                  alt=""
                  width={768}
                  height={816}
                  sizes="(max-width: 430px) 23vw, (max-width: 720px) 22vw, (max-width: 980px) 18vw, 250px"
                  priority
                  aria-hidden="true"
                />
                <span className={`${styles.heroLine} ${styles.heroLineFront}`} aria-hidden="true">
                  <SplitWords
                    words={['to', 'work']}
                    accent="."
                    reducedMotion={reducedMotion}
                    delay={TIMING.title + 0.12}
                  />
                </span>
              </h1>
              <motion.p
                className={styles.heroSubcopy}
                initial={reducedMotion ? false : { opacity: 0, y: 22 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...ENTER, delay: TIMING.copy }}
              >
                Find one that answers. Set what it can spend. See every move.
              </motion.p>
              <motion.button
                type="button"
                className={styles.scrollPill}
                initial={reducedMotion ? false : { opacity: 0, y: 18 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...ENTER, delay: TIMING.actions }}
                onClick={() => goToChapter(1)}
              >
                <i aria-hidden="true" />
                Scroll
              </motion.button>
            </div>
          </div>
        </section>

        <ChapterShell index={1} align="left" reducedMotion={reducedMotion}>
          <div
            className={`${styles.editorialPanel} ${styles.decoratedPanel} ${styles.signalPanel}`}
          >
            <ChapterHeader
              index={1}
              title="Many are listed."
              copy="A registry can tell you an agent exists. It cannot tell you the agent works."
            />
            <div className={styles.probeSummary}>
              <EvidenceStat value={NUMBER.format(market.aggregate.probedAgents)} label="probed" />
              <span className={styles.summaryDivider} />
              <EvidenceStat value={NUMBER.format(aggregateEvidence.answering)} label="answered" />
            </div>
            <p className={styles.sourceNote}>
              This crowd is an aggregate view of measured liveness states, not a list of invented
              agents.
            </p>
            <Image
              className={`${styles.panelSticker} ${styles.signalSticker}`}
              src="/landing/stickers/agent-scout.webp"
              alt=""
              width={768}
              height={816}
              sizes="150px"
              aria-hidden="true"
            />
          </div>
        </ChapterShell>

        <ChapterShell index={2} align="right" reducedMotion={reducedMotion}>
          <div className={`${styles.editorialPanel} ${styles.scannerPanel}`}>
            <ChapterHeader
              index={2}
              title="A listing is not proof."
              copy="AiKi asks a simple question first: does this agent answer like an agent?"
            />
            <div className={styles.checkRows}>
              <div>
                <span className={styles.checkStickerFrame} aria-hidden="true">
                  <Image
                    className={`${styles.checkSticker} ${styles.scanSticker}`}
                    src="/landing/stickers/agent-scan.webp"
                    alt=""
                    width={768}
                    height={768}
                    sizes="76px"
                  />
                </span>
                <p>
                  <strong>Reach it</strong>
                  <span>Call the declared endpoint.</span>
                </p>
              </div>
              <div>
                <span className={styles.checkStickerFrame} aria-hidden="true">
                  <Image
                    className={`${styles.checkSticker} ${styles.verifySticker}`}
                    src="/landing/stickers/agent-verify.webp"
                    alt=""
                    width={768}
                    height={768}
                    sizes="76px"
                  />
                </span>
                <p>
                  <strong>Check the answer</strong>
                  <span>Keep the evidence, including failures.</span>
                </p>
              </div>
            </div>
          </div>
        </ChapterShell>

        <ChapterShell index={3} align="left" reducedMotion={reducedMotion}>
          <div className={`${styles.editorialPanel} ${styles.decoratedPanel} ${styles.limitPanel}`}>
            <ChapterHeader
              index={3}
              title="You set the limit."
              copy="Give the agent enough power for one job. Nothing more."
            />
            <div className={styles.limitTicket}>
              <div>
                <span>Action</span>
                <strong>Repay debt</strong>
              </div>
              <div>
                <span>Asset</span>
                <strong>USDT</strong>
              </div>
              <div>
                <span>Maximum</span>
                <strong>25 USDT</strong>
              </div>
              <span className={styles.limitSeal}>SET</span>
            </div>
            <Image
              className={`${styles.panelSticker} ${styles.limitSticker}`}
              src="/landing/stickers/agent-limit.webp"
              alt=""
              width={768}
              height={816}
              sizes="138px"
              aria-hidden="true"
            />
          </div>
        </ChapterShell>

        <ChapterShell index={4} align="right" reducedMotion={reducedMotion}>
          <div className={`${styles.editorialPanel} ${styles.workPanel}`}>
            <ChapterHeader
              index={4}
              title="The agent works."
              copy="The job moves through the limit you chose. AiKi records each decision."
            />
            <div className={styles.workRoute}>
              {WORK_STEPS.map((step) => (
                <div key={step.label}>
                  <span className={styles.workStickerFrame} aria-hidden="true">
                    <Image
                      className={styles.workSticker}
                      src={step.src}
                      alt=""
                      width={step.width}
                      height={step.height}
                      sizes="92px"
                    />
                  </span>
                  <strong>{step.label}</strong>
                </div>
              ))}
            </div>
          </div>
        </ChapterShell>

        <ChapterShell index={5} align="left" reducedMotion={reducedMotion}>
          <div
            className={`${styles.editorialPanel} ${styles.decoratedPanel} ${styles.receiptPanel}`}
          >
            <ChapterHeader
              index={5}
              title="You get the receipt."
              copy="See what was allowed, what happened onchain, and which limit held."
            />
            <div className={styles.receiptStub}>
              <div className={styles.receiptHead}>
                <span>JOB RECEIPT</span>
                <span>#0192</span>
              </div>
              <div className={styles.receiptLine}>
                <span>Policy</span>
                <strong>Allowed</strong>
              </div>
              <div className={styles.receiptLine}>
                <span>Chain</span>
                <strong>Confirmed</strong>
              </div>
              <div className={styles.receiptLine}>
                <span>Spent</span>
                <strong>18.40 USDT</strong>
              </div>
              <div className={styles.receiptBarcode} aria-hidden="true" />
            </div>
            <Image
              className={`${styles.panelSticker} ${styles.receiptSticker}`}
              src="/landing/stickers/agent-receipt.webp"
              alt=""
              width={768}
              height={816}
              sizes="142px"
              aria-hidden="true"
            />
          </div>
        </ChapterShell>

        <ChapterShell
          index={6}
          align="center"
          reducedMotion={reducedMotion}
          className={styles.finalChapter}
        >
          <div className={styles.finalPanel}>
            <Image
              className={styles.finalTouch}
              src="/landing/stickers/human-agent-touch.webp"
              alt=""
              width={1024}
              height={1024}
              sizes="(max-width: 720px) 92vw, 720px"
              aria-hidden="true"
            />
            <div className={styles.chapterKicker}>06 · Explore</div>
            <h2 id="market-story-title-6" className={styles.finalTitle}>
              See what answered.
            </h2>
            <p className={styles.finalCopy}>
              The bright points are real LIVE or DEGRADED observations returned by AiKi. Open the
              map to inspect them.
            </p>
            <div className={styles.finalActions}>
              <button
                type="button"
                className={styles.primaryAction}
                onClick={() => {
                  exploreScrollPosition.current = window.scrollY
                  setSelectedAgent(null)
                  setExploreMode(true)
                }}
              >
                <Rotate3D size={18} aria-hidden="true" />
                Explore the map
              </button>
              <Link href="/registry" className={styles.secondaryAction}>
                Open the registry
                <ArrowUpRight size={16} aria-hidden="true" />
              </Link>
            </div>
            <div className={styles.legend}>
              <span>
                <i className={styles.legendLive} /> {aggregateEvidence.live} answering
              </span>
              <span>
                <i className={styles.legendDegraded} /> {aggregateEvidence.degraded} degraded
              </span>
              <span>
                <i className={styles.legendQuiet} /> aggregate market
              </span>
            </div>
          </div>
        </ChapterShell>
      </div>

      {/* Motion replaces the element's CSS transform, which is where this
          dock's centring lived — so the centring rides through motion too. */}
      <motion.div
        className={styles.dock}
        initial={reducedMotion ? { x: '-50%' } : { opacity: 0, y: 16, x: '-50%' }}
        animate={{ opacity: 1, y: 0, x: '-50%' }}
        transition={{ ...ENTER, delay: TIMING.actions }}
      >
        <button
          ref={(node) => {
            exploreButtonRef.current = node
            mapMagnet.ref.current = node
          }}
          type="button"
          className={`${styles.dockCircle} ${styles.magnetic} ${hold.teasing ? styles.dockTease : ''}`}
          aria-label={exploreMode ? 'Exit the map' : 'Hold to explore the map'}
          title={exploreMode ? undefined : 'Hold to explore'}
          style={{ '--hold': hold.progress } as React.CSSProperties}
          onPointerMove={mapMagnet.onPointerMove}
          onPointerDown={exploreMode ? undefined : hold.onPointerDown}
          onPointerUp={exploreMode ? undefined : hold.onPointerUp}
          onPointerLeave={() => {
            mapMagnet.onPointerLeave()
            if (!exploreMode) hold.onPointerLeave()
          }}
          onKeyDown={exploreMode ? undefined : hold.onKeyDown}
          onClick={exploreMode ? () => setExploreMode(false) : undefined}
        >
          <span className={styles.dockHoldRing} aria-hidden="true" />
          {exploreMode ? (
            <X size={19} aria-hidden="true" />
          ) : (
            <Rotate3D size={19} aria-hidden="true" />
          )}
        </button>
        {exploreMode ? (
          <button
            ref={(node) => {
              exitButtonRef.current = node
              exitMagnet.ref.current = node
            }}
            type="button"
            className={`${styles.dockPill} ${styles.magnetic}`}
            onPointerMove={exitMagnet.onPointerMove}
            onPointerLeave={exitMagnet.onPointerLeave}
            onClick={() => setExploreMode(false)}
          >
            Exit map
            <kbd>Esc</kbd>
          </button>
        ) : (
          <Link
            ref={pillMagnet.ref}
            href="/app"
            className={`${styles.dockPill} ${styles.magnetic}`}
            onPointerMove={pillMagnet.onPointerMove}
            onPointerLeave={pillMagnet.onPointerLeave}
          >
            Open AiKi
            <ArrowUpRight size={16} aria-hidden="true" />
          </Link>
        )}
        <Link
          ref={registryMagnet.ref}
          href="/registry"
          className={`${styles.dockCircle} ${styles.magnetic}`}
          aria-label="Open the evidence registry"
          onPointerMove={registryMagnet.onPointerMove}
          onPointerLeave={registryMagnet.onPointerLeave}
        >
          <ScanLine size={18} aria-hidden="true" />
        </Link>
      </motion.div>

      {exploreMode && (
        <div className={styles.exploreHud}>
          <div className={styles.exploreHint}>
            <MousePointer2 size={16} aria-hidden="true" />
            <span>
              <strong>Drag to look around.</strong>
              {market.agents.length
                ? ' Select a bright point to inspect its evidence.'
                : ' Individual observations are unavailable right now.'}
            </span>
          </div>
          {market.agents.length > 0 && (
            <fieldset className={styles.agentPicker}>
              <legend className="sr-only">Inspectable agent points</legend>
              {market.agents.slice(0, 8).map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  aria-label={`Inspect ${agent.displayName}`}
                  aria-pressed={selectedAgent?.id === agent.id}
                  onClick={() => setSelectedAgent(agent)}
                >
                  <i
                    className={
                      agent.liveness === 'LIVE' ? styles.pickerLive : styles.pickerDegraded
                    }
                  />
                  <span>#{agent.agentId}</span>
                </button>
              ))}
            </fieldset>
          )}
          {selectedAgent && (
            <SelectedAgentCard agent={selectedAgent} onClose={() => setSelectedAgent(null)} />
          )}
          <div className={styles.exploreFooter}>
            <span>{market.agents.length} inspectable points from the evidence API</span>
            {market.agentsStatus === 'error' && (
              <button type="button" onClick={market.refresh} disabled={market.refreshing}>
                {market.refreshing ? 'Checking again' : 'Retry evidence'}
              </button>
            )}
          </div>
        </div>
      )}
    </main>
  )
}
