# ADR-001: Scholarly Dusk Design System

**Status**: accepted
**Date**: 2026-04-05
**Author**: Gordon Mickel

## Context

The `gno serve` web UI runs inside an Electrobun desktop shell and needs a coherent, documented design system so agents and contributors produce visually consistent UI without guesswork or "AI slop" aesthetics.

## Decision

Adopt the "Scholarly Dusk" design language documented below as the canonical reference for all web UI work.

---

Design system reference for the `gno serve` web application. Read this before creating or modifying any UI component.

## Aesthetic Identity

**Scholarly Dusk** — a private research library at night. Dark wood, brass fixtures, teal-inked manuscripts, glass specimen cabinets. The UI should feel like a tool built by an antiquarian scholar who happens to know TypeScript.

**NOT**: generic SaaS dashboard, Material Design, flat/corporate, or "AI slop" (purple gradients, Inter font, rounded cards with drop shadows).

## Desktop Shell Context

The app runs inside an **Electrobun** shell (Bun-native desktop wrapper):

- Default window: **1440 x 960 px**
- Tab bar consumes ~40px top (outside webview)
- **Effective CSS viewport: ~1380 x 920 px** at default size
- Users may resize — the inner content viewport is often **1000–1300px** depending on window width
- All CSS breakpoints refer to the inner webview, not the outer window
- No Electrobun-specific code in `/serve/public/` — the web UI stays platform-agnostic

## Color Palette

Defined in `globals.css` as HSL CSS variables. Always use semantic tokens, never raw hex.

### Dark Theme (default — "Library at Night")

| Token                | HSL           | Hex       | Usage                                            |
| -------------------- | ------------- | --------- | ------------------------------------------------ |
| `--background`       | `0 0% 2%`     | `#050505` | Page canvas                                      |
| `--foreground`       | `0 0% 93%`    | `#ededed` | Body text                                        |
| `--card`             | `220 14% 7%`  | `#0f1115` | Card/panel surfaces                              |
| `--primary`          | `169 41% 51%` | `#4db8a8` | Alchemical Teal — links, accents, focus rings    |
| `--secondary`        | `39 56% 58%`  | `#d4a053` | Old Gold — brass accents, backlink icons, warmth |
| `--muted`            | `217 14% 11%` | `#181b21` | Recessed surfaces, hover backgrounds             |
| `--muted-foreground` | `214 7% 61%`  | `#949ba3` | Secondary text, labels                           |
| `--border`           | `216 12% 14%` | `#1f2329` | Dividers, card edges                             |
| `--destructive`      | `0 84% 60%`   | —         | Errors, delete actions                           |

### Light Theme ("Antique Paper")

Triggered by `[data-theme="light"]`. Warm parchment tones replace the dark palette. See `globals.css` for values.

### Usage Rules

- **Teal (`primary`)**: interactive elements, links, focus rings, progress bars, count badges
- **Old Gold (`secondary`)**: brass accents on backlinks, warm highlights, icon tints for incoming references
- **Never** use raw hex like `#4db8a8` in components — use `text-primary`, `bg-primary/10`, etc.
- Opacity modifiers: `/10` for subtle bg tints, `/30` for borders, `/60` for secondary text

## Typography

All fonts are **system fonts** — no external font loading (offline-first constraint).

| Role         | Stack                                                                                | Usage                            |
| ------------ | ------------------------------------------------------------------------------------ | -------------------------------- |
| **Body**     | `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`                  | All body text, UI labels         |
| **Headings** | `"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif`   | h1–h6, document titles           |
| **Mono**     | `"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace` | Code, paths, rail labels, badges |

### Text Hierarchy (sidebar/rail context)

| Element        | Classes                                                                               |
| -------------- | ------------------------------------------------------------------------------------- |
| Section header | `font-mono text-[10px] text-muted-foreground/60 uppercase tracking-[0.15em]`          |
| Property value | `text-[13px] font-medium` or `text-[13px] text-muted-foreground`                      |
| Path/URI       | `font-mono text-[11px] text-muted-foreground/70 break-all`                            |
| Count badge    | `font-mono text-[10px] tabular-nums bg-primary/12 text-primary rounded px-1.5 py-0.5` |
| Tag chip       | `font-mono text-[10px] text-primary/80 bg-primary/10 rounded-full px-2 py-0.5`        |
| Micro label    | `font-mono text-[9px] text-muted-foreground/50 uppercase`                             |

