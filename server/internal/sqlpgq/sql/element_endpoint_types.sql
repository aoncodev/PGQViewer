-- Per-edge endpoint key/ref column TYPE comparison.
--
-- PostgreSQL 19 does NOT verify that an edge's SOURCE/DESTINATION KEY columns
-- are type-compatible with the referenced vertex KEY/REFERENCES columns
-- (verified against propgraphcmds.c — the explicit-REFERENCES path records the
-- per-column equality operator without a hard type-match requirement on the
-- viewer side). When the FK column type and the referenced column type differ
-- in a way that has no usable equality operator, GRAPH_TABLE joins either error
-- at query time or silently match nothing. The viewer surfaces this at
-- graph-select time instead.
--
-- For each edge element this emits one row per endpoint key/ref column pair:
--   element_oid : the edge element oid
--   side        : 'source' | 'destination'
--   ord         : 1-based position within the (multi-column) key
--   key_col     : the edge-table column name (FK side)
--   key_typid   : its pg_type oid
--   ref_col     : the referenced vertex-table column name
--   ref_typid   : its pg_type oid
--   key_typ     : human-readable type of the FK column
--   ref_typ     : human-readable type of the referenced column
--   has_eq_op   : whether a binary '=' operator exists with left=key_typid,
--                 right=ref_typid (i.e. the join predicate is resolvable).
--
-- Vertices and edges without endpoints produce no rows.
--
-- $1: graph oid
WITH ends AS (
    SELECT e.oid               AS element_oid,
           'source'::text      AS side,
           e.pgerelid          AS key_relid,
           se.pgerelid         AS ref_relid,
           e.pgesrckey         AS key_attnums,
           e.pgesrcref         AS ref_attnums
    FROM pg_catalog.pg_propgraph_element e
    JOIN pg_catalog.pg_propgraph_element se ON se.oid = e.pgesrcvertexid
    WHERE e.pgepgid = $1
      AND e.pgekind = 'e'
      AND e.pgesrcvertexid <> 0
    UNION ALL
    SELECT e.oid               AS element_oid,
           'destination'::text AS side,
           e.pgerelid          AS key_relid,
           de.pgerelid         AS ref_relid,
           e.pgedestkey        AS key_attnums,
           e.pgedestref        AS ref_attnums
    FROM pg_catalog.pg_propgraph_element e
    JOIN pg_catalog.pg_propgraph_element de ON de.oid = e.pgedestvertexid
    WHERE e.pgepgid = $1
      AND e.pgekind = 'e'
      AND e.pgedestvertexid <> 0
),
pairs AS (
    SELECT en.element_oid,
           en.side,
           k.ord                AS ord,
           ka.attname           AS key_col,
           ka.atttypid          AS key_typid,
           ra.attname           AS ref_col,
           ra.atttypid          AS ref_typid
    FROM ends en
    JOIN LATERAL unnest(en.key_attnums) WITH ORDINALITY AS k(an, ord) ON true
    JOIN LATERAL unnest(en.ref_attnums) WITH ORDINALITY AS r(an, ord)
         ON r.ord = k.ord
    JOIN pg_catalog.pg_attribute ka
      ON ka.attrelid = en.key_relid AND ka.attnum = k.an
    JOIN pg_catalog.pg_attribute ra
      ON ra.attrelid = en.ref_relid AND ra.attnum = r.an
)
SELECT
    p.element_oid,
    p.side,
    p.ord,
    p.key_col,
    p.key_typid,
    p.ref_col,
    p.ref_typid,
    pg_catalog.format_type(p.key_typid, NULL) AS key_typ,
    pg_catalog.format_type(p.ref_typid, NULL) AS ref_typ,
    EXISTS (
        SELECT 1
        FROM pg_catalog.pg_operator op
        WHERE op.oprname = '='
          AND op.oprkind = 'b'
          AND op.oprleft  = p.key_typid
          AND op.oprright = p.ref_typid
    ) AS has_eq_op
FROM pairs p
ORDER BY p.element_oid, p.side, p.ord;
