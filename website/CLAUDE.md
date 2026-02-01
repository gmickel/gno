# Website Development Guide

GNO documentation site built with Jekyll, deployed to Vercel.

## Structure

```
website/
├── _config.yml      # Jekyll config, nav structure
├── _layouts/        # Page templates
├── _includes/       # Reusable components
├── _data/           # YAML data files
├── assets/          # Images, CSS, demos
├── docs/            # COPIED from ../docs/ during build (gitignored)
├── features/        # Feature pages (pSEO)
├── demos/           # VHS terminal demo tapes
└── index.md         # Homepage
```

## docs/ Directory

**NOTE**: `website/docs/` is auto-copied from project root `/docs/` during build.

Edit docs in `/docs/` (project root), not here. This directory is gitignored.

**Subdirectories**: The `make sync-docs` target copies both top-level `.md` files AND subdirectories (e.g., `comparisons/`, `integrations/`). If you add new subdirectories to `/docs/`, they will be automatically synced.

**CRITICAL**: Only user-facing documentation belongs in `/docs/`:

- QUICKSTART.md, CLI.md, CONFIGURATION.md, etc.
- Do NOT add: spikes, plans, internal notes, architecture decisions
- Internal docs go in `/notes/` (project root)

The nav structure in `_config.yml` explicitly lists which docs appear in sidebar.

## Local Development

```bash
cd website
bundle install
bundle exec jekyll serve
# Open http://localhost:4000
```

## Deployment

Automatic via Vercel on push to main.

## Adding Documentation

1. Create `.md` file in `docs/`
2. Add to nav in `_config.yml` if it should appear in sidebar
3. Use front matter if custom title/layout needed

## Screenshots

Source screenshots live in `/assets/screenshots/` (project root). For local dev, copy to website:

```bash
cp ../assets/screenshots/*.{jpg,png} assets/screenshots/
```

### Capture Settings

**Chrome DevTools:**

- Dimensions: 1380 × 880
- DPR: 2.0
- Cmd+Shift+P → "Capture screenshot"

**Brandbird:**

- Canvas: 2960 × 2010 px
- Template: "gno"

## Terminal Demos (VHS)

The documentation website includes animated terminal demos built with [VHS](https://github.com/charmbracelet/vhs).

### Structure

```
website/
├── demos/
│   ├── build-demos.sh       # Build script
│   └── tapes/               # VHS tape files
│       ├── hero.tape
│       ├── quickstart.tape
│       └── search-modes.tape
└── assets/demos/            # Generated GIFs
```

### Building Demos

```bash
# Build all demos
bun run website:demos

# Build specific demo
./website/demos/build-demos.sh hero

# List available tapes
./website/demos/build-demos.sh
```

### Creating New Demos

1. Create `website/demos/tapes/your-demo.tape`:

```tape
Output "your-demo.gif"
Set Theme "TokyoNight"
Set FontFamily "JetBrains Mono"
Set FontSize 16
Set Width 900
Set Height 500

# Hidden setup (not recorded)
Hide
Type `export DEMO_DIR=$(mktemp -d)`
Enter
# ... setup commands ...
Show

# Visible demo
Type "gno search 'query'"
Enter
Sleep 3s
```

2. Build: `./website/demos/build-demos.sh your-demo`

3. Use in docs:

```html
<div class="demo-container">
  <img src="/assets/demos/your-demo.gif" alt="Demo" class="demo-gif" />
</div>
```

### Requirements

- VHS: `brew install charmbracelet/tap/vhs`
- GNO linked globally: `bun link`

## SEO Meta Tags

Meta tags are defined manually in `_layouts/default.html` (NOT using jekyll-seo-tag plugin).

### How Tags Are Generated

| Tag              | Source                                            | Example                                              |
| ---------------- | ------------------------------------------------- | ---------------------------------------------------- |
| `<title>`        | `page.title \| site.title`                        | "Hybrid Search \| GNO"                               |
| `og:title`       | `page.title - page.headline` (if headline exists) | "Hybrid Search - The Best of Keywords and Semantics" |
| `og:description` | `page.description`                                | From frontmatter                                     |
| `og:image`       | `page.og_image`                                   | `/assets/images/og/og-hybrid-search.png`             |
| `twitter:card`   | `site.twitter.card`                               | `summary_large_image`                                |
| `canonical`      | `page.url \| absolute_url`                        | `https://www.gno.sh/features/hybrid-search/`         |

### Feature Page Frontmatter (Full Example)

```yaml
---
layout: feature
title: Feature Name # Short title (used in <title>)
headline: The Catchy Tagline # Combined with title for og:title (50-60 chars total)
description: Longer description for meta description and og:description
slug: feature-slug
permalink: /features/feature-slug/
og_image: /assets/images/og/og-feature-slug.png # REQUIRED for social sharing
keywords: comma, separated, keywords
icon: icon-name # From _includes/icons.html
---
```

### Optimal Lengths (pSEO)

- **og:title**: 50-60 characters (title + headline)
- **description**: 150-160 characters
- **OG image**: 1200x630px with CTA ("Learn more → gno.sh")

## OG Images

Feature-specific Open Graph images for social sharing.

**CRITICAL**: Every feature page MUST have `og_image` in frontmatter pointing to its PNG.

### Adding a New Feature with OG Image

1. Create HTML template: `assets/images/og/og-feature-slug.html`
2. Generate PNG: `bun run website:og -f og-feature-slug`
3. Create feature page with `og_image` frontmatter pointing to the PNG
4. Push to main - CI auto-creates PR with regenerated PNGs
5. Merge the OG images PR

See `assets/images/og/CLAUDE.md` for template design system (colors, fonts, layout).