## Layout System

### Breakpoint Strategy

| Breakpoint  | Width    | Layout                                                     |
| ----------- | -------- | ---------------------------------------------------------- |
| `< lg`      | < 1024px | Single column; overview inline above content               |
| `lg`        | 1024px+  | 3-column: left rail (200px) + content + right rail (240px) |
| `lg` hidden | —        | Overview card hidden when left rail visible                |

**Important**: Do NOT use `xl` (1280px) or higher breakpoints for showing/hiding structural elements — the Electrobun shell eats ~60–140px of window width for its own chrome, so a 1440px window yields ~1300px CSS viewport. The `lg` breakpoint (1024px) is the reliable threshold.

### Three-Column Document View

```
┌──────────┬─────────────────────────────┬──────────┐
│ Left Rail│      Main Content           │Right Rail│
│  200px   │      flex-1 px-4            │  240px   │
│ border-r │                             │ border-l │
│ pr-2     │                             │ pl-2     │
└──────────┴─────────────────────────────┴──────────┘
```

- **Left rail**: Document facts (properties, path, metadata/tags). Slim, no Card chrome.
- **Main content**: Breadcrumbs, then content. `px-4` inner padding so content never touches rail borders.
- **Right rail**: Relationship panels (backlinks, outgoing links, related notes). Collapsible sections.
- Max width container: `max-w-[1800px] mx-auto`
- Gap between columns: `gap-5`

### Rail Design Language

Both rails share the same visual vocabulary:

- **No Card wrappers** in rails — use flat sections with hairline `border-border/20 border-t` dividers
- **Section headers**: `font-mono text-[10px] text-muted-foreground/60 uppercase tracking-[0.15em]`
- **Consistent padding**: `px-3` horizontal within rail content, `py-3` between sections
- **Hover state**: `hover:bg-muted/20` — subtle, consistent
- **Border treatment**: `border-border/15` on the rail `<aside>` edge only

### Collapsible Panel Pattern

All right-rail panels (BacklinksPanel, OutgoingLinksPanel, RelatedNotesSidebar) follow this structure:

```tsx
<div className="px-1">
  <Collapsible>
    <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-sm px-2 py-1.5 transition-colors duration-150 hover:bg-muted/20">
      {/* Chevron: text-muted-foreground/50, size-3.5 */}
      {/* Title: section header style (see above) */}
      {/* Count badge: bg-primary/12 text-primary */}
    </CollapsibleTrigger>
    <CollapsibleContent className="animate-collapse-down">
      <div className="space-y-0.5 p-2">{/* Items */}</div>
    </CollapsibleContent>
  </Collapsible>
</div>
```

### Link Item Pattern (right rail)

Backlinks, outgoing links, and related notes all use this row pattern:

```tsx
<button className="group relative flex min-w-0 w-full items-start gap-2 rounded px-2 py-1.5 text-left font-mono text-xs transition-all duration-150 cursor-pointer hover:bg-muted/20 hover:translate-x-0.5">
  {/* Icon in rounded bg: size-5, bg-[color]/15 */}
  {/* Title: break-words, leading-tight */}
  {/* Optional subtitle: text-[10px] opacity-60 */}
</button>
```

## Component Conventions

### Buttons

All buttons use the shadcn `Button` component with `cursor-pointer` baked into the base variant. Plain `<button>` elements must explicitly add `cursor-pointer`.

### Floating Controls

For toggle pills overlaid on content (e.g., Source/Rendered toggle):

```tsx
const floatingControlStyle = {
  position: "absolute",
  top: "0.75rem",
  right: "0.75rem",
  left: "auto",
} as const;

<button
  className="z-10 flex cursor-pointer items-center gap-1.5 rounded-full border border-border/30 bg-background/80 px-3 py-1 font-mono text-[11px] text-muted-foreground backdrop-blur-sm transition-colors hover:border-primary/30 hover:text-primary"
  style={floatingControlStyle}
>
```

