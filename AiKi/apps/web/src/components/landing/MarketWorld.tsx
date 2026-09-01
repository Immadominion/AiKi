'use client'

import { OrbitControls, useGLTF } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import type { MotionValue } from 'motion/react'
import { type ElementRef, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Box3,
  Color,
  type DirectionalLight,
  type Group,
  type HemisphereLight,
  type InstancedMesh,
  MathUtils,
  Matrix4,
  Mesh,
  type MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  type Scene,
  Vector3,
} from 'three'
import type { LandingAgentNode, LandingMarketAggregate } from './market-data'

/**
 * A small market town that keeps working while you watch.
 *
 * The construction follows Infinitown's discipline: one strict grid, a small
 * set of building shapes rotated four ways, fog in EXACTLY the background
 * colour so the town dissolves before an edge can exist, a single warm sun
 * with soft shadows, and life delivered through small loops — couriers on
 * their rounds, clouds dragging their shade across the roofs. Nothing glows.
 *
 * The models are KayKit's City Builder Bits (CC0 — see the manifest beside
 * them). Infinitown's own models are commercial and its mirrors on GitHub are
 * unlicensed rips, so what we take from it is the craft, and the craft is laid
 * over assets we are actually allowed to ship.
 *
 * Everything is deterministic: the town is generated from a fixed seed, so it
 * is the same town on every visit and on both sides of hydration.
 */

type Vec3 = [number, number, number]

/** The page's own cool paper. Clear colour, fog and ground begin here. */
const CANVAS = '#f4f6ff'

const PALETTE = {
  ink: '#090b12',
  paper: '#ffffff',
  bone: '#dfe6ff',
  quiet: '#748096',
  orange: '#2f5bff',
  yellow: '#c8f43d',
  cyan: '#24d8ff',
  lime: '#9eff43',
  violet: '#7657ff',
  street: '#dce4f5',
  dash: '#ffffff',
  cloud: '#ffffff',
} as const

/** Cool bright tints keep every district distinct without staining the page beige. */
const DISTRICT_TINTS = [
  '#e3ebff',
  '#dffaff',
  '#edffd8',
  '#ffe8f3',
  '#ece5ff',
  '#dff8f2',
  '#e7f2ff',
  '#f2e8ff',
] as const

const KIT = '/landing/models/kaykit-city'
const BUILDING_KINDS = [
  `${KIT}/building_A_withoutBase.gltf`,
  `${KIT}/building_B_withoutBase.gltf`,
  `${KIT}/building_C_withoutBase.gltf`,
  `${KIT}/building_D_withoutBase.gltf`,
  `${KIT}/building_E_withoutBase.gltf`,
  `${KIT}/building_F_withoutBase.gltf`,
  `${KIT}/building_G_withoutBase.gltf`,
  `${KIT}/building_H_withoutBase.gltf`,
] as const
const PROP = {
  bush: `${KIT}/bush.gltf`,
  bench: `${KIT}/bench.gltf`,
  streetlight: `${KIT}/streetlight.gltf`,
  hydrant: `${KIT}/firehydrant.gltf`,
  dumpster: `${KIT}/dumpster.gltf`,
  boxA: `${KIT}/box_A.gltf`,
  boxB: `${KIT}/box_B.gltf`,
  sedan: `${KIT}/car_sedan.gltf`,
  hatchback: `${KIT}/car_hatchback.gltf`,
  wagon: `${KIT}/car_stationwagon.gltf`,
} as const

/* ── deterministic layout ─────────────────────────────────────────────── */

/** mulberry32. Seeded so server and client agree on every roof in town. */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Street centre lines on both axes. Blocks live between them. */
const STREETS = [-15, -9, -3, 3, 9, 15]
const STREET_W = 1.7
const BLOCKS = [-12, -6, 0, 6, 12]
const LOT_OFFSET = 1.1

/** Blocks handed over to the real, clickable agents. */
const AGENT_BLOCKS = new Set(['6,-6', '12,-6', '6,-12'])
/** The centre block is the market square, not offices. */
const SQUARE_BLOCK = '0,0'

interface KitPlacement {
  position: Vec3
  rotation: number
  /** Uniform, applied on top of the model's normalised footprint. */
  scale: number
}

interface StallSpec {
  x: number
  z: number
  rotation: number
  awning: string
}

