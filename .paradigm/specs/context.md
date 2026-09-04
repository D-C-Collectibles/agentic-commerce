# Context & Documentation Index System

The Context system provides **hierarchical documentation indexing** for efficient AI navigation. It enables AI agents to find and read only the relevant portions of documentation, reducing token usage and improving accuracy.

---

## Core Principle

**AI agents should read indexes first, then targeted sections — never entire documents blindly.**

The system provides:
- Directory-level indexes (`.index.yaml`)
- Document frontmatter with metadata
- Section-level line ranges
- Dependency tracking between files

---

## Index System Structure

```
docs/
├── .index.yaml           # Directory index (read this FIRST)
├── DESIGN.md             # Document with YAML frontmatter
├── API.md                # Another indexed document
└── guides/
    ├── .index.yaml       # Subdirectory index
    └── getting-started.md
```

---

## Index File Schema

Each directory with documentation should have a `.index.yaml`:

```yaml
# .index.yaml
version: 1.0.0
description: What this directory contains
updated: YYYY-MM-DD

documents:
  - id: unique-id
    file: filename.md
    title: Human-readable title
    summary: One-line description for quick scanning
    lines: total-line-count
    tags: [keyword, tags, for, search]
    canonical_for: [concepts-this-is-source-of-truth-for]
    sections:
      - anchor: "section-anchor"
        title: Section Title
        lines: [start, end]
        summary: What this section covers
        subsections:
          - anchor: "sub-anchor"
            title: Subsection Title
            lines: [start, end]
            summary: Subsection content

dependencies:
  - source: doc-id#section
    affects: [list, of, files, or, globs]
    reason: Why changes here affect those files

subdirs:
  - path: subdir/
    summary: What the subdirectory contains
    index: subdir/.index.yaml
```

---

## Document Frontmatter Schema

Each indexed document should have YAML frontmatter:

```yaml
---
id: unique-id
title: Document Title
version: 0.1.0
updated: YYYY-MM-DD
tags: [keywords, for, search]
canonical_for: [concepts, this, owns]
related:
  - ../path/to/file (description)
  - ../other/file (description)
changelog:
  - YYYY-MM-DD: What changed
  - YYYY-MM-DD: Previous change
---

# Document Title

Content begins here...
```

---

## AI Navigation Protocol

When working with documentation:

### 1. Start with Index

Always read the `.index.yaml` first:

```
Read: docs/.index.yaml
→ Understand what documents exist
→ Find relevant document by tags/summary
→ Get section line ranges
```

### 2. Use Section Hints

Index provides line ranges — read only what's needed:

```
# Instead of reading entire 1000-line doc:
Read: docs/DESIGN.md (lines 531-770)  # Just data models section
```

### 3. Check Dependencies

Before changing a document:

```yaml
dependencies:
  - source: design#data-models
    affects: [../backend/migrations/*]
    reason: Schema changes require migrations
```

→ If editing `#data-models`, also review migration files

### 4. Update Atomically

When editing a document:

1. Update the document content
2. Update the document's frontmatter (`updated`, `changelog`)
3. Update the directory's `.index.yaml` (`lines`, `summary` if changed)

### 5. Propagate Changes

If `dependencies.affects` lists other files, review them for consistency.

---

## Index Maintenance Rules

| Action | Index Update Required |
|--------|----------------------|
| Create new doc | Add entry to parent `.index.yaml` |
| Delete doc | Remove from `.index.yaml`, check dependencies |
| Rename doc | Update all references in indexes |
| Add/remove sections | Update `sections` array with new line ranges |
| Change doc content | Update `lines` count, `summary` if meaning changed |

---

## Line Number Guidelines

- Line numbers are **approximate** (within ~5 lines is acceptable)
- Update line counts when sections grow/shrink significantly (>10 lines)
- Section line ranges help AI read only relevant portions
- Use `wc -l` or similar to get accurate counts

### Keeping Lines Updated

After significant edits:

```bash
# Get line count
wc -l docs/DESIGN.md

# Get section line numbers
grep -n "^## " docs/DESIGN.md
```

---

## Canonical Markers

Use `canonical_for` to establish source of truth:

```yaml
# In .premise
canonical_for:
  - entity-graph
  - data-relationships

# In docs/DESIGN.md frontmatter
canonical_for:
  - product-spec
  - data-models
  - ux-system
```

This tells AI:
- `.premise` is THE source for entity relationships
- `DESIGN.md` is THE source for product spec, data models, UX

When conflicts arise, canonical sources win.

---

## Dependency Tracking

Track how documents affect other files:

```yaml
dependencies:
  - source: design#data-models
    affects:
      - ../backend/supabase/migrations/*
      - ../.premise
    reason: Schema changes require migration updates
  
  - source: design#ux-system
    affects:
      - ../ios/AStar/Components/*
      - ../android/app/src/main/kotlin/com/astar/ui/*
      - ../web/src/components/*
    reason: UX patterns should be consistent across platforms
```

### Common Patterns

| Source | Typically Affects |
|--------|------------------|
| `#data-models` | Migrations, `.premise`, API types |
| `#ux-system` | Platform UI components |
| `#tech-stack` | Build configs, dependencies |
| `#api-spec` | Client SDKs, documentation |

