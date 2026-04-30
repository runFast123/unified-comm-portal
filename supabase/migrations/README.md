# Database migrations

This project uses a chronological list of forward-only migrations applied via
the Supabase MCP. Going forward, **every schema change must land here as a new
file** with a sortable timestamp prefix (e.g. `20260425110000_my_change.sql`).

## Workflow

1. Author the SQL in a new file `<UTC_yyyymmddHHMMSS>_<short_name>.sql`.
2. Apply it to staging/prod via the Supabase MCP (`apply_migration`) or
   `supabase db push`.
3. Commit the file. Do NOT edit applied files — write a follow-up instead.

## History (currently applied to `unified-comm-portal-test`)

The live DB at project `mpgmwyobrzhqamtcrtjg` has the following migrations
applied. Files marked **(file)** exist in this folder; the rest were applied
via MCP before the migrations folder existed and live only in
`supabase_migrations.schema_migrations`.

| Version | Name | File |
|---------|------|------|
| 20260423123035 | initial_schema_no_n8n | — (see `src/lib/schema.sql`) |
| 20260423125005 | channel_configs_encrypted | — |
| 20260423130251 | security_hardening | — (RLS + first-user-admin trigger) |
| 20260423132346 | fix_user_role_schema_qualifier | — |
| 20260423133512 | accounts_last_polled_at | — |
| 20260424075756 | accounts_last_imap_uid | — |
| 20260424081443 | accounts_last_imap_sent_uid | — |
| 20260424103357 | scheduled_messages | — |
| 20260424125207 | integration_settings | — |
| 20260424133442 | tier2_rate_limits_and_spam_overrides | — |
| 20260424134038 | tier2_check_rate_limit_fn | **(file)** [`20260424190601_rate_limit_check.sql`](./20260424190601_rate_limit_check.sql) |
| 20260425052926 | companies_table_and_backfill | **(file)** [`20260425052349_companies.sql`](./20260425052349_companies.sql) |

**Source of truth for current schema** is the live DB. To re-create an empty
project from scratch, run the migration files in this folder in timestamp
order, then apply any missing historical ones from the table above.

## Reproducing the schema on a fresh DB

For now, the cleanest path is:

```sh
# Apply each historical migration (names from the table above) via:
supabase migration new <name>
# paste the SQL from each MCP migration history entry
supabase db push
```

A future cleanup pass should consolidate the historical migrations into a
single baseline `0000_baseline.sql` file derived from `pg_dump --schema-only`.
