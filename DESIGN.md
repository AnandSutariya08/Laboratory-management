# Health Care Labs — Design System

Liquid Glass ideas (a floating functional layer over calm content) expressed through semantic colour
roles, adapted to a desktop lab information system. Value tags: **(Apple)** keep, **(default)** template
starting value, **(project)** decided for this product.

## A. Project facts

| Item | Value |
|---|---|
| Product | Health Care Labs: lab information system for registration, billing, sample tracking, results, reports, QC, inventory and analytics |
| Profile (§1) | **Productivity / dashboard** (desktop and tablet, dense tables and forms) |
| Platform and toolkit | Web: React 19 + Vite 8 + TypeScript, Ant Design 6 for form/table primitives, Firebase |
| Theme source of truth | `src/design/tokens.css` (CSS custom properties) mirrored into Ant Design via `src/theme.ts` |
| Input | Pointer and keyboard; touch on tablets; barcode scanner as keyboard input |
| Hardware floor and blur tier | Modern PCs and laptops → **Tier A** (`backdrop-filter`) where supported, Tier B fallback |
| Data liveness | Live: Firestore `onSnapshot` pushes worklists, counts and statuses |
| Accessibility target | **WCAG 2.2 AA**: 4.5:1 text, 3:1 large text and UI parts, visible focus, labelled icon buttons |
| Progress file | `DESIGN_PROGRESS.md` |

## 1. Profile values (Productivity / dashboard)

| Setting | Value |
|---|---|
| Glass budget on screen | 2–3 (top bar, sidebar, one open panel/dialog) |
| Motion intensity | Medium: durations ×0.8 |
| Bounce (release damping) | 0.7 |
| Body text | 14 px (13 px in dense tables), minimum 12 px; no weights below 400 under 20 px |
| Contrast target | 4.5:1 (text < 18 px), 3:1 large text and non-text UI |
| Click target | 32 px pointer, 44 px on touch (`@media (pointer: coarse)`) |
| Live-data motion | Cross-fade only |
| Default blur tier | A where supported |
| First load | Skeletons |

## 2. Core rules (every screen)

1. Two layers: **content** (cards, rows, tables, KPIs, forms) is solid tonal; **glass** (top bar, sidebar,
   toolbars, drawers, modals, menus, popovers, toasts) floats above it. No glass in the content layer (Apple).
2. Glass sparingly — at most the budget above.
3. No glass on glass: things on glass use fills or text.
4. Regular glass only (no Clear glass: the app has no photo/video backgrounds).
5. Glass is monochrome; tint only for the single primary action of a surface or a real status.
6. Non-interactive items (titles, counts, clocks) are plain text next to bars, never glass buttons.
7. Concentric corners: inner = outer − padding, min 8 (`concentric()` helper).
8. No solid bar backgrounds or dividers under floating glass; one scroll-edge effect per pane.
9. One selection language: tabs, segmented controls, filter chips and sidebar items use the same
   sliding selection pill.
10. Motion is feedback for what the user did; pushed data never bounces or slides.
11. Surfaces opened by a control grow from it (menus, popovers, drawers, confirm dialogs).
12. Every glass surface has Reduce Transparency, Increase Contrast and Reduce Motion paths.
13. Never colour alone: every status has text or an icon.

## 3. Layer map

| Surface | File / component | Layer | Treatment |
|---|---|---|---|
| Top bar (search, scan, branch, help, updates, notifications, settings, user) | `src/layout/TopBar.tsx` | Glass (small) | Capsule groups (max 3), page title as plain text beside it |
| Sidebar navigation | `src/layout/Sidebar.tsx` | Glass (small) | Capsule rail, selection pill on the active item |
| Page tabs / segmented filters / status tabs | `src/design/Segmented.tsx` | Glass (small) | Selection pill |
| Primary action of a page (e.g. Go to Billing, New Booking) | `src/design/Button.tsx` `variant="primary"` | Glass, tinted | One per surface |
| Cards, KPI tiles, tables, forms | `src/design/Card.tsx`, Ant Design Table/Form themed | Content | `surfaceContainerHigh`, 24 radius, 1 px `outlineVariant`, no elevation |
| Status chips (Pending, Due, Final…) | `src/design/StatusChip.tsx` | Content | Tonal wash + dot/icon, not pressable |
| Drawers (booking, PO, versions, interpretation) | Ant Design Drawer themed via `.glass--large` | Glass (large) | Side panel inset 16, no scrim when parallel |
| Modals (billing, refund, clear due, send report…) | Ant Design Modal themed | Glass (large) | 45% scrim; inner sections tonal |
| Menus, dropdowns, popovers, popconfirms | Ant Design Dropdown/Popover themed | Glass (large) | Grow from source |
| Toasts (message/notification) | Ant Design message/notification themed | Glass (small) | Rise and fade, replace don't stack |
| Printable report, receipt, labels | `src/pages/report/*`, `BillReceipt` | Print | Plain white, no glass, print styles only |

