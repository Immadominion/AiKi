# KayKit City Builder Bits selection

- Source: [KayKit-Game-Assets/KayKit-City-Builder-Bits-1.0](https://github.com/KayKit-Game-Assets/KayKit-City-Builder-Bits-1.0)
- Kit version: 1.0
- Retrieved: 2026-08-30
- Creator: Kay Lousberg (www.kaylousberg.com)
- License: [Creative Commons Zero 1.0](https://creativecommons.org/publicdomain/zero/1.0/) —
  "free to use in personal, educational and commercial projects". The original
  `LICENSE.txt` is retained in this directory. Credit is optional; we give it
  anyway, because that is cheap and true.

Why THIS kit and not the Infinitown repo Dominion found: that repo re-hosts
Little Workshop's code and VenCreations' commercial models with no license.
This kit is one coherent visual language, actually licensed, in the same
chunky low-poly register — laid out by our own Infinitown-style system
(grid, fog-as-composition, one sun, cloud shadows).

Selected files (each `.gltf` pairs with its `.bin`; all share
`citybits_texture.png`):

- `building_A_withoutBase` … `building_H_withoutBase` — the eight town buildings
- `bush` — all greenery, at varying scales
- `bench`, `streetlight`, `firehydrant`, `dumpster` — pavement detail
- `box_A`, `box_B` — market crates around the square
- `car_sedan`, `car_hatchback`, `car_stationwagon` — parked traffic
  (taxi and police deliberately not taken: wrong register for this town)

## Palette retheme

`citybits_texture.png` is OUR derivative of the kit's atlas, remapped to the
site's paper/ink/orange family (reds→clay, greens→sage, blues→slate, greys
warmed; value structure untouched so all baked detail survives). CC0 permits
derivatives. The untouched original and the script that reproduces the mapping live in
`AiKi/tools/landing-assets/`, NOT here: everything under `public/` is served on
the open web, and build tooling has no business being fetchable from the
marketing site.
