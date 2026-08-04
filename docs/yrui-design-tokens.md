# YRUI Design Tokens

This document explains how to work with `ios/Packages/YRUI/Sources/YRUI/DesignTokens.swift`.

## Purpose

`DesignTokens.swift` is the single source of truth for reusable visual values in `YRUI`.

That includes:

- palette colors
- spacing
- sizing
- radii
- typography
- shadows
- semantic opacities

If a value is reused or is conceptually part of the design language, it belongs in tokens instead of being hard-coded inside a view.

## Core rule

Choose tokens by semantic meaning, not by how they happen to look today.

Good:

- `Palette.statusLiveFill` for a live-state chip
- `Palette.noteFill` for operational notes
- `Metrics.actionButtonMinHeight` for action controls

Bad:

- picking `paperStrong` just because it "looks nice here"
- reusing `tomatoSoft` on a neutral card because the hue feels warm

## Token groups

### `Palette`

Use for semantic colors and surfaces.

Important categories in this repo:

- workspace/background surfaces
- content/card surfaces
- structural lines and highlights
- semantic status colors
- note and provider badge colors
- completed/incomplete row styling

Palette values should be chosen by role:

- `paper`, `workspaceSurface`: shell and board background surfaces
- `cardSurface`, `surfaceSubtle`, `surfaceStrong`: local panels and card layers
- `ink`, `inkMuted`, `inkSoft`: text hierarchy
- `mint`, `amber`, `tomato`: status and urgency

### `Metrics`

Use for all repeatable sizing and spacing.

Important categories:

- shell spacing
- sidebar width and padding
- board canvas padding
- ticket and row geometry
- action/button sizing
- empty-state sizing

If a view starts using the same literal `CGFloat` more than once, it is usually a token candidate.

### `Typography`

Use for all repeated font roles.

Current patterns:

- major ticket title
- timer and metadata chips
- sidebar metrics
- item names and supporting text
- empty-state hierarchy
- action buttons

Avoid mixing ad-hoc `Font.system(...)` calls throughout view files unless the font is truly one-off and local.

### `Shadows`

Keep shadows subtle and role-based.

Use separate shadow tokens when two surfaces need different visual weight, for example:

- ticket cards
- sidebar shell
- board canvas

Do not increase shadow intensity casually; KDS UI should feel layered, not glossy.

### `Opacity`

Use for semantic de-emphasis, especially completed states.

Examples:

- completed text
- completed detail copy
- completed modifier chips

### `Urgency`, `ModifierChip`, and `ItemToggle`

These are semantic token helpers, not just storage:

- `Urgency` maps ticket age to accent and border styling
- `ModifierChip` maps modifier meaning to chip tone
- `ItemToggle` centralizes completion control appearance

Preserve their semantic role. Do not turn them into generic style buckets.

## Editing rules

### Add a token when:

- the value is reused
- the value represents a design role
- changing it in one place should update the whole UI consistently

### Do not add a token when:

- the value is a truly local one-off
- the semantic meaning is still unclear
- the value only exists because of temporary experimentation

### Do not bypass tokens in views

Inside `YRUI` views, avoid new raw values like:

- `Color(red: ...)`
- repeated literal spacing values
- repeated custom corner radii
- repeated font declarations

If you need one, add or extend a token first.

## Safe ways to evolve tokens

When adjusting tokens:

1. update the token, not every call site
2. keep semantic names stable where possible
3. run the narrowest relevant `swift test`
4. visually verify the affected UI on iPad layouts when the change is structural

## Project-specific invariants

These token expectations should hold unless the product direction changes:

- content surfaces remain plain and high-contrast
- urgency colors stay reserved for real urgency/state
- the board remains optimized for scan speed
- sidebar and ticket geometry remain iPad-first
- completed states become quieter without becoming unreadable

## When to create a new token namespace

Create or extend a semantic subgroup when a role has enough weight to justify it, such as:

- a new family of operational status chips
- a new group of empty-state surfaces
- a distinct class of action button styles

Do not create namespaces that mirror individual screens too narrowly unless they represent a real reusable system.
