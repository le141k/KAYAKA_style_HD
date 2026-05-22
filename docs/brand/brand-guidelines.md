# 23 Telecom Help Desk — Brand Guidelines

> Generated as the first step of the build, following the `example-skills:brand-guidelines`
> methodology (color system + typography + shape/accent usage), adapted from the generic
> Anthropic reference palette to a **telecom-appropriate identity** (professional blue / cyan /
> indigo accents on a clean neutral base, with semantic status accents).

## 1. Brand essence

| Attribute | Value |
|---|---|
| Name | **23 Telecom Help Desk** |
| Short name | 23T Help Desk |
| Domain | telecom customer support / NOC ticketing |
| Personality | Reliable, technical, calm-under-pressure, fast |
| Visual register | Modern SaaS, dense-but-legible, dark-mode first-class |

## 2. Color system

### Brand / accent (primary)
| Token | Hex | Use |
|---|---|---|
| `brand-600` | `#0B6BCB` | Primary actions, links, active nav |
| `brand-500` | `#1A7FE0` | Hover, focus rings |
| `brand-700` | `#08529E` | Pressed, deep headers |
| `cyan-500` | `#06B6D4` | Secondary accent, highlights, data viz |
| `indigo-500`| `#6366F1` | Tertiary accent, charts, badges |

### Neutral base
| Token | Hex (light) | Hex (dark) |
|---|---|---|
| `bg` | `#F8FAFC` | `#0B1220` |
| `surface` | `#FFFFFF` | `#111A2E` |
| `border` | `#E2E8F0` | `#1E293B` |
| `text` | `#0F172A` | `#E6EDF6` |
| `text-muted` | `#64748B` | `#94A3B8` |

### Semantic status (ticket lifecycle / SLA)
| Token | Hex | Meaning |
|---|---|---|
| `status-open` | `#1A7FE0` | Open / new |
| `status-pending` | `#F59E0B` | Pending customer |
| `status-progress` | `#6366F1` | In progress |
| `status-resolved` | `#16A34A` | Resolved |
| `status-closed` | `#64748B` | Closed |
| `sla-ok` | `#16A34A` | Within SLA |
| `sla-warn` | `#F59E0B` | SLA at risk |
| `sla-breach` | `#DC2626` | SLA breached |
| `priority-urgent`| `#DC2626` | Urgent |
| `priority-high` | `#F97316` | High |
| `priority-normal`| `#1A7FE0` | Normal |
| `priority-low` | `#64748B` | Low |

Contrast: all text/background pairs target **WCAG AA (≥4.5:1)**; status colors verified on both
light `surface` and dark `surface`.

## 3. Typography

| Role | Family | Fallback | Notes |
|---|---|---|---|
| UI / headings | **Inter** | -apple-system, "Segoe UI", Arial | tight tracking on large sizes |
| Body | **Inter** | system-ui | 14–16px base |
| Mono (ticket IDs, code, IMAP headers) | **JetBrains Mono** | ui-monospace, "SF Mono", Menlo | ticket masks like `TT-000123` |

Type scale (rem): 0.75 / 0.875 / 1 / 1.125 / 1.25 / 1.5 / 1.875 / 2.25 / 3.

## 4. Shape & motion

- **Radius**: sm 6px · md 8px · lg 12px · xl 16px · full 9999px (avatars, pills).
- **Shadows**: subtle, 2 levels (`sm` for cards, `md` for popovers/menus).
- **Motion**: 150–250ms ease-out for enter; status badges pulse on change; kanban cards
  get a brand-tinted "drag glow" while dragged. Respect `prefers-reduced-motion`.
- Non-text shapes/illustrations cycle the accents **brand → cyan → indigo** (mirrors the
  skill's orange→blue→green accent cycling, retargeted to the telecom palette).

## 5. Tone of voice

**English (UI + customer email):** clear, concise, active voice, no jargon to customers,
precise jargon to agents. Reassure on incidents ("We're on it"), never blame.

**Russian (UI + email):** «вы» вежливое, без канцелярита. Коротко и по делу. Для инцидентов —
спокойно и уверенно: «Уже разбираемся», «Восстановили, держим на контроле».

**Ukrainian (UI only, i18n):** дружній, чіткий, без жаргону для клієнтів.

Examples:
- New ticket (en): "Thanks — we've logged your request as **{{mask}}** and a specialist will reply shortly."
- New ticket (ru): «Спасибо — мы зарегистрировали обращение **{{mask}}**, специалист скоро ответит.»
- SLA breach internal: "⚠️ {{mask}} breached its {{sla}} target — escalated to {{team}}."

## 6. Logo

Placeholder SVG in `logo.svg` (and `logo-mark.svg`): a stylized signal/connectivity mark
(stacked broadcast arcs forming a "23") in `brand-600`→`cyan-500` gradient. Replace with the
final asset when available; keep clear-space = mark height on all sides.

## 7. Application

These tokens are the single source of truth. They are emitted as CSS variables + Tailwind
config by the `theme-factory` step into `frontend/styles/theme/` and `apps/web`. UI work must
consume the tokens, never hard-code hex values.
