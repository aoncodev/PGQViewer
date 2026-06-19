// Thin HTTP client for the Go backend.
//
// In production the renderer is served by the Go binary itself (embedded
// bundle, see server/internal/webui), so the base is empty and every fetch
// is same-origin. In Vite dev the base is also empty and requests route
// through the Vite proxy (`server.proxy` in vite.config.ts). A host page
// can still override the target by setting window.PGQVIEWER_API_BASE before
// the app boots.

declare global {
  interface Window {
    PGQVIEWER_API_BASE?: string;
  }
}

const base = (): string => (typeof window !== 'undefined' && window.PGQVIEWER_API_BASE) || '';

function url(path: string): string {
  return base() + path;
}

/**
 * Extracts an error message from a non-OK response: prefers the JSON
 * `{ error }` field the Go API returns, falling back to the status code.
 */
async function errorFromResponse(res: Response): Promise<string> {
  const body: unknown = await res.json().catch(() => ({}));
  return typeof body === 'object' && body && 'error' in body
    ? String((body as { error: unknown }).error)
    : `HTTP ${res.status}`;
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(await errorFromResponse(res));
  return res.json() as Promise<T>;
}

// --- types ---------------------------------------------------------------

export interface ConnectInput {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  sslmode?: 'disable' | 'prefer' | 'require' | 'verify-ca' | 'verify-full';
}

export interface OpenSessionResponse {
  session_id: string;
  label: string;
}

export interface Graph {
  oid: number;
  schema: string;
  name: string;
  owner: string;
}

export interface Property {
  name: string;
  type: string;
  expression?: string;
  /**
   * Labels of the element on which this property is declared. SQL/PGQ scopes
   * `alias.<prop>` to the matched label, so a property is only projectable
   * under a `IS <label>` binding when its labels include that label. Absent on
   * older server builds (treat as "applies to all of the element's labels").
   */
  labels?: string[];
}

export interface EdgeEnd {
  vertex: string;
  vertex_oid: number;
  key: string[];
  ref: string[];
}

export interface Element {
  oid: number;
  alias: string;
  kind: 'v' | 'e';
  table: { oid: number; schema: string; name: string };
  pk: string[];
  labels: string[];
  properties: Property[];
  source?: EdgeEnd;
  destination?: EdgeEnd;
}

export interface GraphMetadata {
  graph: Graph;
  definition: string;
  vertices: Element[];
  edges: Element[];
}

export interface LabelCount {
  element_oid: number;
  alias: string;
  kind: 'v' | 'e';
  labels: string[];
  count: number;
}

export interface VertexEvent {
  type: 'vertex';
  binding: string;
  id: string;
  labels: string[];
  properties: Record<string, unknown>;
}

export interface EdgeEvent {
  type: 'edge';
  binding: string;
  id: string;
  labels: string[];
  properties: Record<string, unknown>;
  source: string;
  destination: string;
}

export interface RowEvent {
  type: 'row';
  row: unknown[];
}

export interface ColumnsEvent {
  type: 'columns';
  columns: { name: string; type: string; type_oid: number }[];
}

export interface MetaEvent {
  type: 'meta';
  /** Optional: query id; mirrors the X-Query-ID response header. */
  qid?: string;
  /** Optional: PG backend PID running the query. */
  backend_pid?: number;
  /** Present in graph-mode runs: the projected GRAPH_TABLE SQL. */
  sql?: string;
  /** Present in graph-mode runs: one entry per declared binding. */
  bindings?: {
    alias: string;
    element_oid: number;
    kind: 'v' | 'e';
    labels: string[];
    properties: string[];
  }[];
  /** Present in graph-mode runs: the server's post-dedup element cap. */
  element_cap?: number;
  /** Non-fatal degradation notices from the projection — e.g. a KEY column not
   *  exposed as a property, so identity is approximated and dedup is
   *  best-effort. Surfaced to the user as an advisory. */
  warnings?: string[];
}

