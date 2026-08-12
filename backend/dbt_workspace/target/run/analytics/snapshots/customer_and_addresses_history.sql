
      merge into "DevmySampleDatabase"."snapshots"."customer_and_addresses_history" as DBT_INTERNAL_DEST
    using "DevmySampleDatabase"."snapshots"."customer_and_addresses_history__dbt_tmp" as DBT_INTERNAL_SOURCE
    on DBT_INTERNAL_SOURCE.dbt_scd_id = DBT_INTERNAL_DEST.dbt_scd_id

    when matched
     and DBT_INTERNAL_DEST.dbt_valid_to is null
     and DBT_INTERNAL_SOURCE.dbt_change_type in ('update', 'delete')
        then update
        set dbt_valid_to = DBT_INTERNAL_SOURCE.dbt_valid_to

    when not matched
     and DBT_INTERNAL_SOURCE.dbt_change_type = 'insert'
        then insert ("id", "first_name", "last_name", "email", "city", "country", "postcode", "created_at", "updated_at", "dbt_updated_at", "dbt_valid_from", "dbt_valid_to", "dbt_scd_id")
        values ("id", "first_name", "last_name", "email", "city", "country", "postcode", "created_at", "updated_at", "dbt_updated_at", "dbt_valid_from", "dbt_valid_to", "dbt_scd_id")
    ;

  