function planTown(answering: number) {
  const random = rng(20260830)
  const lotsByKind: KitPlacement[][] = BUILDING_KINDS.map(() => [])
  const bushes: KitPlacement[] = []
  const plinths: KitPlacement[] = []
  const agentLots: { x: number; z: number; rotation: number }[] = []

  for (const bx of BLOCKS) {
    for (const bz of BLOCKS) {
      const key = `${bx},${bz}`
      if (key === SQUARE_BLOCK) continue

      for (const [ox, oz] of [
        [-LOT_OFFSET, -LOT_OFFSET],
        [LOT_OFFSET, -LOT_OFFSET],
        [-LOT_OFFSET, LOT_OFFSET],
        [LOT_OFFSET, LOT_OFFSET],
      ] as const) {
        const x = bx + ox
        const z = bz + oz

        if (AGENT_BLOCKS.has(key)) {
          agentLots.push({ x, z, rotation: Math.atan2(ox, oz) })
          continue
        }

        // A block keeps a garden corner now and then instead of a fourth office.
        if (random() < 0.15) {
          bushes.push({ position: [x, 0, z], rotation: random() * Math.PI, scale: 1.5 + random() })
          if (random() < 0.5)
            bushes.push({
              position: [x + (random() - 0.5) * 1.3, 0, z + (random() - 0.5) * 1.3],
              rotation: random() * Math.PI,
              scale: 0.9 + random() * 0.7,
            })
          continue
        }

        const kind = Math.floor(random() * BUILDING_KINDS.length)
        const placements = lotsByKind[kind]
        if (placements)
          placements.push({
            position: [x, 0, z],
            // Doors face the nearest street: outward on both axes.
            rotation: Math.atan2(Math.sign(ox), Math.sign(oz)),
            scale: 0.94 + random() * 0.14,
          })
        plinths.push({ position: [x, 0, z], rotation: 0, scale: 1 })
      }
    }
  }

  // Street bushes at block corners, and an outskirt fringe walking into the fog.
  for (const bx of BLOCKS) {
    for (const bz of BLOCKS) {
      if (rng(bx * 31 + bz * 7 + 5)() < 0.5)
        bushes.push({
          position: [bx + 2.62, 0, bz - 2.62],
          rotation: random() * Math.PI,
          scale: 1 + random() * 0.6,
        })
    }
  }
  for (let i = 0; i < 26; i++) {
    const along = -19 + random() * 38
    const side = random() < 0.5 ? -1 : 1
    const edge = 17.4 + random() * 3.4
    const horizontal = random() < 0.5
    bushes.push({
      position: [horizontal ? along : side * edge, 0, horizontal ? side * edge : along],
      rotation: random() * Math.PI,
      scale: 1 + random() * 1.1,
    })
  }

  /*
   * Pavement furniture — the layer that does half the visual work in
   * Infinitown. Seeded like everything else, sparse enough to stay furniture.
   */
  const streetlights: KitPlacement[] = []
  const benches: KitPlacement[] = []
  const hydrants: KitPlacement[] = []
  const dumpsters: KitPlacement[] = []
  for (const bx of BLOCKS) {
    for (const bz of BLOCKS) {
      if (`${bx},${bz}` === SQUARE_BLOCK) continue
      const r = rng(bx * 131 + bz * 17 + 9)
      if (r() < 0.6)
        streetlights.push({
          position: [bx - 2.6, 0, bz + 2.6],
          rotation: Math.PI / 4,
          scale: 1,
        })
      if (r() < 0.3)
        benches.push({
          position: [bx + 2.55, 0, bz + (r() - 0.5) * 3],
          rotation: -Math.PI / 2,
          scale: 1,
        })
      if (r() < 0.22) hydrants.push({ position: [bx - 2.55, 0, bz - 1.6], rotation: 0, scale: 1 })
      if (r() < 0.18)
        dumpsters.push({
          position: [bx + (r() - 0.5) * 2, 0, bz - 2.58],
          rotation: Math.PI,
          scale: 1,
        })
    }
  }

  // Crates around the market square, where the stalls trade.
  const crates: KitPlacement[] = []
  for (let i = 0; i < 7; i++) {
    const angle = (i / 7) * Math.PI * 2 + 0.4
    crates.push({
      position: [Math.cos(angle) * 2.05, 0, Math.sin(angle) * 2.05],
      rotation: random() * Math.PI,
      scale: 0.9 + random() * 0.35,
    })
  }

  // A few parked cars. Kerb-side, never in a crossing.
  const cars: { placement: KitPlacement; model: number }[] = []
  const parkSpots: [number, number, number][] = [
    [-9 + 0.5, -6.4, 0],
    [3 + 0.5, 4.6, 0],
    [-3 - 0.5, 10.4, Math.PI],
    [9 - 0.5, -1.2, Math.PI],
    [-6.6, -3 + 0.5, Math.PI / 2],
    [7.8, 9 - 0.5, -Math.PI / 2],
  ]
  parkSpots.forEach(([px, pz, rot], index) => {
    cars.push({
      placement: { position: [px, 0, pz], rotation: rot, scale: 1 },
      model: index % 3,
    })
  })

  // The market stalls, procedural on purpose: paper boxes with cloth awnings
  // read as furniture, and orange stays rationed to things that answer.
  const stalls: StallSpec[] = [
    { x: -1.15, z: -1.15, rotation: Math.PI / 4, awning: PALETTE.orange },
    { x: 1.15, z: -1.15, rotation: -Math.PI / 4, awning: PALETTE.yellow },
    { x: -1.15, z: 1.15, rotation: (3 * Math.PI) / 4, awning: PALETTE.cyan },
    {
      x: 1.15,
      z: 1.15,
      rotation: (-3 * Math.PI) / 4,
      awning: answering > 6 ? PALETTE.lime : PALETTE.violet,
    },
  ]

  return {
    lotsByKind,
    bushes,
    plinths,
    agentLots,
    streetlights,
    benches,
    hydrants,
    dumpsters,
    crates,
    cars,
    stalls,
  }
}

/* ── kit loading ──────────────────────────────────────────────────────── */

interface KitPart {
  geometry: Mesh['geometry']
  material: MeshStandardMaterial
}

interface SurfaceProfile {
  roughness: number
  metalness: number
  tint: string
  textureRoughness?: boolean
}

function surfaceProfile(path: string): SurfaceProfile {
  const buildingIndex = BUILDING_KINDS.indexOf(path as (typeof BUILDING_KINDS)[number])
  if (buildingIndex >= 0) {
    return {
      roughness: 0.94,
      metalness: 0,
      tint: DISTRICT_TINTS[buildingIndex] ?? PALETTE.paper,
      // The kit uses one atlas. Reusing its luminance as roughness keeps light
      // walls matte while the dark window panes catch the key light.
      textureRoughness: true,
    }
  }

  if (path.includes('/car_') || path.endsWith('/spacetruck.gltf')) {
    return {
      roughness: 0.68,
      metalness: 0.08,
      tint: '#f7faff',
      textureRoughness: true,
    }
  }

  if (
    path.endsWith('/streetlight.gltf') ||
    path.endsWith('/firehydrant.gltf') ||
    path.endsWith('/dumpster.gltf')
  ) {
    return { roughness: 0.62, metalness: 0.12, tint: '#f7fbfa' }
  }

  if (path.endsWith('/bush.gltf')) {
    return { roughness: 1, metalness: 0, tint: '#eaffd2' }
  }

  return { roughness: 0.84, metalness: 0, tint: '#f7f9ff' }
}

/**
 * A glTF turned into instanceable parts.
 *
 * World transforms are baked into cloned geometry, then the whole model is
 * normalised — centred, grounded at y=0, scaled to a target size — so the
 * per-instance matrix stays a plain place-rotate-scale. `footprint` normalises
 * by the x/z extent (buildings, cars); `max` by the largest extent, which
 * behaves for tall thin things like streetlights.
 */
