# AiKi Landing Narrative Redesign

Date: 2026-08-31

Status: Approved design, written specification awaiting review

## Purpose

The AiKi landing page should feel like a living agent market, not a conventional page with cards placed over a decorative 3D background. The existing low-poly city remains the foundation. The redesign will make the camera, city state, interface, copy, and interactions behave as one continuous story.

The experience must communicate three ideas in simple language:

1. AiKi finds agents that actually answer.
2. The user decides what an agent can spend.
3. AiKi records what the agent did.

## Goals

- Preserve and improve the existing 3D market city.
- Make desktop scrolling continuous, responsive, and cinematic.
- Give each chapter a clearly different camera composition and world event.
- Make the city brighter, sharper, and more recognizably AiKi.
- Keep text readable without washing out the entire scene.
- Place the market evidence readout in the top-right corner on large screens.
- Use meaningful microinteractions that change the world, not decorative motion.
- Keep the complete experience usable with keyboard navigation, touch, reduced motion, and screen readers.
- Preserve the real agent and evidence data already used by the landing page.

## Non-goals

- Rebuilding the landing in Unity.
- Replacing the current Next.js application or React Three Fiber scene.
- Copying Why Zero University's source, assets, visual identity, or exact interactions.
- Adding bloom, depth of field, or other heavy effects before composition and material clarity are fixed.
- Turning every chapter into a mandatory interaction.
- Changing product routes or the application experience beyond fixes required by the landing page.

## Experience model

### Desktop

Desktop uses a controlled narrative viewport. Wheel, trackpad, chapter navigation, and supported keyboard input update one target progress value. Every delta is accumulated. Input is never dropped because an animation is busy.

A rendered progress value follows the target with interruptible spring physics. Camera position, camera target, field of view, scene color, lighting, fog, world events, story copy, the ruler, and interaction gates all read this same value. There is no second camera smoothing layer.

When input becomes idle, progress may settle gently toward the nearest story beat. Settling must remain interruptible. The user can reverse direction at any time.

### Mobile and coarse pointers

Mobile uses native vertical scrolling with sections sized by content and `min-height: 100dvh`. Native scroll progress feeds the same story model used on desktop. The page does not globally prevent touch movement. Nested content remains reachable, browser navigation gestures remain available, and iOS viewport changes do not hide controls.

### Reduced motion

Reduced-motion mode uses native scrolling and immediate chapter changes. The scene uses stable camera poses rather than continuous travel. Nonessential grain, traffic emphasis, camera drift, magnetic movement, and hold rituals are disabled. Every task remains available through a normal click or keyboard action.

### Input mode matrix

| Viewport and preference | Pointer | Wheel and trackpad | Touch | Keyboard |
| --- | --- | --- | --- | --- |
| At least 1180px wide and 640px tall, no reduced-motion preference | Fine | Controlled continuous progress | Native touch behavior | Controlled chapter and progress commands |
| Below 1180px wide or 640px tall | Any | Native document scroll | Native document scroll | Native document navigation |
| Any viewport with a coarse primary pointer | Coarse | Native document scroll | Native document scroll | Native document navigation |
| Any viewport with reduced motion | Any | Native document scroll | Native document scroll | Native document navigation |

Controlled mode is selected with media queries equivalent to `(min-width: 1180px) and (min-height: 640px) and (pointer: fine) and (prefers-reduced-motion: no-preference)`. A touchscreen attached to a fine-pointer desktop does not add a captured touch gesture. Touch remains native.

Native mode measures the start and end of every semantic chapter with `ResizeObserver`. The active segment is selected from the measured chapter boundaries, and local progress is calculated within that segment rather than from one global page-height ratio. Measurements refresh after font loading, resize, orientation change, content change, and browser chrome changes.

If the input mode changes while the page is open, the controller preserves the current chapter and local progress. Switching to native mode scrolls to the equivalent measured position before releasing control. Switching to controlled mode captures the equivalent progress before fixing the viewport. The transition does not reset the story or replay the opening entrance.

## Narrative controller

The narrative controller owns:

- Target progress from 0 to 1.
- Rendered progress from 0 to 1.
- Current chapter and local progress within that chapter.
- Input velocity and idle state.
- Active interaction gate.
- Explore-mode transition state.

