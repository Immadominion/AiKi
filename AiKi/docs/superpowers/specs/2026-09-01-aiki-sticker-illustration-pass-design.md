# AiKi Landing Sticker Illustration Pass

## Goal

Add a coherent family of fun AiKi agent illustrations to the approved landing page and remove its beige cast without changing the page structure, copy, camera path, scroll behavior, section sizing, or existing interaction model.

## Illustration language

- Use the blue AiKi robot from the existing cover as the character identity.
- Render each asset as a playful editorial sticker: compact silhouette, expressive pose, bold dark outline, bright blue/cyan/lime/violet accents, and a thick white die-cut edge.
- Preserve genuine alpha transparency outside the sticker edge.
- Avoid embedded words, beige backgrounds, rectangular backplates, photorealism, generic humanoid robots, and orange color washes.
- Generate each scene separately so it remains legible at its final UI size.

## Asset set

1. `agent-scout`: a hovering AiKi scout used as the restrained general mascot accent.
2. `agent-scan`: the agent actively scanning an endpoint or signal.
3. `agent-verify`: the agent stamping a successful evidence check.
4. `agent-limit`: the agent fastening a safety lock around a token.
5. `agent-task`: the agent receiving a task capsule or clipboard.
6. `agent-check`: the agent inspecting the task with a scanner.
7. `agent-act`: the agent executing the approved action.
8. `agent-receipt`: the agent presenting a long machine receipt.
9. `human-agent-touch`: an original human and robot fingertip composition for the final call to action, inspired by the general connection motif rather than copied from an existing meme.

## Page integration

- Keep the hero visually dominant. If the scout is used there, it remains a small edge accent and never overlaps headline copy.
- Place the scout half inside and half outside the lower-right edge of the “Many are listed” panel.
- Replace the scanner and checkmark glyph containers in “A listing is not proof” with the scan and verify stickers. The row text and row geometry remain unchanged.
- Add the limit sticker as a restrained overlap on the limit ticket, outside the text columns.
- Replace the three numbered circles in “The agent works” with the task, check, and act stickers while preserving the three-column route and labels.
- Place the receipt sticker at the lower-right edge of the receipt panel without covering receipt values.
- Place the fingertip composition behind the final actions as a low-contrast decorative layer. Buttons remain fully legible and clickable.
- All decorative images use empty alt text and cannot receive pointer events.

## Color treatment

- Base background: crisp cool near-white instead of cream or beige.
- Raised surfaces: pure white.
- Primary ink: near-black.
- Primary accent: electric blue.
- Supporting accents: cyan, acid lime, violet, and a small coral highlight where needed.
- Semantic liveness colors retain distinct meanings and accessible contrast.
- Update the Three.js background, fog, light, and material palette at token/material level only. Preserve scene geometry, camera choreography, and world density.

## Responsive and performance constraints

- Use `next/image` with explicit dimensions and responsive `sizes` values.
- Decorative assets must not contribute to panel height or cause layout shift.
- Desktop assets may overlap panel edges; mobile assets scale down and move inward where necessary.
- On short screens, assets yield to copy and controls and may be reduced or selectively hidden if a collision cannot be avoided.
- Use only transform and opacity for any small ambient motion, and disable that motion under `prefers-reduced-motion`.
- Keep source PNGs optimized and let Next.js serve appropriately sized derivatives.

## Acceptance checks

- The page still advances one chapter at a time exactly as before.
- Existing camera transitions and explore mode are unchanged.
- No sticker obscures copy, controls, market data, or the chapter ruler at 375 px, 768 px, and 1280 px widths.
- The page no longer reads as beige or orange-washed.
- The characters unmistakably read as AiKi agents and form one consistent visual family.
- Typecheck and production build pass.
