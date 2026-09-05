# Before / After — Chit Fleet Protocol

## Before

The approved Fleet Protocol proposal established the intended hierarchy and visual
language, but it was an exploration artifact rather than a deployable public page.
It referenced a logo outside the landing output, used smooth scrolling, combined the
hero entrance into one motion unit, and did not explain the current Sepolia prototype
or the in-progress Robinhood Chain migration.

## After

The production surface is a no-dependency static site with local assets and a single,
calm Fleet Protocol hierarchy. It separates the current confidential ERC-4337
prototype from the planned Robinhood Chain fleet model, states public and operator
privacy boundaries directly, and offers one clearly labeled one-way link to the
former product.

The header correction replaces the landing-only approximation with the canonical
Chit mark and places the verified contract address directly beneath the `CHIT /
FLEET` lockup. Its copy control provides visible success feedback while failure
feedback remains screen-reader-only and nonvisual, without changing the established
navigation, hierarchy, or reveal motion. The complete CA, address, and Copy/Copied
control stays compact on that left edge; the live status is screen-reader-only and
Copy no longer stretches to the desktop header's far right.

| Area | Production change | Benefit |
| --- | --- | --- |
| Hierarchy | Restrained hero plus one-purpose sections | A clear first read without dashboard density |
| Motion | One-time hero, seam, procession, and section reveals | Explains the fleet without decorative replay |
| Accessibility | Semantic landmarks, skip link, visible focus, 44px targets, and copy status | Keyboard, touch, and screen-reader access without a parallel experience |
| Truth | Prototype, migration, and independence disclaimers | No implication that Robinhood Chain support is live or endorsed |
| Assets | Canonical local SVG mark used for both logo and favicon | Separately deployable without runtime dependencies |

## Verification Notes

- Desktop evidence: 1440 × 1000.
- Mobile evidence: 390 × 844; full mobile: 390 × 5605.
- Responsive checks at 320, 390, 768, 1440, and 1920px found no horizontal overflow.
- Reduced motion presents every reveal immediately and removes hero/seam positional
  and clipping motion.