It accepts normalized wheel, touch, keyboard, and navigation-button commands. It ignores global navigation shortcuts when focus is inside a link, button, input, select, textarea, contenteditable element, dialog, or other interactive control.

The controller exposes one read-only progress interface to React overlays and the Three.js scene. Story components must not create independent scroll springs or call `scrollIntoView` behind the controller's back.

In controlled mode, ArrowDown, PageDown, and Space move forward; ArrowUp, PageUp, and Shift+Space move backward; Home and End target the first and last unlocked chapter. These keys are handled only when focus is on the story root or document body. Ruler navigation uses standard button activation.

Every settled chapter updates the URL hash with `history.replaceState`. Deliberate ruler jumps use `pushState`. Back and forward navigation restore the chapter from the hash. Reloading a valid chapter hash starts at that chapter after scene readiness. Invalid hashes fall back to the market.

All chapter headings and copy remain in semantic DOM order in controlled mode. Visual opacity does not remove them from the accessibility tree. Interactive controls in inactive chapters are removed from the tab order, and focusing a control in another chapter updates progress to that chapter before focus is shown. A focusable `Use standard scrolling` control near the skip link switches the current session to native mode. Browser Find can discover chapter copy because it is not rendered with `display: none`, `visibility: hidden`, or `aria-hidden`.

## Story chapters

### 00. The market

Copy:

- Eyebrow: `The agent market on BNB Chain`
- Headline: `Put agents to work.`
- Supporting copy: `Find one that answers. Set what it can spend. See every move.`

Visual direction:

- Begin with a bright aerial view of the market square.
- Compose an intentionally quiet area behind the headline.
- Keep the AiKi mark top-left, unframed.
- Show the market evidence instrument top-right on desktop.
- The city is already active, but motion remains calm enough for the opening copy to dominate.

Evidence instrument:

- Fallback state shows `20 Aug` with label `Swept`, `1,143` with label `Probed`, and `11` with label `Answered`.
- API state shows the returned probe and answer counts. When the API supplies a sweep timestamp, format it as `DD MMM`. When it has no timestamp, show `Latest` with label `Sweep` rather than claiming the data is live.
- Show the complete group within 600ms of the scene-ready signal or readiness timeout, whichever occurs first.
- Animate the connecting rail or state pulse after the values are readable.
- Preserve the fallback sweep date. Do not replace it with the word `live`.

### 01. The signal

Copy:

- Headline: `Many are listed.`
- Supporting copy: `A registry can tell you an agent exists. It cannot tell you the agent works.`

Visual direction:

- The camera descends toward the working streets.
- Agent buildings or stalls begin to emit small signal beacons.
- Quiet listings remain visible but visually secondary.
- The `1,143 probed` to `11 answered` difference becomes a spatial pattern in the city, not another large card.
- Aggregate signal fields are abstract market instrumentation. They do not imply one rendered building or light per probed agent.
- Only agent markers created from records in `market.agents` are selectable or labelled as individual agents. Abstract aggregate marks never expose an agent name, identifier, or evidence link.

### 02. The check

Copy:

- Headline: `A listing is not proof.`
- Supporting copy: `AiKi reaches the agent and checks the answer.`

Visual direction:

- A scan travels through the district.
- Silent endpoints desaturate.
- Valid answers retain saturated signal color.
- A compact two-step instrument labels `Reach it` and `Check the answer` without covering a large part of the world.

Signature interaction:

- Press and hold `Run the check` for 900ms.
- The city responds throughout the hold, not only after completion.
- The button captures the active pointer. Releasing early, pointer cancellation, window blur, page visibility loss, Escape, chapter navigation, or unmount cancels the hold and returns progress to zero with a 180ms spring.
- Completion produces one decisive pulse and unlocks forward progress. It does not automatically consume queued scroll input or advance another chapter. The next deliberate gesture continues the story.
- Keyboard activation and reduced-motion mode complete the action immediately.
- On a fine-pointer desktop, this is the single required story gate. Forward progress and future ruler targets clamp at the gate until completion. Backward progress and earlier ruler targets remain available. Mobile and reduced-motion modes present the same action as a normal tap, so no user is required to perform a hold gesture.
- Completion is held in session state until reload. Entering and exiting explore mode or switching input modes does not relock the gate.

### 03. The limit

Copy:

- Headline: `You set the limit.`
- Supporting copy: `Give the agent enough power for one job. Nothing more.`

Visual direction:

- The camera moves closer to one route through the city.
- A visible boundary forms around that route.
- The action, asset, and maximum appear as a compact market instrument rather than a large white card.

Interaction:

- A real range control sets the example limit from `0 USDT` to `25 USDT`, with a `1 USDT` step and a `25 USDT` default.
- Pointer drag, touch drag, Arrow keys, Home, and End work normally. PageUp and PageDown change the value by `5 USDT`.
- The route boundary responds continuously to the value.
- The displayed value is always visible beside the control and announced through its accessible value text.
- The value remains in React session state while the landing is open and resets on reload. It is illustrative and is never submitted to the API or wallet.
- The chapter does not block progress if the user chooses not to adjust it.

### 04. The work

Copy:

- Headline: `The agent works.`
- Supporting copy: `The job stays inside the limit. AiKi records each decision.`

Visual direction:

- The camera follows a courier or signal through `Task`, `Check`, and `Act`.
- The three stages exist in the world as route markers.
- The overlay is a small annotation that tracks the active stage.
- Camera movement includes visible parallax and a different bearing from the opening aerial shot.

### 05. The receipt

Copy:

- Headline: `You get the receipt.`
- Supporting copy: `See what was allowed, what happened onchain, and which limit held.`

Visual direction:

- The travelled route resolves into a clean ledger or receipt plane.
- The receipt remains crisp DOM content for accessibility and text clarity.
- The city frames the receipt instead of sitting behind a large generic card.
- Show only the evidence needed to close the story: policy, chain confirmation, and amount spent.

### 06. Explore

Copy:

- Headline: `See what answered.`
- Supporting copy: `Each bright point is an agent AiKi reached. Open the map and inspect the proof.`

Visual direction:

- Pull back to reveal the full measured market.
- Blend camera position and target into the explore pose before controls are enabled.
- Agent beacons become selectable.
- The registry remains available as a standard link.

Explore behavior:

- One standard click opens the map. The explore control does not combine click and hold recognition, so it cannot fire twice.
- Explore may be entered from the final chapter or the persistent dock in any earlier chapter. The controller stores the originating progress and opener before moving to the explore camera.
- The camera and target blend to the explore pose with an interruptible spring. Orbit controls remain disabled until position and target are within their settled thresholds, with an 800ms maximum transition.
- Orbit controls use damping, disable panning, limit zoom distance to 18 through 62 world units, and limit polar angle to 0.55 through 1.2 radians. Reset returns to the authored explore pose.
- Escape exits explore mode.
- Exiting restores the exact originating narrative progress and camera pose before returning focus to the opener.
- Focus moves to the exit control on entry and returns to the opener on exit.
- Selecting a real agent shows display name, answering or degraded state, agent identifier, successful checks over total checks, proof floor, and an `Open evidence` link. Aggregate marks are not selectable.
- Hover and focus reveal labels for icon-only controls.
- On touch, labels are always visible or revealed on the first tap without triggering a destructive action.

## Persistent action dock

The detached bottom dock remains the landing's stable action surface. It never covers chapter copy or a chapter interaction.

- Chapters 00 through 05: left icon button `Explore the map`, center text link `Open AiKi`, right icon link `Evidence registry`.
- Chapter 06: left icon link `Open AiKi`, center text button `Explore the map`, right icon link `Evidence registry`. The final overlay does not repeat the same actions in a second button row.
- Explore mode: left icon button `Reset view`, center text button `Exit map` with an `Esc` key hint, right icon link `Evidence registry`.

Desktop icon controls reveal a custom label after 300ms of hover and immediately on keyboard focus. Labels use `role="tooltip"` and are connected with `aria-describedby`. Touch controls keep their accessible names and use recognizable map, reset, and scan symbols without requiring a hover-only instruction.

Every control is at least 44 by 44 CSS pixels. The dock stays at least 16px plus `env(safe-area-inset-bottom)` above the viewport edge. Layout reserves the dock's full height in native-scroll chapters. At 200% text zoom, the center pill may grow vertically and the three controls may wrap into a compact two-row arrangement without horizontal overflow.

## Camera direction

Each chapter receives an authored camera pose with:

- Position.
- Look target.
- Field of view.
- Elevation and bearing.
- Subject offset within the viewport.
- Fog near and far values.
- Scene-lighting state.

The seven poses interpolate through a smooth curve, but intermediate motion must not erase the identity of each shot. Initial tuning targets are:

