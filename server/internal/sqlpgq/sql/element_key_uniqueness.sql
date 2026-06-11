-- Per-element flag: is the property-graph element's KEY (pgekey) covered by
-- a non-partial, valid, non-expression unique index on the underlying table?
--
-- PostgreSQL 19 does NOT require pgekey to be unique (verified against
-- propgraphcmds.c:325-354 — no indisunique check on the explicit-KEY path).
-- A property graph can legally declare KEY (col) on a column with no unique
-- constraint, and the viewer will then silently merge distinct rows into a
-- single synthesized vertex/edge id. Surface this as a warning so users see
-- it.
--
-- We accept ANY unique index whose KEY columns (the first indnkeyatts entries
-- of indkey; trailing INCLUDE/covering columns are excluded), treated as a set,
-- equal the element's pgekey. Index column order is irrelevant for the
-- uniqueness guarantee; only the column set matters.
--
-- Excluded:
--   - indpred IS NOT NULL  (partial indexes only enforce uniqueness within
--     the predicate; the element may have rows the index doesn't cover).
--   - indexprs IS NOT NULL (expression-only unique indexes don't apply to
--     plain column tuples).
--   - indisvalid = false / indisready = false (not enforceable).
--
-- $1: graph oid
SELECT
    e.oid AS element_oid,
    EXISTS (
        SELECT 1
        FROM pg_catalog.pg_index ix
        WHERE ix.indrelid    = e.pgerelid
          AND ix.indisunique
          AND ix.indisvalid
          AND ix.indisready
          AND ix.indpred  IS NULL
          AND ix.indexprs IS NULL
          AND (
              -- Compare only the KEY columns. A covering UNIQUE ... INCLUDE (...)
              -- index lists the INCLUDE attnums in indkey too, but they do NOT
              -- participate in uniqueness, so slice indkey to its first
              -- indnkeyatts entries before set-comparing against pgekey.
              SELECT array_agg(k::int2 ORDER BY k)
              FROM unnest((ix.indkey::int2[])[1:ix.indnkeyatts]) k
              WHERE k <> 0
          ) = (
              SELECT array_agg(k ORDER BY k)
              FROM unnest(e.pgekey) k
          )
    ) AS key_is_unique
FROM pg_catalog.pg_propgraph_element e
WHERE e.pgepgid = $1
ORDER BY e.oid;
