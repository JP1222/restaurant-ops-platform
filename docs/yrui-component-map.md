# YRUI Component Map

This document explains how `ios/Packages/YRUI/Sources/YRUI` is structured today and where future UI work should land.

Use it together with:

- [YRUI Design Tokens](yrui-design-tokens.md)

## Purpose

`YRUI` is the SwiftUI presentation package for the board experience.

It should own:

- screen composition
- iPad-first layout
- visual hierarchy
- view-local interaction wiring
- pure presentation mapping that helps the UI read data

It should not own:

- networking
- persistence
- realtime transport
- cross-layer business orchestration

Those responsibilities stay in lower layers and flow into `YRUI` through `YRCore` models and `YRBoard.BoardStore`.

## Current file map

### `BoardView.swift`

Owns the board screen shell.

Responsibilities:

- reads `BoardStore` from the environment
- applies outer safe-area-aware shell spacing
- composes the two major regions: `BoardSidebar` and `BoardCanvas`
- computes usable width for ticket column layout
- renders the board empty state when there are no active tickets

Subviews in this file:

- `BoardView`
- `BoardCanvas`
- `BoardEmptyStateCard`
- `EmptyStateMetricTile`

Use this file when changing:

- board-level spacing and shell composition
- canvas placement relative to sidebar
- empty-state card layout
- ticket column count logic

### `BoardSidebar.swift`

Owns the left control rail.

Responsibilities:

- renders top-level board metrics such as open count and average time
- renders board-status details such as recall, connection state, and local time
- keeps the sidebar grouped into clear operating zones

Subviews in this file:

- `BoardSidebar`
- `SidebarMetricTile`
- `SidebarDetailRow`

Use this file when changing:

- sidebar section order
- sidebar metric hierarchy
- status chip composition
- bottom utility button placement

### `TicketCard.swift`

Owns the main per-ticket work unit.

Responsibilities:

- renders one live order card
- computes urgency-driven visual emphasis
- groups header, provider context, note, items, and actions
- wires ticket-level actions to `BoardStore`

Subviews in this file:

- `TicketCard`
- `TicketHeader`
- `ProviderRow`
- `TicketNote`
- `TicketActions`
- `TicketMetaChip`

Use this file when changing:

- ticket information hierarchy
- header controls
- provider/source treatment
- note styling
- action button layout and visual priority

### `ItemRow.swift`

Owns one kitchen work item inside a ticket.

Responsibilities:

- renders quantity, title, note, modifiers, and completion control
- wires row toggles to `BoardStore.toggleItem`
- applies completed vs active row styling

Subviews in this file:

- `ItemRow`
- `ModifierChip`

Use this file when changing:

- quantity emphasis
- completed-row de-emphasis
- modifier presentation
- completion toggle size or affordance

### `BoardPresentation.swift`

Owns pure presentation helpers used by multiple views.

Responsibilities:

- sorting and chunking active tickets
- formatting average elapsed time and created-at labels
- mapping elapsed time to urgency
- mapping realtime state to connection and empty-state presentation
- computing provider labels and styles
- choosing the display name for ticket items

Supporting types in this file:

- `ConnectionPresentation`
- `BoardEmptyStatePresentation`
- `ProviderStyle`

Use this file when changing:

- empty-state copy by connection state
- connection labels or semantic colors
- ticket urgency thresholds
- provider label rules
- display/formatting logic reused across multiple views

Do not put reusable presentation mapping directly inside view `body` trees when it belongs here.

### `DesignTokens.swift`

Owns the reusable visual system for `YRUI`.

Main namespaces:

- `Palette`
- `Metrics`
- `Typography`
- `Shadows`
- `Opacity`
- `Urgency`
- `ModifierChip`
- `ItemToggle`

Use this file when changing:

- colors and surfaces
- spacing and sizing
- radii
- typography
- semantic urgency or modifier tones

If a view repeats a raw visual value, it usually belongs here instead.

### `FlowLayout.swift`

Owns a tiny reusable layout primitive.

Responsibilities:

- wraps modifier chips in flowing lines
- keeps chip arrangement out of `ItemRow` layout code

Use this file only when the wrapping behavior itself needs to change.

## Render flow

The board currently renders in this order:

