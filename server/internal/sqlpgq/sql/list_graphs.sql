-- List every property graph visible to the current role.
-- Property graphs live in pg_class with relkind = 'g'.
SELECT
    c.oid                              AS oid,
    n.nspname                          AS schema,
    c.relname                          AS name,
    pg_get_userbyid(c.relowner)        AS owner
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'g'
ORDER BY n.nspname, c.relname;