| Chapter | Distance | Elevation | FOV | Yaw from opening | Foreground subject | Reserved copy zone |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| Market | 40 to 44 | 45 to 50 degrees | 34 to 38 | 0 degrees | Market square | Center, x 26% to 74%, y 34% to 68% |
| Signal | 28 to 33 | 34 to 40 degrees | 36 to 40 | +18 to +28 degrees | Working streets and beacons | Left, x 6% to 39%, y 34% to 72% |
| Check | 23 to 28 | 28 to 34 degrees | 30 to 35 | -18 to -28 degrees | Scan lane and answer cluster | Right, x 60% to 94%, y 30% to 72% |
| Limit | 19 to 24 | 25 to 31 degrees | 28 to 33 | +28 to +38 degrees | Bounded route | Left, x 6% to 40%, y 34% to 72% |
| Work | 17 to 22 | 22 to 28 degrees | 31 to 36 | -32 to -42 degrees | Courier route | Right, x 60% to 94%, y 34% to 70% |
| Receipt | 31 to 37 | 54 to 62 degrees | 29 to 34 | +4 to +12 degrees | Completed route and ledger edge | Left, x 6% to 41%, y 25% to 77% |
| Explore | 47 to 55 | 46 to 54 degrees | 36 to 41 | -8 to -16 degrees | Whole measured market | Center, x 22% to 78%, y 23% to 77% |

Distance and angle values are tuning ranges, not runtime randomness. The implementation chooses one authored value inside each range. At least five of the six adjacent transitions must change yaw by 10 degrees or more, and every adjacent transition must change distance, elevation, or FOV enough to produce visible parallax.

At the center of each reserved copy zone, at least 70% of the headline bounding area must sit over road, plaza, sky, a local contrast mask, or another low-detail surface rather than high-frequency building geometry.

After tuning, save one approved 1280 by 720 reference capture for every chapter under `docs/design-references/landing/`. These seven captures become the visual-regression oracle for camera framing, subject placement, copy-zone clearance, and color balance.

The current fixed isometric bearing is removed from narrative mode. Explore mode may retain orbit controls after the final blend completes.

## Visual system

The landing remains warm and graphic, but it no longer uses one beige wash over every layer.

Core colors:

- Market cream: `#FFF8E7`
- Ink: `#11110E`
- AiKi orange: `#FF4F00`
- Signal yellow: `#FFD637`
- Market cyan: `#4FDBEA`
- Signal lime: `#CFFF47`
- Exceptional violet: `#735CFF`

Yellow and lime are signal colors, not body-text colors. Text and controls must meet WCAG AA contrast.

Typography continues to use the landing's Archivo and IBM Plex Mono pairing. Headlines remain direct and large. Instrument labels remain compact, but meaningful text does not fall below 12px and body copy targets at least 16px.

The scene uses bright district accents, differentiated windows, roofs, vehicles, stalls, and beacons. White panels are reserved for the receipt and necessary readable instruments. Major surfaces use concentric radii and subtle inner highlights rather than generic gray borders or heavy shadows.

## Rendering clarity and performance

The sharpness problem is treated as an art-direction and filtering issue before increasing resolution.

Required changes:

- Keep DPR 2 as the highest normal quality tier.
- Add adaptive quality tiers at DPR 1, 1.5, and 2 based on sustained frame time.
- Set color-texture anisotropy to the supported device maximum, capped at 8.
- Remove the full-screen cream veil and replace it with chapter-specific local contrast masks.
- Set persistent grain to 4% opacity, and use stronger texture only in a chapter where it has narrative purpose.
- Restore material separation. Walls stay matte while windows, painted signs, roofs, vehicles, and signals use distinct roughness.
- Use a more neutral key light and controlled colored fill.
- Tighten shadow coverage around the active district.
- Replace deprecated soft-shadow configuration.
- Avoid expensive bloom, depth of field, and global sharpen passes in the first implementation.
- Keep meaningful text in DOM layers outside the WebGL post-processing path.

Quality uses a rolling frame-time window. A tier downgrades after 60 rendered frames average more than 20ms. A tier upgrades only after 180 rendered frames average less than 14ms. Quality changes one tier at a time and waits at least five seconds before another change. Reduced-motion mode starts at the middle tier and may idle the render loop when the scene is static.