1. `BoardView` reads `BoardStore` from the environment.
2. `BoardView` computes the shell and hands data into `BoardSidebar` and `BoardCanvas`.
3. `BoardCanvas` asks `BoardPresentation` for sorted active tickets.
4. `BoardCanvas` either:
   - shows `BoardEmptyStateCard`, or
   - chunks tickets into columns and renders `TicketCard` instances.
5. Each `TicketCard` renders:
   - `TicketHeader`
   - `ProviderRow`
   - optional `TicketNote`
   - `ItemRow` for each ticket item
   - `TicketActions`
6. Each `ItemRow` can call `BoardStore.toggleItem`.
7. `TicketActions` can call `BoardStore.advance` and `BoardStore.complete`.

## Component tree

```text
BoardView
|- BoardSidebar
|  |- SidebarMetricTile
|  `- SidebarDetailRow
`- BoardCanvas
   |- BoardEmptyStateCard
   |  `- EmptyStateMetricTile
   `- TicketCard
      |- TicketHeader
      |  `- TicketMetaChip
      |- ProviderRow
      |- TicketNote
      |- ItemRow
      |  `- ModifierChip
      `- TicketActions
```

## Where to edit common changes

### Change board shell spacing or safe-area behavior

Edit:

- `BoardView.swift`
- `DesignTokens.swift`

Typical examples:

- reduce shell padding
- widen the sidebar
- change canvas corner radius
- rebalance board vs sidebar gap

### Change empty-state wording or connection semantics

Edit:

- `BoardPresentation.emptyStatePresentation(for:)`
- `BoardPresentation.connectionPresentation(for:)`

If the structure of the empty-state card also changes, update `BoardEmptyStateCard` in `BoardView.swift`.

### Change ticket sorting, urgency, or elapsed labeling

Edit:

- `BoardPresentation.sortedActiveTickets(_:)`
- `BoardPresentation.urgency(for:now:)`
- `BoardPresentation.averageElapsedLabel(for:now:)`
- `BoardPresentation.preciseElapsedLabel(for:now:)`

Keep this logic out of `TicketCard` and `BoardSidebar` unless it is truly local-only.

### Change sidebar layout or metric grouping

Edit:

- `BoardSidebar.swift`

Use `DesignTokens` for repeated spacing, color, or typography changes.

### Change card chrome, note styling, or action hierarchy

Edit:

- `TicketCard.swift`

Examples:

- de-emphasize close/more controls
- adjust timer chip prominence
- change note callout treatment
- restyle primary vs secondary action buttons

### Change row scan speed or completion treatment

Edit:

- `ItemRow.swift`
- `DesignTokens.ItemToggle`
- `DesignTokens.Opacity`

Examples:

- increase quantity block weight
- soften completed rows further
- enlarge the completion affordance

### Change modifier color mapping

Edit:

- `DesignTokens.ModifierChip`
- `DesignTokens.ModifierChip.classify(_:)`

Do not bury modifier keyword logic inside `ItemRow`.

## Placement rules

### Put logic in `BoardPresentation` when:

- it formats or derives display data
- multiple views need the same mapping
- it does not need view-local state

### Keep logic in the view when:

- it is purely structural layout
- it is a one-off local visual decision
- it directly wires a user action to `BoardStore`

### Put values in `DesignTokens` when:

- the value is reused
- the value is semantic
- a future redesign should be able to change it centrally

### Do not add to `YRUI`:

- networking clients
- persistence reads/writes
- websocket reconnect logic
- contract DTO definitions

`YRUI` may depend on `YRCore` and `YRBoard`, but not on lower implementation modules.

## Editing heuristics

When adding or refactoring UI in `YRUI`:

1. Start from the owning screen file, not from `DesignTokens.swift`.
2. Decide whether the change is structural, presentational, or token-level.
3. Move reusable label/status mapping into `BoardPresentation`.
4. Move reusable visual values into `DesignTokens`.
5. Keep `BoardView` as the stable root shell unless the overall board layout is intentionally changing.

## Validation habit

For most `YRUI` changes, the default check is:

```bash
swift test --package-path ios/Packages/YRUI
```

For visual changes, also review:

- empty state
- one-ticket state
- multi-ticket state
- long order labels
- long modifier chips
- 11-inch and 13-inch iPad landscape layouts
- Dynamic Type growth on buttons and chips