/**
 * Server -> client event emitted for EXPLAIN / EXPLAIN ANALYZE requests
 * (graph or SQL mode). `plan` is the raw JSON the planner returned (the
 * top-level value of an `EXPLAIN (FORMAT JSON)` array, or the array itself).
 * The renderer pretty-prints it in a dedicated panel.
 */
export interface ExplainEvent {
  type: 'explain';
  plan: unknown;
}

export interface StatsEvent {
  type: 'stats';
  rows: number;
  command?: string;
  db_rows?: number;
  vertices?: number;
  edges?: number;
  /** True when the server stopped emitting because it hit element_cap. */
  truncated?: boolean;
}

export interface SummaryEvent {
  type: 'summary';
  elapsed_ms: number;
}

export interface ErrorEvent {
  type: 'error';
  error: string;
}

export type QueryEvent =
  | VertexEvent
  | EdgeEvent
  | RowEvent
  | ColumnsEvent
  | MetaEvent
  | StatsEvent
  | SummaryEvent
  | ErrorEvent
  | ExplainEvent;

export interface Binding {
  alias: string;
  element_oid: number;
  // Optional allow-list narrowing which properties get projected for
  // this binding (PK + edge-endpoint key columns are always projected).
  // Empty / missing keeps today's behaviour of projecting every
  // declared property. See server/internal/sqlpgq/projection.go.
  display_properties?: string[];
  // The label this alias was matched against (`(a IS person)` → "person"),
  // when the pattern named one. The server scopes the projected COLUMNS to
  // that label's properties, since PG19 rejects `a.<prop>` for a property not
  // on the bound label. Omitted for an unlabeled pattern `(a)`.
  label?: string;
  // Edge-only: the vertex aliases this edge connects in the MATCH pattern
  // (`(a)-[e]->(b)` → source_alias "a", destination_alias "b"). The server uses
  // these for within-row endpoint linking, which lets graphs whose KEY /
  // endpoint columns are not exposed as properties still render (PG's MATCH
  // already resolved the topology). Omitted for anonymous endpoints.
  source_alias?: string;
  destination_alias?: string;
}

export interface GraphQueryRequest {
  mode: 'graph';
  graph_oid: number;
  match: string;
  where?: string;
  limit?: number;
  bindings: Binding[];
  /**
   * Post-dedup cap on unique vertices+edges emitted by the server.
   * Omitted ⇒ server applies its own default (10k).
   */
  element_cap?: number;
  /**
   * Explicit COLUMNS list for the generated GRAPH_TABLE. Currently the
   * server auto-projects identity columns regardless; this is reserved for
   * callers that want to override the projected expression list.
   */
  columns?: string[];
  /**
   * Extra FROM items placed alongside the GRAPH_TABLE reference, so outer rows
   * can correlate to the pattern. The server joins GRAPH_TABLE as a plain comma
   * FROM item — it is implicitly lateral, and PG19 rejects an explicit LATERAL
   * keyword before it.
   */
  from?: string[];
  /**
   * Alias bound to the GRAPH_TABLE reference so the `from` items can correlate
   * against it. (GRAPH_TABLE is implicitly lateral; no LATERAL keyword is used.)
   */
  lateral_alias?: string;
  /**
   * Positional parameters for $1, $2, … referenced from `where` / `from`.
   * Forwarded to pgx verbatim; pass `null` for a SQL NULL.
   */
  params?: unknown[];
  /** Ask the server to EXPLAIN the generated query instead of running it. */
  explain?: boolean;
  /** Ask the server to EXPLAIN ANALYZE (actually executes the query). */
  explain_analyze?: boolean;
}

export interface SQLQueryRequest {
  mode: 'sql';
  sql: string;
  /**
   * Positional parameters for $1, $2, …. Server forwards them to pgx
   * verbatim; types are inferred by the wire protocol. Pass `null` for a
   * SQL NULL.
   */
  params?: unknown[];
}