---

## Tags for Discovery

Use consistent tags for searchability:

```yaml
tags: [architecture, product, data-models, ux]
```

### Recommended Tags

| Category | Tags |
|----------|------|
| Structure | architecture, monorepo, structure |
| Features | features, product, requirements |
| Data | data-models, schema, database, sql |
| UX | ux, navigation, design, accessibility |
| Tech | tech-stack, platforms, infrastructure |
| Process | roadmap, phases, priorities |

---

## Integration with Paradigm

### Syncing with .premise

The `.premise` file should reference its sync targets:

```yaml
# .premise
metadata:
  canonical_for: [entity-graph, data-relationships]
  syncs_with:
    - docs/DESIGN.md#data-models
    - backend/supabase/migrations/
```

### Syncing with .purpose

The `.purpose` file should reference its sync targets:

```yaml
# .purpose
canonical_for: [features, flows, signals]
syncs_with:
  - docs/DESIGN.md (feature descriptions)
  - .premise (entity references)
```

### Source of Truth Hierarchy

| Concept | Source of Truth | Syncs To |
|---------|----------------|----------|
| Entity relationships | `.premise` | DESIGN.md#data-models, migrations |
| Features & flows | `.purpose` | DESIGN.md (relevant sections) |
| Access control | `portal.yaml` | .purpose gate references |
| SQL schemas | DESIGN.md#data-models | migrations (implementation) |
| UX patterns | DESIGN.md#ux-system | platform components |

---

## Root Index

Projects should have a root `.index.yaml`:

```yaml
# .index.yaml (project root)
version: 1.0.0
description: Root index for the project
updated: YYYY-MM-DD

documents:
  - id: readme
    file: README.md
    title: Project Overview
    summary: Getting started and links
    tags: [overview, setup]
  
  - id: changelog
    file: CHANGELOG.md
    title: Changelog
    summary: Version history
    tags: [releases, history]

config_files:
  - id: premise
    file: .premise
    description: Entity graph
    canonical_for: [entity-graph]
  
  - id: purpose
    file: .purpose
    description: Features, flows, signals
    canonical_for: [features, flows]
  
  - id: portal
    file: portal.yaml
    description: Access control gates

subdirs:
  - path: docs/
    summary: Design and architecture documentation
    index: docs/.index.yaml
  - path: .paradigm/team/
    summary: Multi-agent handoff files
```

---

## Best Practices

### For AI Agents

1. **Always start with index** — never read full docs blindly
2. **Use line ranges** — read only needed sections
3. **Check canonical markers** — know which file is authoritative
4. **Follow dependencies** — update affected files together
5. **Update indexes** — keep line numbers reasonably accurate

### For Humans

1. **Add frontmatter** — all indexed docs need metadata
2. **Keep summaries current** — one-liners help AI navigate
3. **Use consistent tags** — improves discoverability
4. **Document dependencies** — prevents drift between files
5. **Run periodic audits** — verify line numbers stay accurate

---

## Keeping .cursorrules Slim

The `.cursorrules` file loads on **every chat**. Keep it minimal to preserve context for actual work.

### The Problem

| File Size | Est. Tokens | % of 200K Context |
|-----------|-------------|-------------------|
| 600 lines / 18KB | ~4,500 | 2.25% |
| 80 lines / 3KB | ~750 | 0.38% |

A bloated `.cursorrules` wastes thousands of tokens before you even type.

### The Solution

**Embed essentials, reference details.**

#### Keep in `.cursorrules` (~80 lines)

- Symbol quick reference table
- Logger method mapping table
- Key file locations
- Critical conventions (5-10 rules)
- Team handoff summary (3 lines)
- Table of pointers to full specs

#### Move to `.paradigm/specs/` (read on-demand)

- Full symbol documentation with examples
- Logger implementation patterns
- Changelog/commit format details
- Documentation navigation protocol
- Complete Team handoff documentation
- Source of truth hierarchy

### Measuring Context Cost

```bash
# Character count
wc -c .cursorrules

# Estimate tokens (chars ÷ 4)
echo "Tokens: $(( $(wc -c < .cursorrules) / 4 ))"
```

### Target: <1,000 tokens

| Metric | Bloated | Target |
|--------|---------|--------|
| Lines | 500+ | <100 |
| Characters | 15,000+ | <4,000 |
| Tokens | 4,000+ | <1,000 |

### Example Slim Structure

```markdown
# project - Paradigm Context

## Symbols (table)
## Logger Mapping (table)
## Key Files (table)
## Conventions (5 bullets)
## Team Handoff (3 lines)
## Specs (reference table)
```

See `.paradigm/docs/troubleshooting.md` for the full template.

---

## Example: Reading a Large Document

Instead of:
```
Read: docs/DESIGN.md (full 1000 lines)
→ 4000+ tokens used
```

Do this:
```
1. Read: docs/.index.yaml
   → Find: design#data-models at lines 531-770
   
2. Read: docs/DESIGN.md (lines 531-770)
   → Only 240 lines
   → ~1000 tokens used
   
3. Find related: dependencies show ./backend/migrations/*
   → Read only if making schema changes
```

**Result**: 75% fewer tokens, focused context, better results.
