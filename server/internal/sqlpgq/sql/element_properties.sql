-- Properties exposed on each element, with the label each is declared on.
--
-- A property may be defined on multiple labels for the same element; this emits
-- one row per (element, property, label). The Go layer collapses them into one
-- Property per name whose Labels lists every label it appears on. SQL/PGQ scopes
-- `alias.<prop>` to the matched label, so the projection needs the per-label
-- membership (not just the union) to know which properties a `IS <label>`
-- binding may project. See attachProperties / BuildProjectionWithOpts.
--
-- `prop_expr` renders the property expression (via pg_get_expr on the
-- serialized node tree in pg_propgraph_label_property.plpexpr). For a plain
-- `PROPERTIES ALL COLUMNS`-style declaration it reads as the column name;
-- for an expression like `i + j AS i_j` it carries the expression text.
--
-- $1: graph oid
SELECT DISTINCT
    el.pgelelid                                          AS element_oid,
    p.pgpname                                            AS prop_name,
    pg_catalog.format_type(p.pgptypid, p.pgptypmod)      AS prop_type,
    pg_catalog.pg_get_expr(lp.plpexpr, e.pgerelid)       AS prop_expr,
    l.pgllabel                                           AS label
FROM pg_catalog.pg_propgraph_element_label el
JOIN pg_catalog.pg_propgraph_element        e  ON e.oid  = el.pgelelid
JOIN pg_catalog.pg_propgraph_label          l  ON l.oid  = el.pgellabelid
JOIN pg_catalog.pg_propgraph_label_property lp ON lp.plpellabelid = el.oid
JOIN pg_catalog.pg_propgraph_property       p  ON p.oid  = lp.plppropid
WHERE l.pglpgid = $1
ORDER BY el.pgelelid, p.pgpname, l.pgllabel;
