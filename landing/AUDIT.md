# UI Revamp Audit — Chit Fleet Protocol

**Project:** `chit/landing/public`

**Date:** 2026-08-30

**Auditor:** UI-revamp workflow

## Baseline

The baseline command was run before production files existed:

```text
$ node /Users/mac/.agents/skills/ui-revamp/scripts/audit.js landing/public
Path not found: landing/public
```

There was no existing production surface to score. The selected proposal is a design
reference, not the implementation baseline: it uses smooth scrolling, a remote logo
path, a combined hero entrance, and does not yet carry the truthful prototype-to-
Robinhood Chain migration story.

## Approved Production Plan

1. Establish a local-only static surface, authored type stack, locked paper/coral
   palette, and the blind seam as the only motif.
2. Keep the hero to one status line, one headline, one paragraph, one internal
   action, and the five-line anchor.
3. Add the current Sepolia prototype, migration, public-record, and operator-boundary
   facts as separate readable sections; link one-way to the former prototype.
4. Use once-only motion only for the hero, seam, five-account explanation, and
   section entry; make it pointer- and reduced-motion-safe.
5. Validate keyboard reachability, touch-target size, responsive density, source
   restrictions, browser motion, and visual captures.

## Heuristic Intent

| Heuristic | Target |
| --- | --- |
| System status | Explicit prototype and in-progress migration labels |
| Real-world match | Plain-language bounded campaign and five-account sequence |
| User control | Internal navigation and readable risk controls |
| Consistency | One palette, one signature seam, one spacing scale |
| Error prevention | No action that implies an available product or enrollment |
| Recognition | Visible headings and ordered labeled account line |
| Flexibility | Keyboard navigation, skip link, and responsive layout |
| Minimalism | One purpose per section and no dashboard chrome |
| Error recovery | Former-prototype link is explicit about its destination |
| Help/docs | Privacy and status boundaries are stated in-page |

## Final Validation

```text
$ node /Users/mac/.agents/skills/ui-revamp/scripts/audit.js landing/public
UI Revamp Audit
===============

Scanning: landing/public

Files scanned: 2

No violations found!
```

The final audit has 0 critical, 0 major, and 0 minor violations. The blur and squint
checks retain one large hero statement, a single coral path, and clearly separated
section fields; the full mobile capture confirms the same hierarchy without motif or
text collisions.

## Brand and Contract Correction

The production header now uses the byte-identical canonical Chit favicon for both
the displayed mark and the favicon. Its `CHIT / FLEET` lockup now has a compact CA
row directly beneath it, with the complete address, a 44px Copy control, and a
polite live status for both successful and failed copy attempts. The address wraps
within the 320px viewport and the existing motion system remains unchanged.

The contract grid is content-width and left-aligned beneath the brand at desktop
sizes, so Copy remains eight pixels after the rendered address instead of stretching
to the header's far edge. On success the button itself changes from `Copy` to
`Copied`; the polite live region remains screen-reader-only for both success and
failure, so no feedback row changes the visible header geometry.