function useKitParts(path: string, target: number, mode: 'footprint' | 'max' = 'footprint') {
  const { scene } = useGLTF(path)
  const { gl } = useThree()

  return useMemo<KitPart[]>(() => {
    const anisotropy = Math.min(8, gl.capabilities.getMaxAnisotropy())
    const profile = surfaceProfile(path)
    scene.updateMatrixWorld(true)
    const sources: Mesh[] = []
    scene.traverse((child) => {
      if (child instanceof Mesh) sources.push(child)
    })

    const bounds = new Box3()
    const baked = sources.map((source) => {
      const geometry = source.geometry.clone()
      geometry.applyMatrix4(source.matrixWorld)
      geometry.computeBoundingBox()
      if (geometry.boundingBox) bounds.union(geometry.boundingBox)
      return { geometry, source }
    })

    const size = new Vector3()
    const centre = new Vector3()
    bounds.getSize(size)
    bounds.getCenter(centre)
    const extent =
      mode === 'footprint' ? Math.max(size.x, size.z) : Math.max(size.x, size.y, size.z)
    const fit = target / Math.max(extent, 0.0001)
    const normalise = new Matrix4()
      .makeScale(fit, fit, fit)
      .multiply(new Matrix4().makeTranslation(-centre.x, -bounds.min.y, -centre.z))

    return baked.map(({ geometry, source }) => {
      geometry.applyMatrix4(normalise)
      const material = (
        Array.isArray(source.material) ? source.material[0] : source.material
      ) as MeshStandardMaterial
      const cloned = material.clone()
      cloned.color.multiply(new Color(profile.tint))
      cloned.roughness = profile.roughness
      cloned.metalness = profile.metalness
      if (cloned.map) {
        cloned.map.anisotropy = anisotropy
        cloned.map.needsUpdate = true
        if (profile.textureRoughness && !cloned.roughnessMap) cloned.roughnessMap = cloned.map
      }
      cloned.needsUpdate = true
      return { geometry, material: cloned }
    })
  }, [gl, scene, target, mode, path])
}

/** One draw call per part, shared across every placement of the model. */
function KitInstances({
  path,
  target,
  mode,
  placements,
  castShadow = true,
}: {
  path: string
  target: number
  mode?: 'footprint' | 'max'
  placements: KitPlacement[]
  castShadow?: boolean
}) {
  const parts = useKitParts(path, target, mode)
  const meshes = useRef<(InstancedMesh | null)[]>([])

  useLayoutEffect(() => {
    const dummy = new Object3D()
    for (const mesh of meshes.current) {
      if (!mesh) continue
      placements.forEach((item, index) => {
        dummy.position.set(...item.position)
        dummy.rotation.set(0, item.rotation, 0)
        dummy.scale.setScalar(item.scale)
        dummy.updateMatrix()
        mesh.setMatrixAt(index, dummy.matrix)
      })
      mesh.instanceMatrix.needsUpdate = true
    }
  }, [placements])

  if (placements.length === 0) return null
  return (
    <group>
      {parts.map((part, index) => (
        <instancedMesh
          key={`${path}-${String(index)}`}
          ref={(mesh) => {
            meshes.current[index] = mesh
          }}
          args={[part.geometry, part.material, placements.length]}
          castShadow={castShadow}
          receiveShadow
        />
      ))}
    </group>
  )
}

/* ── instancing for the painted parts ─────────────────────────────────── */

interface InstanceItem {
  position: Vec3
  rotation?: Vec3
  /** Applied in the LOCAL frame after yaw. Euler order eats a naive [x,y,0]. */
  pitch?: number
  scale: Vec3
  color: string
}

function Instances({
  items,
  geometry,
  castShadow = false,
  receiveShadow = false,
  roughness = 0.92,
  metalness = 0,
}: {
  items: InstanceItem[]
  geometry: React.ReactNode
  castShadow?: boolean
  receiveShadow?: boolean
  roughness?: number
  metalness?: number
}) {
  const mesh = useRef<InstancedMesh>(null)

  useLayoutEffect(() => {
    const instanced = mesh.current
    if (!instanced) return
    const dummy = new Object3D()
    const color = new Color()
    items.forEach((item, index) => {
      dummy.position.set(...item.position)
      dummy.rotation.set(...(item.rotation ?? [0, 0, 0]))
      if (item.pitch) dummy.rotateX(item.pitch)
      dummy.scale.set(...item.scale)
      dummy.updateMatrix()
      instanced.setMatrixAt(index, dummy.matrix)
      instanced.setColorAt(index, color.set(item.color))
    })
    instanced.instanceMatrix.needsUpdate = true
    if (instanced.instanceColor) instanced.instanceColor.needsUpdate = true
  }, [items])

  return (
    <instancedMesh
      ref={mesh}
      args={[undefined, undefined, items.length]}
      castShadow={castShadow}
      receiveShadow={receiveShadow}
    >
      {geometry}
      <meshStandardMaterial color="#ffffff" roughness={roughness} metalness={metalness} />
    </instancedMesh>
  )
}

/* ── ground, streets, square ──────────────────────────────────────────── */

