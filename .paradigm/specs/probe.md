# Paradigm Probe Protocol

The Paradigm Probe protocol enables **visual discovery** — AI agents can analyze screenshots or mockups and map visual elements to code using the Paradigm symbol system.

---

## How It Works

1. User attaches an image (screenshot, mockup, diagram)
2. User says "paradigm probe" (or a variant)
3. AI analyzes the image and identifies visual elements
4. AI cross-references with `.paradigm/probe-index.json`
5. AI returns structured mapping of UI → code

---

## Triggering a Probe

| Command | Use Case |
|---------|----------|
| `paradigm probe` | Default — map any image to code |
| `paradigm probe ui` | Screenshot of running app |
| `paradigm probe design` | Mockup or design file — gap analysis |
| `paradigm probe error` | Error screenshot — find handlers |
| `paradigm probe arch` | Architecture diagram — map to features |
| `paradigm probe flow` | Flow diagram — match to `$flow` definitions |
| `paradigm probe diff` | Two images — show what changed |

---

## Probe Index

The probe index at `.paradigm/probe-index.json` contains:

```json
{
  "$meta": {
    "version": "1.0.0",
    "project": "my-app",
    "generatedAt": "2026-01-14T00:00:00Z"
  },
  "components": {
    "Button": {
      "symbol": "#Button",
      "path": "src/components/Button.tsx",
      "visualTags": ["button", "action"],
      "description": "Primary action button"
    }
  },
  "features": {
    "checkout": {
      "symbol": "#checkout",
      "tags": ["feature"],
      "path": "src/features/checkout/",
      "description": "Purchase completion flow"
    }
  },
  "flows": {
    "checkout-flow": {
      "symbol": "$checkout-flow",
      "steps": ["cart", "shipping", "payment", "confirmation"]
    }
  },
  "gates": {
    "auth-required": {
      "symbol": "^auth-required",
      "description": "User must be logged in"
    }
  },
  "symbolMap": {
    "#checkout": { "category": "features", "id": "checkout" },
    "#Button": { "category": "components", "id": "Button" }
  }
}
```

Generate or update with:
```bash
paradigm index
```

---

## Probe Result Format

When responding to a probe request, format results as:

```markdown
## 🔭 Paradigm Probe Results

### Components
| Element | Symbol | Path | Confidence |
|---------|--------|------|------------|
| Primary Button | `#Button` | `src/components/Button.tsx` | ●●●● |
| Price Display | `#PriceDisplay` | `src/components/PriceDisplay.tsx` | ●●●○ |

### Features
- **`#checkout`** `[feature]` — Handles the checkout process shown in the image

### Flows
- **`$checkout-flow`** — Steps: cart → shipping → **payment** ← (current) → confirmation

### Gates
- `^auth-required` — User must be logged in to access this screen

### ⚠️ Uncovered Elements
- The "Apply Coupon" input doesn't have a mapped component
- Consider creating `#CouponInput` component
```

---

## Confidence Levels

| Level | Display | Meaning |
|-------|---------|---------|
| High | ●●●● | Visual element clearly matches component name/tags |
| Medium | ●●●○ | Likely match based on context |
| Low | ●●○○ | Possible match, needs verification |
| Tentative | ●○○○ | Best guess, may be incorrect |

---

## Visual Tags

Components can have visual tags to improve matching:

| Tag | Elements |
|-----|----------|
| `button` | Buttons, clickable actions |
| `form` | Forms, input groups |
| `input` | Text inputs, selects, checkboxes |
| `card` | Card containers |
| `list` | Lists, tables, grids of items |
| `modal` | Dialogs, overlays, drawers |
| `nav` | Navigation elements |
| `header` | Header sections |
| `footer` | Footer sections |
| `sidebar` | Side navigation |
| `hero` | Hero sections |
| `chart` | Data visualizations |
| `avatar` | User avatars |
| `badge` | Badges, tags, pills |
| `menu` | Menus, dropdowns |
| `tab` | Tab navigation |
| `toast` | Notifications, alerts |
| `spinner` | Loading indicators |
| `skeleton` | Loading placeholders |

---

## After Probing

Once results are returned, users can:

1. **Reference specific items**: "I want to modify `#CheckoutButton`"
2. **Ask about flows**: "Walk me through `$checkout-flow`"
3. **Check gates**: "What permissions does `^premium-checkout` require?"
4. **Explore components**: "What uses `#cart-store`?"
5. **Fill gaps**: "Create a `#CouponInput` component for the uncovered element"

---

## Keeping Index Fresh

```bash
# Regenerate probe index
paradigm index

# Watch for changes and auto-update
paradigm watch
```

The index should be regenerated when:
- Adding new `.purpose` files
- Modifying `portal.yaml`
- Adding new components or features
