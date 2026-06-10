-- Elements (vertex + edge tables) for a property graph.
--
-- Each row carries the underlying relation, the element alias used inside
-- MATCH, the kind ('v' or 'e'), and four sets of column names resolved from
-- the int2[] attnum arrays stored in the catalog:
--   - pk_cols:       this element's primary key (KEY (...))
--   - src_key_cols:  edges only — FK columns in this edge table (SOURCE KEY)
--   - src_ref_cols:  edges only — referenced columns in the source vertex table
--   - dst_key_cols:  edges only — FK columns in this edge table (DESTINATION KEY)
--   - dst_ref_cols:  edges only — referenced columns in the dest vertex table
--
-- Vertices have NULL for the src_*/dst_* arrays and pgesrcvertexid=0.
--
-- $1: graph oid
SELECT
    e.oid                                                       AS element_oid,
    e.pgealias                                                  AS alias,
    e.pgekind::text                                             AS kind,
    er.oid                                                      AS table_oid,
    ern.nspname                                                 AS table_schema,
    er.relname                                                  AS table_name,
    NULLIF(e.pgesrcvertexid, 0)                                 AS src_vertex_oid,
    NULLIF(e.pgedestvertexid, 0)                                AS dst_vertex_oid,
    (SELECT array_agg(a.attname ORDER BY u.ord)
     FROM unnest(e.pgekey) WITH ORDINALITY u(an, ord)
     JOIN pg_catalog.pg_attribute a
       ON a.attrelid = e.pgerelid AND a.attnum = u.an)          AS pk_cols,
    (SELECT array_agg(a.attname ORDER BY u.ord)
     FROM unnest(e.pgesrckey) WITH ORDINALITY u(an, ord)
     JOIN pg_catalog.pg_attribute a
       ON a.attrelid = e.pgerelid AND a.attnum = u.an)          AS src_key_cols,
    (SELECT array_agg(a.attname ORDER BY u.ord)
     FROM unnest(e.pgesrcref) WITH ORDINALITY u(an, ord)
     JOIN pg_catalog.pg_propgraph_element se ON se.oid = e.pgesrcvertexid
     JOIN pg_catalog.pg_attribute a
       ON a.attrelid = se.pgerelid AND a.attnum = u.an)         AS src_ref_cols,
    (SELECT array_agg(a.attname ORDER BY u.ord)
     FROM unnest(e.pgedestkey) WITH ORDINALITY u(an, ord)
     JOIN pg_catalog.pg_attribute a
       ON a.attrelid = e.pgerelid AND a.attnum = u.an)          AS dst_key_cols,
    (SELECT array_agg(a.attname ORDER BY u.ord)
     FROM unnest(e.pgedestref) WITH ORDINALITY u(an, ord)
     JOIN pg_catalog.pg_propgraph_element de ON de.oid = e.pgedestvertexid
     JOIN pg_catalog.pg_attribute a
       ON a.attrelid = de.pgerelid AND a.attnum = u.an)         AS dst_ref_cols
FROM pg_catalog.pg_propgraph_element e
JOIN pg_catalog.pg_class      er  ON er.oid  = e.pgerelid
JOIN pg_catalog.pg_namespace  ern ON ern.oid = er.relnamespace
WHERE e.pgepgid = $1
ORDER BY e.pgekind DESC, e.pgealias;   -- vertices ('v') before edges ('e')