// --- endpoints -----------------------------------------------------------

// --- saved connections ---

export interface SavedConnection {
  id: number;
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
  sslmode: string;
  created_at: number;
  updated_at: number;
}

export interface NewSavedConnection {
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  sslmode?: string;
}

export async function listConnections(): Promise<SavedConnection[]> {
  const res = await fetch(url('/api/v1/connections'));
  const { connections } = await jsonOrThrow<{ connections: SavedConnection[] }>(res);
  return connections ?? [];
}

export async function saveConnection(input: NewSavedConnection): Promise<SavedConnection> {
  const res = await fetch(url('/api/v1/connections'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const { connection } = await jsonOrThrow<{ connection: SavedConnection }>(res);
  return connection;
}

export async function deleteConnection(id: number): Promise<void> {
  const res = await fetch(url(`/api/v1/connections/${id}`), { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    throw new Error(`delete connection failed: HTTP ${res.status}`);
  }
}

export async function openSavedConnection(id: number): Promise<OpenSessionResponse> {
  const res = await fetch(url(`/api/v1/connections/${id}/open`), { method: 'POST' });
  return jsonOrThrow<OpenSessionResponse>(res);
}

export async function openSession(input: ConnectInput): Promise<OpenSessionResponse> {
  const res = await fetch(url('/api/v1/sessions'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return jsonOrThrow<OpenSessionResponse>(res);
}

export async function closeSession(sid: string): Promise<void> {
  const res = await fetch(url(`/api/v1/sessions/${sid}`), { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    throw new Error(`close session failed: HTTP ${res.status}`);
  }
}

/** Pings a session; resolves true if the pool is alive, false on 404 / 502. */
export async function pingSession(sid: string): Promise<boolean> {
  try {
    const res = await fetch(url(`/api/v1/sessions/${sid}/ping`));
    return res.ok;
  } catch {
    return false;
  }
}

export async function listGraphs(sid: string): Promise<Graph[]> {
  const res = await fetch(url(`/api/v1/sessions/${sid}/graphs`));
  const { graphs } = await jsonOrThrow<{ graphs: Graph[] }>(res);
  return graphs ?? [];
}

export async function getGraphMetadata(sid: string, oid: number): Promise<GraphMetadata> {
  const res = await fetch(url(`/api/v1/sessions/${sid}/graphs/${oid}`));
  const md = await jsonOrThrow<GraphMetadata>(res);
  return { ...md, vertices: md.vertices ?? [], edges: md.edges ?? [] };
}

export async function getGraphCounts(sid: string, oid: number): Promise<LabelCount[]> {
  const res = await fetch(url(`/api/v1/sessions/${sid}/graphs/${oid}/counts`));
  const { counts } = await jsonOrThrow<{ counts: LabelCount[] }>(res);
  return counts ?? [];
}

/**
 * Streams a query response, calling onEvent for every NDJSON line.
 * The promise resolves when the stream ends (after summary or error).
 *
 * `onQid` is invoked exactly once as soon as the response headers arrive
 * with the value of the X-Query-ID header. The renderer stashes that id so
 * a "Cancel" button can call /queries/{qid}/cancel. The callback is
 * optional — older call sites that only care about events keep working.
 */
export async function streamQuery(
  sid: string,
  req: GraphQueryRequest | SQLQueryRequest,
  onEvent: (ev: QueryEvent) => void,
  signal?: AbortSignal,
  onQid?: (qid: string) => void,
): Promise<void> {
  const res = await fetch(url(`/api/v1/sessions/${sid}/query`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal,
  });
  if (!res.ok) throw new Error(await errorFromResponse(res));
  if (onQid) {
    const qid = res.headers.get('X-Query-ID');
    if (qid) onQid(qid);
  }
  if (!res.body) throw new Error('no response body');
  await consumeNdjson(res.body.getReader(), onEvent, signal);
}

// Body for POST /api/v1/sessions/{sid}/graphs/{oid}/expand. anchor_pk is the
// list of PK column values for the anchored vertex, in the same positional
// order as the element's declared PK. It mirrors the synthesized canvas id
// `<elemOID>:<pk1,pk2,...>` — split on `,` to recover.
export interface ExpandRequest {
  anchor_element_oid: number;
  anchor_pk: string[];
  edge_labels?: string[];
  limit?: number;
  /**
   * How many hops to walk out from the anchor. 1 (default) reproduces the
   * original single-hop neighbourhood; higher values fan out further.
   */
  max_depth?: number;
}

/**
 * Streams the 1-hop neighbourhood of a vertex via the expand endpoint.
 * Events use the same shapes as streamQuery (vertex / edge / stats / summary
 * / error), plus a leading `meta` event describing every sub-query that was
 * issued (one per candidate edge × direction).
 */
export async function streamExpand(
  sid: string,
  graphOid: number,
  body: ExpandRequest,
  onEvent: (ev: QueryEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return streamNdjson(
    `/api/v1/sessions/${sid}/graphs/${graphOid}/expand`,
    body,
    onEvent,
    signal,
  );
}

// Shared NDJSON reader so streamQuery and streamExpand stay in sync.
async function streamNdjson(
  path: string,
  body: unknown,
  onEvent: (ev: QueryEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(url(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(await errorFromResponse(res));
  if (!res.body) throw new Error('no response body');
  await consumeNdjson(res.body.getReader(), onEvent, signal);
}

/**
 * Drains an NDJSON ReadableStream, calling onEvent per parsed line.
 *
 * Yields to the event loop every YIELD_EVERY events so the browser can
 * process user input (Cancel click, pan/zoom, tab switch) mid-stream — this
 * is what unblocks the Cancel button at scale. Also checks AbortSignal at
 * every yield point AND at the start of every chunk; tears down the reader
 * and throws AbortError on cancel so callers' try/catch fires.
 */
async function consumeNdjson(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onEvent: (ev: QueryEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  // 25 keeps each work block under ~16 ms on a typical stream; lower would
  // hurt throughput, higher would block clicks.
  const YIELD_EVERY = 25;
  let processedSinceYield = 0;
  const abort = () => {
    try {
      reader.cancel();
    } catch {
      /* ignore */
    }
    throw new DOMException('aborted', 'AbortError');
  };
  for (;;) {
    if (signal?.aborted) abort();
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      if (signal?.aborted) abort();
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        onEvent(JSON.parse(line) as QueryEvent);
      } catch (e) {
        console.error('parse ndjson failed', e, line);
      }
      if (++processedSinceYield >= YIELD_EVERY) {
        processedSinceYield = 0;
        // setTimeout 0 is the cheapest cross-browser yield. scheduler.yield()
        // would be slightly better on Chrome but isn't available everywhere.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
  }
  if (signal?.aborted) abort();
  // Flush any trailing line.
  const tail = buf.trim();
  if (tail) {
    try {
      onEvent(JSON.parse(tail) as QueryEvent);
    } catch (e) {
      console.error('parse ndjson tail failed', e, tail);
    }
  }
}

/**
 * Asks the server to cancel an in-flight query. Returns true when the cancel
 * signal was delivered (HTTP 204), false when the qid is no longer tracked
 * (HTTP 404 — the query already finished or the session was closed).
 *
 * Cancellation is best-effort: pg_cancel_backend signals SIGINT and the
 * running query stops at the next CHECK_FOR_INTERRUPTS. The caller should
 * still await the streaming response, which will end shortly with either a
 * normal summary or an in-band error event.
 */
export async function cancelQuery(sid: string, qid: string): Promise<boolean> {
  const res = await fetch(
    url(`/api/v1/sessions/${sid}/queries/${qid}/cancel`),
    { method: 'POST' },
  );
  if (res.status === 204) return true;
  if (res.status === 404) return false;
  throw new Error(await errorFromResponse(res));
}