function Ground({ plinths }: { plinths: KitPlacement[] }) {
  const lanes = useMemo<InstanceItem[]>(() => {
    const items: InstanceItem[] = []
    for (const s of STREETS) {
      items.push({ position: [s, 0.012, 0], scale: [STREET_W, 0.024, 36.6], color: PALETTE.street })
      items.push({ position: [0, 0.012, s], scale: [36.6, 0.024, STREET_W], color: PALETTE.street })
    }
    return items
  }, [])

  const dashes = useMemo<InstanceItem[]>(() => {
    const items: InstanceItem[] = []
    for (const s of STREETS) {
      for (let along = -17.4; along <= 17.4; along += 1.5) {
        if (STREETS.some((cross) => Math.abs(along - cross) < 1.2)) continue
        items.push({ position: [s, 0.032, along], scale: [0.07, 0.012, 0.62], color: PALETTE.dash })
        items.push({ position: [along, 0.032, s], scale: [0.62, 0.012, 0.07], color: PALETTE.dash })
      }
      for (const cross of STREETS) {
        for (const side of [-1.35, 1.35]) {
          for (let bar = -0.51; bar <= 0.51; bar += 0.34) {
            items.push({
              position: [s + bar, 0.032, cross + side],
              scale: [0.16, 0.012, 0.5],
              color: PALETTE.dash,
            })
            items.push({
              position: [cross + side, 0.032, s + bar],
              scale: [0.5, 0.012, 0.16],
              color: PALETTE.dash,
            })
          }
        }
      }
    }
    return items
  }, [])

  const contact = useMemo<InstanceItem[]>(
    () =>
      plinths.map((p) => ({
        position: [p.position[0], 0.017, p.position[2]] as Vec3,
        scale: [2.2, 0.014, 2.2] as Vec3,
        color: '#dce3f4',
      })),
    [plinths],
  )

  return (
    <group>
      {/* One vast sheet of the page's own paper. With fog and clear colour
          matched to it, the world has no edge — only distance. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[240, 240]} />
        <meshStandardMaterial color={CANVAS} roughness={1} />
      </mesh>
      <mesh position={[0, 0.005, 0]} receiveShadow>
        <boxGeometry args={[36.6, 0.01, 36.6]} />
        <meshStandardMaterial color={PALETTE.paper} roughness={0.96} />
      </mesh>
      <Instances items={lanes} geometry={<boxGeometry />} receiveShadow roughness={0.86} />
      <Instances items={dashes} geometry={<boxGeometry />} roughness={0.72} />
      {/* Contact plinths: the poor man's baked AO. Grounded beats floating. */}
      <Instances items={contact} geometry={<boxGeometry />} receiveShadow />
      <mesh position={[0, 0.03, 0]} receiveShadow>
        <cylinderGeometry args={[2.5, 2.5, 0.05, 28]} />
        <meshStandardMaterial color={PALETTE.bone} roughness={0.88} />
      </mesh>
    </group>
  )
}

/** Market furniture: a paper box, two posts, a cloth awning. */
function Stall({ spec }: { spec: StallSpec }) {
  return (
    <group position={[spec.x, 0, spec.z]} rotation={[0, spec.rotation, 0]}>
      <mesh position={[0, 0.26, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.95, 0.52, 0.72]} />
        <meshStandardMaterial color={PALETTE.paper} roughness={0.88} />
      </mesh>
      {(
        [
          [-0.42, -0.28],
          [0.42, -0.28],
          [-0.42, 0.28],
          [0.42, 0.28],
        ] as const
      ).map(([px, pz]) => (
        <mesh key={`${px}-${pz}`} position={[px, 0.55, pz]} castShadow>
          <boxGeometry args={[0.07, 1.1, 0.07]} />
          <meshStandardMaterial color={PALETTE.ink} roughness={0.54} metalness={0.08} />
        </mesh>
      ))}
      <group position={[0, 1.14, 0]} rotation={[0.16, 0, 0]}>
        <mesh castShadow>
          <boxGeometry args={[1.1, 0.05, 0.92]} />
          <meshStandardMaterial color={spec.awning} roughness={0.66} />
        </mesh>
      </group>
    </group>
  )
}

/* ── the things that are alive ────────────────────────────────────────── */

const FLEET_LOOPS: [number, number, number, number][] = [
  [-9, -9, 3, 3],
  [-3, -3, 9, 9],
  [-15, 3, -3, 15],
  [3, -15, 15, -3],
  [-15, -15, 9, 9],
]

function loopPoint(loop: [number, number, number, number], t: number, out: Vector3) {
  const [x0, z0, x1, z1] = loop
  const w = x1 - x0
  const d = z1 - z0
  const perimeter = 2 * (w + d)
  let along = ((t % 1) + 1) % 1
  along *= perimeter
  if (along < w) out.set(x0 + along, 0, z0)
  else if (along < w + d) out.set(x1, 0, z0 + (along - w))
  else if (along < 2 * w + d) out.set(x1 - (along - w - d), 0, z1)
  else out.set(x0, 0, z1 - (along - 2 * w - d))
  return out
}

interface FleetUnit {
  loop: number
  phase: number
  speed: number
  /** Sideways offset from the street centre line, so two directions coexist. */
  lane: number
}

/**
 * Vehicles that actually drive. The delivery rovers are the agents at work —
 * KayKit's spacetruck with a parcel on the bed, doing their rounds whether or
 * not anyone is watching. The cars are through-traffic, Infinitown's oldest
 * source of life. Both are the same instanced-kit machinery as the buildings;
 * only their matrices move.
 */
function KitFleet({
  path,
  target,
  units,
  reducedMotion,
  reverse = false,
  y = 0,
}: {
  path: string
  target: number
  units: FleetUnit[]
  reducedMotion: boolean
  reverse?: boolean
  y?: number
}) {
  const parts = useKitParts(path, target)
  const meshes = useRef<(InstancedMesh | null)[]>([])
  const dummy = useMemo(() => new Object3D(), [])
  const position = useMemo(() => new Vector3(), [])
  const ahead = useMemo(() => new Vector3(), [])

  useFrame((state) => {
    const time = reducedMotion ? 0 : state.clock.elapsedTime
    for (const mesh of meshes.current) {
      if (!mesh) continue
      units.forEach((unit, index) => {
        const loop = FLEET_LOOPS[unit.loop]
        if (!loop) return
        const direction = reverse ? -1 : 1
        const t = unit.phase + time * unit.speed * direction
        loopPoint(loop, t, position)
        loopPoint(loop, t + 0.004 * direction, ahead)
        // The lane offset is perpendicular to the direction of travel.
        const dx = ahead.x - position.x
        const dz = ahead.z - position.z
        const length = Math.hypot(dx, dz) || 1
        dummy.position.set(
          position.x + (-dz / length) * unit.lane,
          y,
          position.z + (dx / length) * unit.lane,
        )
        dummy.lookAt(dummy.position.x + dx, y, dummy.position.z + dz)
        dummy.scale.setScalar(1)
        dummy.updateMatrix()
        mesh.setMatrixAt(index, dummy.matrix)
      })
      mesh.instanceMatrix.needsUpdate = true
    }
  })

  if (units.length === 0) return null
  return (
    <group>
      {parts.map((part, index) => (
        <instancedMesh
          key={`${path}-fleet-${String(index)}`}
          ref={(mesh) => {
            meshes.current[index] = mesh
          }}
          args={[part.geometry, part.material, units.length]}
          castShadow
          receiveShadow
        />
      ))}
    </group>
  )
}

