# MergeForge — AI asset-generation prompts

Ready-to-paste prompts for ChatGPT (image generation). Workflow: paste the **brand
brief** first, then the prompt for the asset you want, in the same message. Iterate
with the refinement follow-ups. Practical export steps are at the bottom.

---

## The brand brief (paste this before every prompt)

> You are designing brand assets for **MergeForge**, a developer tool. Here is the
> full context you need:
>
> **What it is:** a Visual Studio Code / Cursor extension that resolves git merge
> conflicts in a JetBrains-style three-pane editor — your code on the left, the
> incoming branch on the right, and the merged result being built in the center.
> An AI assistant that reads the repository can explain and resolve the conflicts.
>
> **The name's metaphor is the product's story:** a _forge_. Two branches of code —
> two pieces of hot metal — are hammered into one solid, stronger piece. Conflict
> goes in, one clean result comes out. The icon should own this metaphor.
>
> **Personality:** craftsmanship, precision, calm confidence. A blacksmith's
> controlled strike — not chaos, not fire spreading. Think "quietly excellent tool
> for professionals", never playful-cartoon or aggressive-gamer.
>
> **Palette (from the product UI — use these exact colors):**
>
> - Background tile: very dark blue-gray `#16171f` (subtle vignette allowed)
> - Conflict red `#c75450` (the incoming, unresolved metal)
> - Resolved green `#62b455` (the forged, finished result)
> - Steel blue `#4e79a7` (secondary/structural)
> - Spark amber `#f5a623` (tiny accent only — the strike moment)
>
> **Hard rules — follow all of them:**
>
> 1. Flat, geometric vector style. No photorealism, no 3D render, no texture noise.
> 2. No letters, no words, no numbers anywhere in the artwork.
> 3. One strong silhouette. The design must stay instantly recognizable when
>    scaled down to 32×32 pixels — if a detail would vanish at that size, omit it.
> 4. Gradients only as a subtle background vignette; all foreground shapes are
>    solid flat fills.
> 5. Generous padding: the mark occupies roughly the central 70% of the canvas.
> 6. No drop shadows, no glows except one small spark accent.

---

## Prompt 1 — Marketplace icon (the main asset)

> Design an app icon on a rounded-square dark tile (`#16171f`, corner radius about
> 17% of the width).
>
> **The mark:** the exact moment of a forge strike, reduced to geometry. Two
> git-branch lines — one conflict-red `#c75450`, one steel-blue `#4e79a7` — sweep
> in from the upper left and upper right and meet on a minimal anvil silhouette.
> Below the meeting point they continue as a **single thick resolved-green
> `#62b455` line** flowing downward. At the meeting point, one small amber spark
> (`#f5a623`) — a four-point star or three tiny triangles, nothing more.
>
> The anvil is the simplest possible read: one flat-topped trapezoid shape, dark
> steel gray, no horn detail, no stand. It can even be implied — a short horizontal
> bar the lines meet on. The branch lines are thick (about 1/9 of the canvas
> width), with rounded caps, and each carries one small commit-dot along its
> length like a git graph.
>
> Give me **three composition variants** at 1024×1024 PNG:
>
> 1. Symmetric: both lines entering at mirrored angles, spark centered.
> 2. Asymmetric: red line dominant from the left, blue joining from the right,
>    spark offset to the strike side.
> 3. Ultra-minimal: no anvil at all — just the two lines fusing into one green
>    line with the spark at the junction.
>
> Then tell me which variant _you_ judge most legible at 32×32 and why.

**Refinement follow-ups (use as needed, one at a time):**

- "Simplify further: remove the commit-dots and check it still reads as git branches."
- "The silhouette is muddy at small size — increase the line thickness by 30% and
  the contrast between the red/blue lines and the tile."
- "Make the spark half the size; it's stealing attention from the merge."
- "Flatten the anvil into a simple horizontal bar and try again."
- "Render the winning variant again at exactly 1024×1024 with the mark 10% smaller
  for more padding."

---

## Prompt 2 — GitHub social card (1280×640)

> Using the same mark we settled on for the icon, design a **1280×640 social
> preview card**.
>
> Layout: the mark on the left third (without its rounded-tile background — the
> lines and spark sit directly on the card). On the right two-thirds, leave clean
> negative space where I will typeset the wordmark myself — do NOT render any
> text. Background: the dark `#16171f` with a very subtle radial vignette
> brightening slightly behind the mark, and a faint, almost invisible echo of
> three vertical panels across the full card (5% opacity) as a nod to the
> three-pane editor.
>
> Keep everything else identical to the brand rules: flat shapes, exact palette,
> no text.

_(Typeset "MergeForge" + tagline — e.g. "Resolve merge conflicts the JetBrains
way, with AI" — yourself in Figma/Preview so the typography stays crisp; AI image
models mangle text. Upload at repo → Settings → General → Social preview.)_

## Prompt 3 — Wide banner / README header (3:1)

> Same brand system: design a **1536×512 wide banner**. The mark sits at the
> horizontal center, slightly enlarged. To its left and right, the two branch
> lines extend outward across the banner's full width — red running to the left
> edge, blue to the right edge, each with two or three commit-dots spaced along
> the way — so the whole banner reads as one long git graph converging on the
> forge moment at the center. Dark `#16171f` background, subtle vignette, no text.

## Prompt 4 — Monochrome variant (future favicons / status contexts)

> Take the final icon mark and produce a **single-color version**: all shapes in
> pure white `#ffffff` on transparent background, 1024×1024 PNG. Merge overlapping
> shapes into one clean silhouette. This must survive being displayed at 16×16.

---

## After you have the images

```sh
# Downscale the winning 1024px icon for the extension:
sips -z 256 256 icon-1024.png --out media/icon.png

# Nothing else changes — package.json already points at media/icon.png:
pnpm run package
```

- `media/icon.png` — replace, repackage, done (keep 256×256).
- Social card — upload to GitHub, don't commit it (or commit as `media/social.png` if you want it versioned).
- Banner — `media/banner.png`, referenced from the README header if you like it.
- Keep the source 1024px PNGs somewhere; marketplaces occasionally ask for larger sizes.