## 4. Tokens

### 4.1 Glass recipe

| Layer | Tier B (no blur) | Tier A (`@supports (backdrop-filter: blur(1px))`) |
|---|---|---|
| Backdrop | none | blur 24 px (small) / 32 px (large) |
| Fill | `surfaceContainerHigh` 88% / 97% | `surface` 62% / 76% |
| Ambient colour | App background wash (soft sky gradient) shows through | same |
| Rim | 1 px gradient stroke, white 35% light / 14% dark → 0% | same |
| Shadow | small: 0 4 12 tinted 18% (light) / 40% (dark); large: 0 12 32 | same |
| Tinted (primary action) | fill blended 35% toward `primary`, content `onPrimaryContainer` | same |
| Identity (Reduce Transparency / high contrast) | opaque `surfaceContainerHigh` + 1 px `outlineVariant`, no blur, no rim | same |

### 4.2 Radii

Panels/sheets 28 · cards 24 · sections in panels 20 · dialogs 32 · capsules 999 · inner = outer − padding, min 8.

### 4.3 Colour (project)

Brand: **sky blue on white**. Roles live in `src/design/tokens.css` for light, dark and
high-contrast (`prefers-contrast: more`), plus an app `data-theme` override.

| Role | Light | Dark |
|---|---|---|
| primary / onPrimary | `#0369A1` / `#FFFFFF` (AA on white) | `#7DD3FC` / `#00344F` |
| primaryContainer / onPrimaryContainer | `#E0F2FE` / `#0C4A6E` | `#004B70` / `#CDEBFF` |
| surface | `#F8FBFE` | `#0E141A` |
| surfaceContainerLow / Container / High / Highest | `#F1F6FB` / `#EBF2F8` / `#FFFFFF` / `#E3EDF6` | `#151C23` / `#1A222A` / `#212A33` / `#2B3540` |
| onSurface / onSurfaceVariant | `#0F1B26` / `#44525F` | `#E3EAF1` / `#B6C3CF` |
| outline / outlineVariant | `#74828F` / `#D3DEE8` | `#8B98A5` / `#38444F` |
| error / onError | `#B3261E` / `#FFFFFF` | `#F2B8B5` / `#601410` |
| status urgent / caution / success / info | `#B3261E` / `#8A5300` / `#1B6E3A` / `#0369A1` | `#F2B8B5` / `#FFB95C` / `#7DD99B` / `#7DD3FC` |

The brand accent `#0EA5E9` (sky-500) is used only for large fills and the ambient background wash,
never for text on white (it fails 4.5:1).

### 4.4 Type and spacing

System UI stack (`Inter` when available); body 14, dense 13, minimum 12; numbers in tables, prices,
counts and barcodes use `font-variant-numeric: tabular-nums`. Spacing scale: 4, 8, 12, 16, 20, 24, 32, 48.
Bars: ≤ 3 groups, 12 gap, one primary action trailing.

## 5. Motion (Productivity: medium, ×0.8)

| Token | Value |
|---|---|
| `--spring-press` | press to scale 0.97, 130 ms `cubic-bezier(0.2,0,0,1)` |
| `--spring-release` | CSS `linear()` spring, damping 0.7, 250 ms |
| `--spring-select` | selection pill, `linear()` spring damping 0.78, 280 ms |
| `--spring-morph` | panels/popovers, damping 0.82, 300 ms |
| `--dur-micro` / `short` / `medium` / `long` | 100 / 160 / 240 / 300 ms |
| `--ease-emphasized` | `cubic-bezier(0.2, 0, 0, 1)` |
| stagger | 18 ms per item, cap 8 |