const ROVERS: FleetUnit[] = [0, 1, 2, 3].flatMap((loop) =>
  Array.from({ length: 3 }, (_, i) => ({
    loop,
    phase: i / 3 + loop * 0.07,
    speed: 0.011 + (i % 3) * 0.002,
    lane: 0.38,
  })),
)

const TRAFFIC: FleetUnit[] = [2, 3, 4].flatMap((loop, which) =>
  Array.from({ length: 2 }, (_, i) => ({
    loop,
    phase: i / 2 + which * 0.13,
    speed: 0.02 + (i % 2) * 0.004,
    lane: 0.38,
  })),
)

const CLOUDS: { x: number; z: number; y: number; scale: number; speed: number }[] = [
  { x: -30, z: -12, y: 15.5, scale: 1.35, speed: 0.16 },
  { x: -16, z: 14, y: 17, scale: 1.7, speed: 0.11 },
  { x: 12, z: -16, y: 16, scale: 1.15, speed: 0.19 },
  { x: 22, z: 5, y: 16.5, scale: 1.5, speed: 0.13 },
]

/**
 * Clouds exist for their shadows. A soft patch of shade sliding over the roofs
 * is most of what makes the town read as a place with weather rather than a
 * render — Infinitown's oldest trick, and its best one.
 */
function Clouds({ reducedMotion }: { reducedMotion: boolean }) {
  const group = useRef<Group>(null)

  useFrame((_, delta) => {
    if (!group.current || reducedMotion) return
    group.current.children.forEach((cloud, index) => {
      const spec = CLOUDS[index]
      if (!spec) return
      cloud.position.x += spec.speed * delta
      if (cloud.position.x > 30) cloud.position.x = -30
    })
  })

  return (
    <group ref={group}>
      {CLOUDS.map((cloud) => (
        <group
          key={`${cloud.z}-${cloud.scale}`}
          position={[cloud.x, cloud.y, cloud.z]}
          scale={cloud.scale}
        >
          {[
            [0, 0, 0, 1],
            [0.85, 0.08, 0.2, 0.72],
            [-0.8, 0.05, -0.15, 0.65],
            [0.2, 0.12, -0.5, 0.55],
          ].map(([x, y, z, s]) => (
            <mesh key={`${x}-${z}`} position={[x ?? 0, y ?? 0, z ?? 0]} scale={s ?? 1} castShadow>
              <sphereGeometry args={[0.9, 7, 5]} />
              <meshStandardMaterial color={PALETTE.cloud} roughness={1} flatShading />
            </mesh>
          ))}
        </group>
      ))}
    </group>
  )
}

/* ── the real agents ──────────────────────────────────────────────────── */

/**
 * The measured agents own a quarter of town: the tall paper buildings with the
 * orange caps, and the only thing here you can touch. Selection is shown with
 * ink — a ring on the pavement — because glow is a promise and a ring is just
 * a fact.
 */
function AgentBuilding({
  agent,
  lot,
  selected,
  onSelect,
}: {
  agent: LandingAgentNode
  lot: { x: number; z: number; rotation: number }
  selected: boolean
  onSelect: (agent: LandingAgentNode) => void
}) {
  const height = 2.1 + Math.min(agent.proof.sampleSize, 8) * 0.12
  const live = agent.liveness === 'LIVE'

  return (
    <group position={[lot.x, 0, lot.z]} rotation={[0, lot.rotation, 0]}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: r3f meshes are not DOM */}
      <group
        onClick={(event) => {
          event.stopPropagation()
          onSelect(agent)
        }}
        onPointerEnter={(event) => {
          event.stopPropagation()
          document.body.style.cursor = 'pointer'
        }}
        onPointerLeave={() => {
          document.body.style.cursor = ''
        }}
      >
        <mesh position={[0, 0.017, 0]} receiveShadow>
          <boxGeometry args={[1.9, 0.014, 1.9]} />
          <meshStandardMaterial color="#dce3f4" roughness={1} />
        </mesh>
        <mesh position={[0, height / 2 + 0.01, 0]} castShadow receiveShadow>
          <boxGeometry args={[1.62, height, 1.62]} />
          <meshStandardMaterial color={PALETTE.paper} roughness={0.86} />
        </mesh>
        <mesh position={[0, height + 0.05, 0]} castShadow>
          <boxGeometry args={[1.76, 0.1, 1.76]} />
          <meshStandardMaterial color={live ? PALETTE.orange : PALETTE.quiet} roughness={0.58} />
        </mesh>
        {Array.from({ length: Math.floor(height / 0.92) }, (_, i) => (
          <mesh key={`band-${String(i)}`} position={[0, 0.86 + i * 0.92, 0.83]}>
            <boxGeometry args={[1.28, 0.3, 0.04]} />
            <meshStandardMaterial color={PALETTE.ink} roughness={0.26} metalness={0.04} />
          </mesh>
        ))}
        <mesh position={[0, 0.38, 0.84]}>
          <boxGeometry args={[0.56, 0.74, 0.05]} />
          <meshStandardMaterial color={PALETTE.ink} roughness={0.38} metalness={0.06} />
        </mesh>
        <group position={[0, 0.95, 1.02]} rotation={[0.34, 0, 0]}>
          <mesh castShadow>
            <boxGeometry args={[1.18, 0.05, 0.52]} />
            <meshStandardMaterial color={live ? PALETTE.yellow : PALETTE.bone} roughness={0.62} />
          </mesh>
        </group>
      </group>
      {selected && (
        <mesh position={[0, 0.035, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[1.34, 1.48, 40]} />
          <meshBasicMaterial color={PALETTE.ink} />
        </mesh>
      )}
    </group>
  )
}

/* ── light, air, camera ───────────────────────────────────────────────── */

const LIGHTING = {
  key: [2.75, 2.92, 3.08, 2.88, 2.78, 2.62, 2.82],
  hemisphere: [1.24, 1.34, 1.22, 1.28, 1.2, 1.16, 1.3],
  cyanFill: [0.22, 0.44, 0.58, 0.3, 0.48, 0.18, 0.36],
  orangeRim: [0.32, 0.28, 0.34, 0.5, 0.42, 0.24, 0.35],
} as const

