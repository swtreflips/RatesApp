# UNFREEZE — remove frozen/sticky table headers (clean slate)

**Status:** Plan only — NOT implemented. Future task.
**Created:** June 21, 2026.

## Goal
Both table-like surfaces currently "freeze" their headers (header pinned while rows scroll inside a
bounded box). Start clean: embed both table types plainly so scrolling a long table lets the header
scroll away naturally (normal page scroll), no sticky/pinned panes. **Keep horizontal scrolling** for
wide tables (that's not the freeze — just prevents sideways overflow).

Root cause is the same in both: **a bounded height + an internal scroll**. Remove that and let the
page (`<main>`) scroll.

## Where it lives (two table types)
- **HTML tables → `ScrollTable`** ([DashboardPrimitives.jsx:104](src/components/ui/DashboardPrimitives.jsx#L104)):
  card with `overflow-auto` + `maxHeight:70vh` + `[&_thead_th]:sticky [&_thead_th]:top-0 …`.
  Used by [OpenRequests](src/features/internal/pages/OpenRequests.jsx#L112),
  [ReceivedRates](src/features/internal/pages/ReceivedRates.jsx#L71),
  [ActiveRates](src/features/forwarder/pages/ActiveRates.jsx#L73).
- **MUI DataGrid → `gridScrollHeight`** ([rateGrid.jsx:276](src/features/rates/rateGrid.jsx#L276)):
  caps grid height → internal scroll → MUI pins column headers.
  Used by [SubmitRates](src/features/forwarder/pages/SubmitRates.jsx#L316),
  [UploadRates](src/features/internal/pages/UploadRates.jsx#L377),
  [NewRateRequest](src/features/internal/pages/NewRateRequest.jsx#L310).

## Approach

### 1. HTML tables — replace `ScrollTable` with a plain `TableCard`
Rewrite to a plain card: **drop `maxHeight` and all sticky `thead` classes**; keep only
`overflow-x-auto` + `minWidth` so wide tables scroll sideways. Table sits in normal page flow;
scrolling the page scrolls the header off.

```jsx
// DashboardPrimitives.jsx
export function TableCard({ minWidth, children }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-fog-200 bg-white shadow-card">
      <table className="w-full text-left text-sm" style={minWidth ? { minWidth } : undefined}>
        {children}
      </table>
    </div>
  )
}
```
- **Rename** `ScrollTable` → `TableCard` (honest name now that it doesn't freeze) and update the 3
  imports/usages. Drop the `maxHeight` prop (no call site overrides it). Keep `minWidth`.
- *(Lower-churn alternative: keep the name `ScrollTable`, just strip the freeze internals — same
  behavior, no import changes. Rename is the cleaner clean-slate.)*

### 2. MUI DataGrid — use `autoHeight`, delete `gridScrollHeight`
Let each grid grow to fit its rows (no internal vertical scroll); the page scrolls and the column
header scrolls away.
- In [rateGrid.jsx](src/features/rates/rateGrid.jsx): **remove the `gridScrollHeight` export** (+ its
  doc comment). Keep `DATA_GRID_SX` — its `columnHeaders` rules are cosmetic (bg/border), not the
  freeze.
- In the 3 grid pages: remove `height: gridScrollHeight(rows.length)` from the `sx`, drop the
  `gridScrollHeight` import, add the **`autoHeight`** prop to `<DataGrid>`:
  - [SubmitRates.jsx:316](src/features/forwarder/pages/SubmitRates.jsx#L316) — `sx={{ ...DATA_GRID_SX }}` + `autoHeight`
  - [UploadRates.jsx:377](src/features/internal/pages/UploadRates.jsx#L377) — same
  - [NewRateRequest.jsx:310](src/features/internal/pages/NewRateRequest.jsx#L310) — drop `height`, keep its local `columnHeaders` sx, add `autoHeight`
- **Verify:** confirm `autoHeight` behaves as expected in `@mui/x-data-grid` v8 (grows to content, no
  inner scroll). If v8 changed/deprecated it, fall back to wrapping the grid in a parent with no fixed
  height so it expands. (Build + visual check covers this.)

## Files touched
- `src/components/ui/DashboardPrimitives.jsx` (ScrollTable → TableCard)
- `src/features/internal/pages/OpenRequests.jsx`, `ReceivedRates.jsx`,
  `src/features/forwarder/pages/ActiveRates.jsx` (import/usage rename)
- `src/features/rates/rateGrid.jsx` (remove `gridScrollHeight`)
- `src/features/forwarder/pages/SubmitRates.jsx`, `src/features/internal/pages/UploadRates.jsx`,
  `NewRateRequest.jsx` (autoHeight; drop height + import)

## Verification
1. `npm run build` green (no leftover `gridScrollHeight` / `ScrollTable` references).
2. **OpenRequests / ReceivedRates / ActiveRates:** with rows exceeding the viewport, scrolling the
   page moves the header **off-screen** (no longer pinned); wide tables still scroll sideways.
3. **SubmitRates / UploadRates / NewRateRequest:** grid grows to fit all rows (no inner scrollbar);
   scrolling the page scrolls the header away; add/remove row resizes the grid; editing/CSV upload
   still work.
4. No regression to card styling (border/shadow/rounded) or DataGrid cell/header look.

## Notes
- Pure frontend; ships via `git push main` → Vercel.
- No stored memory existed of the original sticky-header change; this is reconstructed from current code.
