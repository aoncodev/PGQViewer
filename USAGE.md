# PGQViewer — User Manual

A practical guide to driving PGQViewer day-to-day. For project background, architecture, and limitations, see [README.md](./README.md).

PGQViewer is a community **graph viewer**: pick a property graph, run a query, explore the result on a canvas. It deliberately does not include a graph designer, notebook, path finder, privileges UI, or schema diff — those features were removed when the project refocused on doing one thing well.

---

## Contents

- [Quick start](#quick-start)
- [Connecting](#connecting)
- [Schema browser](#schema-browser)
- [Query editor](#query-editor)
  - [Graph mode](#graph-mode)
  - [SQL mode](#sql-mode)
- [Result tabs](#result-tabs)
- [Graph canvas](#graph-canvas)
  - [Layouts](#layouts)
  - [Canvas toolbar](#canvas-toolbar)
  - [Canvas footer & caption picker](#canvas-footer--caption-picker)
  - [Expand-on-click](#expand-on-click)
- [Theming](#theming)
- [Exports](#exports)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Common errors](#common-errors)
- [Tips & tricks](#tips--tricks)

---

## Quick start

1. Point PGQViewer at any PostgreSQL 19 server that has at least one `CREATE PROPERTY GRAPH …` defined. Bring your own DB — the viewer assumes the schema and graphs already exist.
2. Launch the app — `pnpm dev`, then open <http://localhost:5173> in a browser (or `docker compose up` and open <http://localhost:8080>).
3. Fill in the connection form (host, port, database, user, password) and click **Connect**.
4. Pick a property graph from the left sidebar.
5. Run the suggested `MATCH` pattern in the editor or write your own. Press **⌘/Ctrl+Enter** to execute.

---

## Connecting

The connection screen has two panes:

- **Saved connections** (left) — every profile you've stored. Click any card to open a session immediately. Hover and click **✕** to remove. The search box filters by name / host / database.
- **New connection** (right) — fields for host, port, database, user, password, and SSL mode. Tick **Save this connection** with a non-empty name to persist the profile (passwords are currently stored in plaintext in the local SQLite app DB — see README for the keychain roadmap item).

### Session persistence

PGQViewer remembers your last session in `localStorage`. After F5 / page reload, a **Reconnecting…** splash briefly pings the server; if the pool is still alive you land back where you were. If it's gone, the form returns with a toast explaining the session expired.

### Disconnecting

The Disconnect button is the red power icon in the **Connection card** at the top of the left sidebar. It closes the server-side pool, wipes the canvas / table state, and clears the saved session id.

---

## Schema browser

The left sidebar has three sections, top to bottom:

1. **Connection card** — current host/port/database label with the disconnect power icon. A pulsing accent-coloured dot signals the live pool.
2. **Property graphs** — every graph visible to your role (`pg_class WHERE relkind='g'`). Click to select; the rest of the UI pivots onto it. If exactly one graph is visible PGQViewer auto-selects it.
3. **Schema** — once a graph is selected, vertex and edge elements appear, grouped under **Vertices** and **Edges** headings.

The whole sidebar is **resizable** — drag the splitter on its right edge, or double-click the splitter to reset. The chevron button collapses it to a narrow rail.

### Filtering

A search box at the top of the **Schema** section filters elements by alias, label, or property name. Matching is case-insensitive substring.

### Element rows

Each row shows:

- A **coloured dot** keyed by the element's first label (deterministic per label, stable across themes). Click it to open an inline **colour picker** and override that label's colour for both the sidebar and the canvas. Overrides persist to `localStorage`.
- The **element alias** (bold). Clicking the alias drops a ready-to-edit `MATCH` snippet into the editor:
  - Vertices: `(a IS person)` — replaces the current pattern.
  - Edges: `(a IS person)-[k IS knows]->(b IS person)` — with auto-inferred source/destination labels.
- A **row-count chip** on the right (approximate, from PG's `reltuples`).
- A **chevron** to expand the row. Expanded rows show declared labels, source/destination labels (for edges), and every declared property as a small `name type` chip. Hover a chip to see its full type and any generation expression.

A subtle preview line directly under each collapsed row summarises labels and property count, so you rarely have to expand.

---

## Query editor

The editor is CodeMirror 6 with PostgreSQL syntax + PG19 SQL/PGQ keyword completion. The toolbar above it toggles two modes:

### Graph mode

Use `MATCH` patterns; PGQViewer auto-projects every declared property and primary/foreign key column needed to reconstruct identity client-side.

```
(a IS person)-[k IS knows]->(b IS person)
```

Rules of thumb:

- Bindings are recognised by the `(alias IS label)` and `[alias IS label]` forms. The label must be one declared on a vertex / edge element of the current graph.
- Label names are case-folded by PostgreSQL — `Person` and `person` resolve to the same identifier unless you quoted them at `CREATE PROPERTY GRAPH` time.
- One path per `MATCH`. PG19 rejects comma-separated paths.
- Multi-line is fine; whitespace is ignored:

  ```
  (a IS employee)
    -[k IS worksin]->
    (b IS department)
  ```

- A WHERE clause inside an element filler is allowed:

  ```
  (a IS employee WHERE a.salary > 150000)-[k IS reportsto]->(b)
  ```

- The auto-suggested pattern uses the first vertex + first edge of the graph; replace it freely.
- The fastest way to start a new pattern is to **click an element in the schema browser** — it drops a ready-to-edit snippet here.

### SQL mode

Runs whatever you type verbatim. Use this for:

- Complex queries that combine multiple `GRAPH_TABLE(…)` calls with `JOIN`.
- Ordinary table introspection: `SELECT * FROM …`, recursive CTEs over the underlying rows, etc.
- `EXPLAIN`, `EXPLAIN ANALYZE`, `SET LOCAL …`.

A **Parameters** drawer below the editor accepts a JSON array — values are bound positionally to `$1`, `$2`, … in the SQL.

### Running

- **Run** — executes against the live session. While running, the button morphs into a red **Cancel** that calls `pg_cancel_backend(pid)` on the underlying backend (useful for runaway queries).
- The editor itself is **resizable** — drag the splitter immediately below the textarea, or double-click it to reset to the default height.

### Error hints

If PG returns a known SQL/PGQ error, an inline hint appears below the editor explaining what went wrong and how to work around the limitation. Examples:

- *element pattern quantifier is not supported* → PG19 has no `*` / `+` / `{m,n}`; rewrite as a recursive CTE in SQL mode.
- *property X does not exist* → not declared on the element; pick from the declared list shown in the sidebar.
- *multiple path patterns in one GRAPH_TABLE clause not supported* → split into separate `GRAPH_TABLE` calls joined in SQL.

---

## Result tabs

Below the editor, three tabs render the result set:

- **Graph** — Cytoscape canvas (graph mode only).
- **Table** — sortable / filterable / paginated grid of rows (SQL mode).
- **JSON** — copy-paste-friendly dump (`{vertices, edges}` for graph mode, `{columns, rows}` for SQL mode).

A footer below the tabs shows the last query's row / vertex / edge counts and elapsed time.

### Table tab

- Click a column header to toggle sort (asc → desc → none).
- The second header row hosts per-column substring filters.
- The visible window starts at 200 rows; **Load more** extends it 200 at a time.
- **Export CSV** and **Export JSON** buttons live in the footer.

### JSON tab

A toolbar in the top-right offers **Copy**, plus mode-dependent exports:

- Graph mode → **GraphML** (`.graphml`) and **Cypher** (`MERGE`-based, idempotent).
- SQL mode → **CSV**, **JSON**.

---

## Graph canvas

Cytoscape with nine selectable layouts, deterministic colors per label, labels rendered outside nodes, degree-based node sizing, and fanning for parallel edges.

### Layouts

The top-right of the canvas hosts a **layout dropdown** with nine options:

| Layout | Notes |
| --- | --- |
| Force (fcose) | Default. Best general-purpose force-directed layout. |
| Force (cola) | Constraint-based; smoother on dense subgraphs. |
| Force (cose) | Classic Cytoscape force layout; lightweight. |
| Hierarchy (dagre) | Top-down DAG / tree layout — pick this for ancestry, org charts, dependency graphs. |
| Concentric | Higher-degree nodes pulled to the centre; good for hub-and-spoke. |
| Breadth-first | BFS tree rooted at the highest-degree node. |
| Circle | Every node on a ring. |
| Grid | Even rows × columns. |
| Random | Sanity check / starting point for manual arrangement. |

Your choice is persisted to `localStorage` under `pgviewer.graph.layout`.

### Canvas toolbar

Next to the layout dropdown:

- **Zoom in / zoom out** — clamped to 0.2× – 3×.
- **Fit** — re-centres and zooms to fit the current contents.
- **Re-run layout** — re-runs whichever layout is currently selected (handy after dragging nodes, or to nudge the layout back to its tidy state).
- **PNG** — exports the full graph as a 2×-scale PNG with the current theme background.
- **JPG** — same, quality 0.92.

Both image exports trigger a browser download with a timestamped filename (`pgqviewer-graph-<ms>.png` / `.jpg`).

### Canvas footer & caption picker

The bar at the bottom of the canvas shows:

- **Selection details** — when a node or edge is selected: its labels, source → destination (for edges), and every property. Properties render as compact name/value pairs.
- **Caption picker** — for selected vertices: a dropdown listing every declared property of that label. The chosen property becomes the **visible vertex label** for *every* node carrying that label, across the canvas. Click "×" to clear and fall back to the default heuristic (name / title / label / display_name / id / uuid / key).
- **Totals** — node count and edge count on the right.

Caption choices persist per-label to `localStorage`, so the next time you open a graph the labels you picked still apply.

### Interactions

- **Drag** — move a node; the rest of the layout adjusts. Dragged nodes stay pinned until the next layout re-run.
- **Scroll** — zoom (0.2× – 3×).
- **Click** — select a node / edge; details appear in the footer.
- **Hover a node** — a small **Expand** pill appears next to it (see below).
- **Pan / zoom** — dismisses the expand pill.

### Expand-on-click

Hover any node and an **Expand** pill appears beside it. Click the pill, or **double-click the node**, to fetch its 1-hop neighbourhood via the server's `/expand` endpoint. New vertices and edges merge into the canvas with the same dedup IDs (`<element_oid>:<pk_value>`), so repeated expansions don't duplicate elements. The current layout re-runs to absorb the new geometry.

---

## Theming

PGQViewer ships a single OKLCH-based token system; node and edge colors retune per theme so the same label keeps the same perceived identity hue in both modes.

- **Light / dark** — toggle in the top-right of the header.
- **Accent palette** — three options (salad-green, neon-cyan, neon-pink) via the palette picker in the header.
- **Per-label override** — open the sidebar's inline colour picker on any element row.

Theme and palette choices persist via `localStorage` and re-apply on the next launch.

---

## Exports

| Surface | Formats |
| --- | --- |
| Table tab | CSV, JSON |
| JSON tab — SQL mode | CSV, JSON |
| JSON tab — graph mode | JSON, GraphML, Cypher |
| Canvas | PNG, JPG |

GraphML output uses `n_` / `e_` prefixes on property keys to avoid node/edge key collisions. Cypher output uses idempotent `MERGE` statements with back-tick quoting; you can re-run the file safely.

---

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| ⌘/Ctrl + Enter | Run query |
| ⌘/Ctrl + K | Open command palette |
| Esc | Close any open modal / dropdown |
| ↑ / ↓ | Navigate command palette |
| Tab | Indent inside the editor |
| ⌘/Ctrl + F | Editor: find |
| ⌘/Ctrl + Z / Shift+Z | Editor: undo / redo |

The command palette exposes the theme toggle, the accent-palette switches, and a "Switch graph" action per visible property graph. Type to filter.

---

## Common errors

Most of these surface as in-app hint banners. The full list of patterns lives in `apps/renderer/src/lib/errors.ts`.

- **`element pattern quantifier is not supported`** — PG19 has no `*` / `+` / `{m,n}`. Rewrite as a recursive CTE in SQL mode.
- **`multiple path patterns in one GRAPH_TABLE clause not supported`** — split each path into its own `GRAPH_TABLE(…)` call and join them in SQL.
- **`"*" is not supported here`** — `COLUMNS` requires explicit declared property names. PGQViewer auto-projects them in graph mode; in raw SQL list them yourself.
- **`property X does not exist`** — not declared on the element. Recreate the graph with `PROPERTIES ALL COLUMNS`, or pick from the declared list shown in the sidebar.
- **`label X does not exist in property graph Y`** — typo or wrong graph selected; check the schema panel for available labels.
- **`source key columns […] are not declared as properties`** — your `CREATE PROPERTY GRAPH` didn't expose the FK columns. Fix: recreate the graph with `PROPERTIES ALL COLUMNS`, or list the FK columns explicitly inside `PROPERTIES (…)`.
- **`property graphs cannot be unlogged`** — drop `UNLOGGED` from your `CREATE` statement.

If you hit an error not in this list, copy the message into a GitHub issue — patterns are easy to add.

---

## Tips & tricks

- The canvas dedupes by `<element_oid>:<pk_value>`. Run several queries in a row and they merge into one view. Re-running a query with `Run` clears the prior result first.
- Drag a node to pin it; subsequent re-layouts respect the position until you hit **Re-run layout** in the canvas toolbar.
- Pick a layout that matches the shape of your data — `dagre` for trees / DAGs, `concentric` for hub-and-spoke, `fcose` for everything else.
- The caption picker in the canvas footer lets you ask "what should a Person look like?" once and have every Person in the view follow suit.