function chapterValue(values: readonly number[], progress: number) {
  const scaled = MathUtils.clamp(progress, 0, 1) * (values.length - 1)
  const index = Math.min(Math.floor(scaled), values.length - 2)
  const blend = MathUtils.smoothstep(scaled - index, 0, 1)
  return MathUtils.lerp(values[index] ?? 0, values[index + 1] ?? values[index] ?? 0, blend)
}

function Sky({
  progress,
  exploreMode,
  reducedMotion,
}: {
  progress: MotionValue<number>
  exploreMode: boolean
  reducedMotion: boolean
}) {
  const hemisphere = useRef<HemisphereLight>(null)
  const key = useRef<DirectionalLight>(null)
  const cyanFill = useRef<DirectionalLight>(null)
  const orangeRim = useRef<DirectionalLight>(null)

  useFrame(() => {
    let p = exploreMode ? 1 : MathUtils.clamp(progress.get(), 0, 1)
    if (reducedMotion) p = Math.round(p * 6) / 6
    if (hemisphere.current) hemisphere.current.intensity = chapterValue(LIGHTING.hemisphere, p)
    if (key.current) key.current.intensity = chapterValue(LIGHTING.key, p)
    if (cyanFill.current) cyanFill.current.intensity = chapterValue(LIGHTING.cyanFill, p)
    if (orangeRim.current) orangeRim.current.intensity = chapterValue(LIGHTING.orangeRim, p)
  })

  return (
    <>
      <color attach="background" args={[CANVAS]} />
      <fog attach="fog" args={[CANVAS, 34, 72]} />
      <hemisphereLight ref={hemisphere} args={['#ffffff', '#c9d7ff', 1.24]} />
      <directionalLight
        ref={key}
        castShadow
        position={[24, 31, -16]}
        intensity={2.75}
        color="#ffffff"
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-near={4}
        shadow-camera-far={78}
        shadow-camera-left={-24}
        shadow-camera-right={24}
        shadow-camera-top={24}
        shadow-camera-bottom={-24}
        shadow-bias={-0.00025}
        shadow-normalBias={0.018}
      />
      <directionalLight
        ref={cyanFill}
        position={[-20, 13, 19]}
        intensity={0.22}
        color={PALETTE.cyan}
      />
      <directionalLight
        ref={orangeRim}
        position={[15, 9, 24]}
        intensity={0.32}
        color={PALETTE.orange}
      />
    </>
  )
}

interface AuthoredCameraPose {
  target: Vec3
  distance: number
  elevation: number
  yaw: number
  fov: number
  fogNear: number
  fogFar: number
  fogColor: string
}

/**
 * Seven deliberate shots. Angles are world-space degrees. The opening yaw is
 * 45 degrees; every value below stays inside the approved tuning ranges.
 */
const CAMERA_POSES: readonly AuthoredCameraPose[] = [
  {
    target: [0.4, 0.5, 0.8],
    distance: 42,
    elevation: 48,
    yaw: 45,
    fov: 36,
    fogNear: 34,
    fogFar: 72,
    fogColor: '#f4f6ff',
  },
  {
    target: [-5.4, 0.72, 4.8],
    distance: 31,
    elevation: 37,
    yaw: 69,
    fov: 38,
    fogNear: 24,
    fogFar: 58,
    fogColor: '#efffe8',
  },
  {
    target: [5.8, 0.75, -4.6],
    distance: 26,
    elevation: 31,
    yaw: 21,
    fov: 33,
    fogNear: 20,
    fogFar: 51,
    fogColor: '#eafaff',
  },
  {
    target: [7.4, 0.7, -7.2],
    distance: 22,
    elevation: 28,
    yaw: 79,
    fov: 30,
    fogNear: 17,
    fogFar: 45,
    fogColor: '#f1ecff',
  },
  {
    target: [-3.2, 0.68, 6.2],
    distance: 20,
    elevation: 25,
    yaw: 7,
    fov: 34,
    fogNear: 15,
    fogFar: 40,
    fogColor: '#ecfff8',
  },
  {
    target: [1.2, 0.22, -3.8],
    distance: 34,
    elevation: 58,
    yaw: 53,
    fov: 31,
    fogNear: 29,
    fogFar: 68,
    fogColor: '#f4f6ff',
  },
  {
    target: [0, 0.4, -2],
    distance: 52,
    elevation: 50,
    yaw: 33,
    fov: 39,
    fogNear: 44,
    fogFar: 92,
    fogColor: '#eafaff',
  },
] as const

const MARKET_CAMERA: AuthoredCameraPose = CAMERA_POSES[0] as AuthoredCameraPose
const EXPLORE_CAMERA: AuthoredCameraPose = CAMERA_POSES[6] as AuthoredCameraPose
const FOG_COLORS = CAMERA_POSES.map((pose) => new Color(pose.fogColor))
const MARKET_FOG = new Color(MARKET_CAMERA.fogColor)

interface ResolvedCameraPose {
  position: Vector3
  target: Vector3
  fogColor: Color
  fov: number
  fogNear: number
  fogFar: number
}

function resolveCameraPose(progress: number, distanceScale: number, out: ResolvedCameraPose) {
  const scaled = MathUtils.clamp(progress, 0, 1) * (CAMERA_POSES.length - 1)
  const index = Math.min(Math.floor(scaled), CAMERA_POSES.length - 2)
  const rawBlend = scaled - index
  const blend = MathUtils.smoothstep(rawBlend, 0, 1)
  const from = CAMERA_POSES[index] ?? MARKET_CAMERA
  const to = CAMERA_POSES[index + 1] ?? from

  out.target.set(
    MathUtils.lerp(from.target[0], to.target[0], blend),
    MathUtils.lerp(from.target[1], to.target[1], blend),
    MathUtils.lerp(from.target[2], to.target[2], blend),
  )

  const distance = MathUtils.lerp(from.distance, to.distance, blend) * distanceScale
  const elevation = MathUtils.degToRad(MathUtils.lerp(from.elevation, to.elevation, blend))
  const yaw = MathUtils.degToRad(MathUtils.lerp(from.yaw, to.yaw, blend))
  const horizontalDistance = Math.cos(elevation) * distance

  out.position.set(
    out.target.x + Math.sin(yaw) * horizontalDistance,
    out.target.y + Math.sin(elevation) * distance,
    out.target.z + Math.cos(yaw) * horizontalDistance,
  )
  out.fov = MathUtils.lerp(from.fov, to.fov, blend)
  out.fogNear = MathUtils.lerp(from.fogNear, to.fogNear, blend) * distanceScale
  out.fogFar = MathUtils.lerp(from.fogFar, to.fogFar, blend) * distanceScale
  out.fogColor.lerpColors(
    FOG_COLORS[index] ?? MARKET_FOG,
    FOG_COLORS[index + 1] ?? MARKET_FOG,
    blend,
  )
}