The initial hero waits for one explicit scene-ready signal before completing its copy entrance. Scene-ready means the renderer has created its first valid frame, critical opening-shot models and textures have loaded, and asynchronous shader compilation has resolved where supported. One loader owns both JavaScript and scene readiness, so the page cannot flash from a loader to an empty cream canvas.

Server-rendered headline, supporting copy, primary links, and the static fallback remain available before WebGL loads. A 2.5-second timeout dismisses the loader and reveals the static editorial fallback if scene-ready has not arrived. A WebGL error before or after the timeout keeps the static story active and exposes a `Retry 3D view` button. Retrying creates a new canvas once and never blocks the story copy.

## Component boundaries

The redesign should split the current large landing implementation into focused units:

- `NarrativeController`: input normalization, target progress, rendered progress, chapter state, and snapping.
- `CameraDirector`: camera-pose interpolation, target, FOV, fog, and explore blending.
- `MarketWorld`: city geometry and world actors, driven by chapter state rather than page layout.
- `WorldEvents`: beacons, scan, route boundary, courier path, and receipt transition.
- `StoryOverlay`: chapter copy and compact scene annotations.
- `MarketTelemetry`: the desktop top-right evidence instrument and its mobile equivalent.
- `InteractionGate`: shared pointer, keyboard, cancellation, progress, and reduced-motion behavior.
- `ExploreControls`: entry, exit, labels, focus management, and agent selection.
- `QualityManager`: DPR, shadow, motion, and effect tiers based on frame time and user preference.

Each unit consumes explicit state and exposes a small interface. No component creates a competing scroll or camera timeline.

## Data and failure states

The page continues to request aggregate stats and answering-agent data from the existing landing data hook.

- Loading: show the deterministic fallback city and reserve telemetry dimensions to prevent layout shift.
- API success: update values and agent beacons without replaying the entire entrance.
- API failure: keep honest fixture-backed fallback values and mark the source as `Sample market data` in accessible supporting text and inside any selected fixture-agent detail, not a large warning banner.
- Empty answering set: preserve the market and explain that no agents answered the latest sweep, with a registry link.
- Scene failure or WebGL unavailable: render the full story as a bright static editorial experience with working navigation and links.
- Local development: configure the mock API CORS policy so credentialed requests from the web origin succeed.

Abstract aggregate marks visualize market scale but are never selectable. Only records in `market.agents` create selectable markers. API-backed records are labelled as measured agents. Fixture-backed records are labelled as sample evidence. Neither state invents one marker per probed agent.

## Accessibility

- All controls use real `button`, `a`, or form elements.
- All interactive controls have visible focus treatment.
- Touch targets are at least 44 by 44 CSS pixels, including visually thin ruler ticks.
- Space and Enter activate focused controls instead of navigating the story.
- The story controller does not intercept input from interactive elements or native-scroll regions.
- Chapter navigation communicates the current step with `aria-current`.
- Decorative 3D content remains hidden from the accessibility tree.
- Agent data exposed through the map is also available through labelled controls and the registry.
- No information depends on color alone.
- Pinch zoom remains enabled.
- Reduced-motion behavior preserves every task and route.

## Responsive behavior

### Large desktop, 1180px and wider

- Full controlled narrative.
- Evidence instrument fixed to the top-right safe area.
- Ruler centered at the top.
- Copy and instruments use shot-specific screen positions.
- Bottom action dock remains compact and detached from the viewport edge.

### Tablet, 721px to 1179px

- Native scrolling is used. Controlled narrative input is reserved for viewports at least 1180px wide with a fine pointer and no reduced-motion preference.
- Copy uses smaller local plates where the scene cannot provide a quiet zone.
- Evidence instrument condenses without losing any value.

### Mobile, 720px and below

- Native scrolling only.
- Readable light surfaces or fully inverted dark surfaces with matching text tokens.
- The evidence instrument becomes a compact three-value row.
- No content relies on internal hidden scrolling.
- The action dock respects safe-area insets and never covers chapter actions.
- Explore controls use labelled touch targets.

### Short viewports and zoom

- Viewports shorter than 640px use native scrolling regardless of width.
- Landscape phones use content-height sections and place the 3D scene behind a readable editorial flow rather than forcing a one-screen composition.
- At 200% browser text zoom, no chapter action, heading, telemetry value, or dock control is clipped or trapped inside an unreachable internal scroller.
- Browser chrome and safe-area changes trigger chapter remeasurement without moving the user to another chapter.
- No supported viewport produces horizontal document overflow.