Implemented in CSS (`linear()` spring curves and transitions) plus a tiny `src/design/motion.ts`; no
animation library. `@media (prefers-reduced-motion: reduce)` swaps every spring for a 100 ms fade.
Pushed Firestore updates cross-fade only; user re-sorts may animate moves.

## 6. Components

- **Glass capsule group** (top bar groups, toolbars): height 44, padding 4, children 36.
- **Selection pill**: one tonal `primary` capsule behind the active segment; used by sidebar, tabs,
  status tabs, segmented controls, filter chips. Exposes `aria-selected`; arrow keys move selection.
- **Content card / row**: `surfaceContainerHigh`, 24 radius, 1 px `outlineVariant`, no shadow; selected
  = 2 px `primary` ring.
- **Large glass panel**: modals, drawers, dropdowns; 28 radius (32 dialogs); 45% scrim when modal.
- **Status chip**: tonal wash + dot + text, not pressable. **Action chip**: inside a glass group, uses the pill.

## 7. Layout

Edge-to-edge page with a soft ambient sky wash; floating glass sidebar (inset 12) and top bar (inset 12);
content padded so it never rests under glass. Breakpoints: compact < 768 (sidebar becomes a drawer),
medium < 1200, expanded ≥ 1200 (detail opens as a side drawer). Hierarchy by spacing, not dividers.

## 8. Accessibility modes (web)

| Mode | Trigger | Effect |
|---|---|---|
| Reduce transparency | `prefers-reduced-transparency: reduce` or Settings › Display | glass → identity |
| Increase contrast | `prefers-contrast: more` or Settings › Display | high-contrast palette, opaque glass, 1.5 px outlines, no tinted glass |
| Reduce motion | `prefers-reduced-motion: reduce` or Settings › Display | §5 reduced paths |
| Large text | browser zoom / rem units | reflow, no clipped labels |

Every icon-only button has an `aria-label`; visible 2 px `primary` focus ring with 2 px offset; polite
live region for list summaries; logical focus order; keyboard alternatives for drag reordering.

## 9. Platform notes (web)

Tokens are CSS custom properties on `:root`, redefined for `prefers-color-scheme: dark`,
`prefers-contrast: more` and `[data-theme]`. Glass is one `.glass` / `.glass--large` / `.glass--tinted`
class set; `backdrop-filter` only inside `@supports`. Ant Design is themed from the same tokens
(`src/theme.ts` reads the CSS variables) so tables, inputs and pickers match.

## 10. Building blocks

| # | Block | Location |
|---|---|---|
| 1 | Tokens | `src/design/tokens.css`, `src/theme.ts` |
| 2 | Motion | `src/design/motion.css`, `src/design/motion.ts` |
| 3 | Glass surface | `src/design/glass.css`, `src/design/Glass.tsx` |
| 4 | Concentric | `src/design/concentric.ts` |
| 5 | Segmented control + selection pill | `src/design/Segmented.tsx` |
| 6 | Scroll edge | `src/design/ScrollEdge.tsx` |
| 7 | Skeleton | `src/design/Skeletons.tsx` |
| 8 | Readable | `src/design/readable.ts` |

## 11. Don'ts (check every UI diff)

- No glass on cards, rows, tables, KPIs, status chips.
- No glass on glass; ≤ 1 tinted control per glass surface; no tint for decoration.
- No status colour on chrome; never colour alone.
- No motion on pushed data beyond a cross-fade; no bounce on content.
- No hard-coded colours, radii, durations in screens — tokens only.
- No glass without its reduce-transparency, high-contrast and reduce-motion paths.

## 12. Decisions

| # | Decision | Answer |
|---|---|---|
| 1 | Blur tier | Tier A where supported (modern PCs), Tier B fallback — **user, 2026-10-16** |
| 2 | New dependencies | None: CSS `linear()` springs + small motion helper instead of an animation library — **project** |
| 3 | Titles and counts off glass | Page title sits as plain text beside the floating top bar; counts in status tabs are text inside the pill control, not separate buttons — **project** |
| 4 | Accessibility target | WCAG 2.2 AA — **user, 2026-10-16** |
| 5 | Keep Ant Design | Yes, themed from tokens, for forms, tables, pickers; custom shell, segmented control and status chips — **project** |