function setPerspective(camera: PerspectiveCamera, fov: number) {
  if (Math.abs(camera.fov - fov) < 0.01) return
  camera.fov = fov
  camera.updateProjectionMatrix()
}

function setFog(scene: Scene, pose: ResolvedCameraPose) {
  if (!scene.fog || !('near' in scene.fog)) return
  scene.fog.near = pose.fogNear
  scene.fog.far = pose.fogFar
  scene.fog.color.copy(pose.fogColor)
  if (scene.background instanceof Color) scene.background.copy(pose.fogColor)
}

const SPRING_STIFFNESS = 150
const SPRING_DAMPING = 23
const EXPLORE_TRANSITION_LIMIT_MS = 800

function springVector(
  value: Vector3,
  destination: Vector3,
  velocity: Vector3,
  delta: number,
  acceleration: Vector3,
) {
  const step = Math.min(delta, 1 / 30)
  acceleration
    .copy(destination)
    .sub(value)
    .multiplyScalar(SPRING_STIFFNESS * step)
  velocity.add(acceleration).multiplyScalar(Math.exp(-SPRING_DAMPING * step))
  value.addScaledVector(velocity, step)
}

type CameraPhase = 'narrative' | 'entering' | 'explore' | 'exiting'

function CameraDirector({
  progress,
  exploreMode,
  exploreResetKey,
  reducedMotion,
}: {
  progress: MotionValue<number>
  exploreMode: boolean
  exploreResetKey?: number | undefined
  reducedMotion: boolean
}) {
  const { camera, scene, size } = useThree()
  const controls = useRef<ElementRef<typeof OrbitControls>>(null)
  const currentTarget = useRef(new Vector3(...MARKET_CAMERA.target))
  const positionVelocity = useRef(new Vector3())
  const targetVelocity = useRef(new Vector3())
  const acceleration = useRef(new Vector3())
  const fovVelocity = useRef(0)
  const phase = useRef<CameraPhase>(exploreMode ? 'entering' : 'narrative')
  const transitionStarted = useRef(0)
  const mounted = useRef(false)
  const previousExploreMode = useRef(exploreMode)
  const previousResetKey = useRef(exploreResetKey)
  const [controlsReady, setControlsReady] = useState(false)
  const narrativePose = useMemo<ResolvedCameraPose>(
    () => ({
      position: new Vector3(),
      target: new Vector3(),
      fogColor: new Color(CANVAS),
      fov: MARKET_CAMERA.fov,
      fogNear: MARKET_CAMERA.fogNear,
      fogFar: MARKET_CAMERA.fogFar,
    }),
    [],
  )
  const explorePose = useMemo<ResolvedCameraPose>(() => {
    const resolved = {
      position: new Vector3(),
      target: new Vector3(),
      fogColor: new Color(CANVAS),
      fov: EXPLORE_CAMERA.fov,
      fogNear: EXPLORE_CAMERA.fogNear,
      fogFar: EXPLORE_CAMERA.fogFar,
    }
    resolveCameraPose(1, 1, resolved)
    return resolved
  }, [])
  const transitionFog = useMemo<ResolvedCameraPose>(
    () => ({
      position: new Vector3(),
      target: new Vector3(),
      fogColor: new Color(CANVAS),
      fov: MARKET_CAMERA.fov,
      fogNear: MARKET_CAMERA.fogNear,
      fogFar: MARKET_CAMERA.fogFar,
    }),
    [],
  )

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      if (exploreMode) {
        phase.current = 'entering'
        transitionStarted.current = performance.now()
      }
      return
    }

    const modeChanged = previousExploreMode.current !== exploreMode
    const resetRequested = previousResetKey.current !== exploreResetKey
    previousExploreMode.current = exploreMode
    previousResetKey.current = exploreResetKey
    if (!modeChanged && !(exploreMode && resetRequested)) return

    phase.current = exploreMode ? 'entering' : 'exiting'
    transitionStarted.current = performance.now()
    positionVelocity.current.set(0, 0, 0)
    targetVelocity.current.set(0, 0, 0)
    fovVelocity.current = 0
    if (exploreMode) {
      explorePose.fogNear = EXPLORE_CAMERA.fogNear
      explorePose.fogFar = EXPLORE_CAMERA.fogFar
      explorePose.fogColor.set(EXPLORE_CAMERA.fogColor)
    }
    if (controls.current && (!exploreMode || resetRequested)) {
      currentTarget.current.copy(controls.current.target)
    }
    setControlsReady(false)
  }, [exploreMode, exploreResetKey, explorePose])

  useFrame((_, delta) => {
    if (!(camera instanceof PerspectiveCamera)) return

    let p = MathUtils.clamp(progress.get(), 0, 1)
    if (reducedMotion) p = Math.round(p * (CAMERA_POSES.length - 1)) / (CAMERA_POSES.length - 1)
    const distanceScale = size.width < 720 ? 1.16 : size.width < 1180 ? 1.08 : 1
    resolveCameraPose(p, distanceScale, narrativePose)
    if (phase.current === 'entering') resolveCameraPose(1, distanceScale, explorePose)

    if (phase.current === 'narrative') {
      camera.position.copy(narrativePose.position)
      currentTarget.current.copy(narrativePose.target)
      setPerspective(camera, narrativePose.fov)
      setFog(scene, narrativePose)
      camera.lookAt(currentTarget.current)
      return
    }

    if (phase.current === 'explore') {
      const orbitalDistance = controls.current
        ? camera.position.distanceTo(controls.current.target)
        : EXPLORE_CAMERA.distance
      const zoom = MathUtils.clamp((orbitalDistance - 18) / (62 - 18), 0, 1)
      explorePose.fogNear = MathUtils.lerp(16, EXPLORE_CAMERA.fogNear, zoom)
      explorePose.fogFar = MathUtils.lerp(48, EXPLORE_CAMERA.fogFar, zoom)
      setFog(scene, explorePose)
      return
    }

    const destination = phase.current === 'entering' ? explorePose : narrativePose
    const elapsed = performance.now() - transitionStarted.current

    if (reducedMotion) {
      camera.position.copy(destination.position)
      currentTarget.current.copy(destination.target)
      setPerspective(camera, destination.fov)
    } else {
      springVector(
        camera.position,
        destination.position,
        positionVelocity.current,
        delta,
        acceleration.current,
      )
      springVector(
        currentTarget.current,
        destination.target,
        targetVelocity.current,
        delta,
        acceleration.current,
      )
      const step = Math.min(delta, 1 / 30)
      const fovAcceleration = (destination.fov - camera.fov) * SPRING_STIFFNESS
      fovVelocity.current =
        (fovVelocity.current + fovAcceleration * step) * Math.exp(-SPRING_DAMPING * step)
      setPerspective(camera, camera.fov + fovVelocity.current * step)
    }

    camera.lookAt(currentTarget.current)
    if (controls.current) controls.current.target.copy(currentTarget.current)

    transitionFog.fogNear = MathUtils.damp(
      scene.fog && 'near' in scene.fog ? scene.fog.near : destination.fogNear,
      destination.fogNear,
      9,
      delta,
    )
    transitionFog.fogFar = MathUtils.damp(
      scene.fog && 'far' in scene.fog ? scene.fog.far : destination.fogFar,
      destination.fogFar,
      9,
      delta,
    )
    transitionFog.fogColor.copy(
      scene.fog && 'color' in scene.fog ? scene.fog.color : destination.fogColor,
    )
    transitionFog.fogColor.lerp(destination.fogColor, 1 - Math.exp(-9 * delta))
    setFog(scene, transitionFog)

    const settled =
      camera.position.distanceTo(destination.position) < 0.06 &&
      currentTarget.current.distanceTo(destination.target) < 0.035 &&
      Math.abs(camera.fov - destination.fov) < 0.05

    if (!settled && elapsed < EXPLORE_TRANSITION_LIMIT_MS && !reducedMotion) return

    camera.position.copy(destination.position)
    currentTarget.current.copy(destination.target)
    setPerspective(camera, destination.fov)
    setFog(scene, destination)
    camera.lookAt(currentTarget.current)
    positionVelocity.current.set(0, 0, 0)
    targetVelocity.current.set(0, 0, 0)
    fovVelocity.current = 0

    if (phase.current === 'entering') {
      phase.current = 'explore'
      if (controls.current) {
        controls.current.target.copy(destination.target)
        controls.current.update()
      }
      setControlsReady(true)
    } else {
      phase.current = 'narrative'
    }
  })

  return (
    <OrbitControls
      ref={controls}
      enabled={exploreMode && controlsReady}
      target={[0, 0.4, -2]}
      minDistance={18}
      maxDistance={62}
      minPolarAngle={0.55}
      maxPolarAngle={1.2}
      enablePan={false}
      rotateSpeed={0.5}
      zoomSpeed={0.72}
      enableDamping
      dampingFactor={0.075}
      keyEvents={false}
    />
  )
}

