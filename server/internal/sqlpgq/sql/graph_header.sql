-- $1: graph oid (pg_class.oid where relkind='g')
SELECT
    c.oid                                AS oid,
    n.nspname                            AS schema,
    c.relname                            AS name,
    pg_get_userbyid(c.relowner)          AS owner,
    pg_get_propgraphdef(c.oid)           AS definition
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'g' AND c.oid = $1;