## Verification and acceptance criteria

The implementation is complete when:

1. In controlled mode, ten synthetic wheel events with `deltaY: 3` increase target progress above zero while native `window.scrollY` remains unchanged.
2. During forward interpolation, a backward delta changes target direction in the same animation frame and rendered progress begins decreasing within 100ms. No controller state named or behaving as a noninterruptible busy lock exists.
3. All authored camera values fall inside the pose table ranges. At least five adjacent transitions change yaw by 10 degrees or more, and every transition changes distance, elevation, or FOV.
4. The seven 1280 by 720 reference captures are reviewed together and show the required foreground subject and reserved copy zone for each chapter.
5. Body text measures at least 4.5:1 contrast, large text and meaningful icons at least 3:1, and no headline, action, telemetry value, or ruler label overlaps high-frequency geometry without a specified local contrast surface.
6. In fallback state, `20 Aug`, `1,143 Probed`, and `11 Answered` appear in the top-right desktop instrument within 600ms of scene-ready or the 2.5-second readiness timeout. API state uses returned counts and the defined sweep-date fallback.
7. At 1280 by 720, chapters 01 through 04 do not use an overlay surface covering more than 28% of the viewport. Chapter 05 may use one receipt surface up to 40%. Chapter 06 does not duplicate the dock actions.
8. At 375 by 812, the check chapter headline, copy, and both check steps meet contrast requirements and remain fully visible above the dock.
9. In mobile and tablet modes, no document-level `touchmove` listener calls `preventDefault`, and a touch user can reach the final chapter and every chapter action through native scroll.
10. Reduced-motion mode does not install the controlled wheel handler, uses stable chapter camera poses, and exposes the check, limit, explore, registry, and app actions without hold gestures.
11. Keyboard users can traverse the ruler, story actions, map controls, agent selectors, standard-scroll control, and links in logical order. Space and Enter activate focused controls.
12. Escape exits explore mode, the exact originating progress is restored, and focus returns to the opener. Controls remain disabled until the explore camera blend settles or reaches its 800ms maximum.
13. The check hold completes at 900ms, cancels on every specified cancellation event, never applies queued forward input, and remains unlocked across explore and input-mode changes until reload.
14. The limit control reports a 0 to 25 range, 1-unit step, 25-unit default, 5-unit page increment, visible value, and matching accessible value text.
15. Every pointer target measures at least 44 by 44 CSS pixels, including ruler ticks, dock icons, map controls, and agent selectors.
16. The live mock API completes credentialed requests from the web origin without CORS errors, and aggregate marks remain nonselectable in both API and fallback states.
17. If WebGL never becomes ready, the static story appears within 2.5 seconds with working links and one functional `Retry 3D view` action.
18. Chapter hashes restore after reload and browser history navigation. `Use standard scrolling` preserves the current chapter when changing modes.
19. The page passes focused unit tests, web type checking, and the production build.
20. Browser QA captures 375 by 812, 768 by 1024, 812 by 375 landscape, 1280 by 720, 1366 by 640, 1440 by 900, and 200% text zoom. No capture contains clipped actions, dock collisions, trapped internal scrolling, or horizontal overflow.
21. On the current development Mac in current stable Chrome at 1280 by 720 with no throttling, the rolling average settles at or below 20ms per frame after adaptive quality selection, input produces no frame stall longer than 150ms, and tier changes follow the defined 60-frame downgrade and 180-frame upgrade thresholds.

## Rollout order

1. Introduce the single narrative controller with semantic DOM, keyboard handling, URL state, and standard-scroll escape hatch.
2. Author camera poses, explore blending, and focus restoration.
3. Correct palette, local contrast, texture filtering, materials, fog, and grain.
4. Recompose the seven overlays with responsive layout, contrast, focus, and touch-target requirements built in.
5. Build the probe and limit interactions with their pointer, keyboard, cancellation, and reduced-motion behavior together.
6. Complete native mobile, tablet, short-viewport, zoom, and reduced-motion modes.
7. Add adaptive quality and optimize repeated scene actors.
8. Fix local mock API CORS behavior and verify honest data-source labelling.
9. Run the final accessibility, visual-regression, performance, type-check, and production-build audit.
