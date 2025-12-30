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

## Terminal Demos

See `demos/README.md` for VHS tape creation.
