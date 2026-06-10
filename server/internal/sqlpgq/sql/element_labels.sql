-- All (element, label) pairs for a graph.
-- $1: graph oid
SELECT
    el.pgelelid                        AS element_oid,
    l.pgllabel                         AS label
FROM pg_catalog.pg_propgraph_element_label el
JOIN pg_catalog.pg_propgraph_label l ON l.oid = el.pgellabelid
WHERE l.pglpgid = $1
ORDER BY el.pgelelid, l.pgllabel;