**Note**: Use inline `style` for absolute positioning — Tailwind's `right-3` / `top-3` can be overridden by CSS resets in certain contexts. The inline style guarantees placement.

### Cards

Use `Card` / `CardContent` from shadcn only for standalone content blocks (error states, notices, overview cards). Do NOT use Cards inside rails — they add too much visual chrome for narrow contexts.

### Badges / Chips

| Purpose         | Pattern                                                                                                  |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| File extension  | `<Badge variant="outline" className="font-mono">`                                                        |
| Tag (read-only) | `<span className="rounded-full bg-primary/10 px-2 py-0.5 font-mono text-[10px] text-primary/80">`        |
| Count in header | `<span className="rounded bg-primary/12 px-1.5 py-0.5 font-mono text-[10px] text-primary tabular-nums">` |
| Status          | `<Badge variant="secondary">`                                                                            |

### Dialogs

Use shadcn `Dialog`. The close button has `cursor-pointer`. Background: `bg-[#0f1115]` (card color).

## Animation

Defined in `globals.css`. Prefer these over custom CSS:

| Class                           | Effect                  | Duration       |
| ------------------------------- | ----------------------- | -------------- |
| `animate-fade-in`               | Fade up 10px            | 0.5s ease-out  |
| `animate-slide-up`              | Slide up 16px           | 0.6s spring    |
| `animate-scale-in`              | Scale from 96%          | 0.4s spring    |
| `animate-collapse-down`         | Radix collapsible open  | 0.2s ease-out  |
| `animate-collapse-up`           | Radix collapsible close | 0.15s ease-out |
| `stagger-1` through `stagger-6` | Delay increments        | 0.1s steps     |
| `animate-pulse-glow`            | Box-shadow pulse        | 3s infinite    |

For staggered list items, use inline `animationDelay` + `animationFillMode: "forwards"` with `opacity-0` initial state.

## Background & Atmosphere

- **Page body**: Layered — teal radial glow at top + 32px grid lines at 1.8% opacity
- **Glass header**: `.glass` class — `bg-background/85 backdrop-blur-20px`
- **Content inner**: `rounded-lg border border-border/40 bg-gradient-to-br from-background to-muted/10 p-4 shadow-inner`
- **Scrollbar**: 8px, transparent track, `border` color thumb

## Accessibility

- All interactive elements need `cursor-pointer`
- Focus rings: `focus-visible:ring-2 focus-visible:ring-primary/50` or `focus-visible:outline-2 outline-primary`
- `aria-label` on icon-only buttons
- `sr-only` labels on definition list terms in rails
- `prefers-reduced-motion` media query disables all animations
- Semantic HTML: `<nav>`, `<main>`, `<aside>`, `<dl>` for appropriate contexts

## Anti-Patterns (Do NOT)

- Use Card/CardHeader/CardTitle inside side rails
- Use `xl` or `2xl` breakpoints for structural layout changes
- Use raw hex colors instead of CSS variable tokens
- Use `Inter`, `Roboto`, or web fonts (offline-first constraint)
- Use `right-3` / `top-3` Tailwind classes for absolute positioning (use inline style)
- Put frontmatter display in the editor preview pane (redundant with source view)
- Create "specimen cards" with heavy borders for sidebar items — use flat link rows
- Forget `cursor-pointer` on any clickable element
- Use `space-y-4` in rails — use `space-y-0.5` or `space-y-1` for tight spacing

## File Map

| File                  | Purpose                                                    |
| --------------------- | ---------------------------------------------------------- |
| `globals.css`         | CSS variables, animations, utility classes                 |
| `components/ui/*.tsx` | shadcn base components (Button, Card, Badge, Dialog, etc.) |
| `components/*.tsx`    | App-specific components (panels, modals, selectors)        |
| `pages/*.tsx`         | Route-level page components                                |
| `hooks/*.ts`          | Custom hooks (useApi, useDocEvents)                        |
| `lib/*.ts`            | Utilities (deep-links, workspace-tabs, cn)                 |