/* ── the world ────────────────────────────────────────────────────────── */

const CAR_MODELS = [PROP.sedan, PROP.hatchback, PROP.wagon] as const

export function MarketWorld({
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
  const town = useMemo(() => planTown(aggregate.answeringAgents), [aggregate.answeringAgents])

  return (
    <>
      <Sky progress={progress} exploreMode={exploreMode} reducedMotion={reducedMotion} />
      <Ground plinths={town.plinths} />
      {BUILDING_KINDS.map((path, kind) => (
        <KitInstances
          key={path}
          path={path}
          target={1.95}
          placements={town.lotsByKind[kind] ?? []}
        />
      ))}
      <KitInstances path={PROP.bush} target={0.62} placements={town.bushes} />
      <KitInstances
        path={PROP.streetlight}
        target={1.9}
        mode="max"
        placements={town.streetlights}
      />
      <KitInstances path={PROP.bench} target={0.72} placements={town.benches} />
      <KitInstances path={PROP.hydrant} target={0.34} mode="max" placements={town.hydrants} />
      <KitInstances path={PROP.dumpster} target={0.85} placements={town.dumpsters} />
      <KitInstances path={PROP.boxA} target={0.4} placements={town.crates} />
      {CAR_MODELS.map((path, model) => (
        <KitInstances
          key={path}
          path={path}
          target={1.15}
          placements={town.cars.filter((car) => car.model === model).map((car) => car.placement)}
        />
      ))}
      {town.stalls.map((spec) => (
        <Stall key={`${spec.x}-${spec.z}`} spec={spec} />
      ))}
      <KitFleet
        path={`${KIT}/spacetruck.gltf`}
        target={0.95}
        units={ROVERS}
        reducedMotion={reducedMotion}
      />
      <KitFleet
        path={PROP.hatchback}
        target={1.05}
        units={TRAFFIC}
        reducedMotion={reducedMotion}
        reverse
      />
      <Clouds reducedMotion={reducedMotion} />
      {agents.slice(0, town.agentLots.length).map((agent, index) => {
        const lot = town.agentLots[index]
        if (!lot) return null
        return (
          <AgentBuilding
            key={agent.id}
            agent={agent}
            lot={lot}
            selected={agent.id === selectedAgentId}
            onSelect={onSelectAgent}
          />
        )
      })}
      <CameraDirector
        progress={progress}
        exploreMode={exploreMode}
        exploreResetKey={exploreResetKey}
        reducedMotion={reducedMotion}
      />
    </>
  )
}

for (const path of BUILDING_KINDS) useGLTF.preload(path)
for (const path of Object.values(PROP)) useGLTF.preload(path)
useGLTF.preload(`${KIT}/spacetruck.gltf`)
