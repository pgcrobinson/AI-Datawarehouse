
  
    USE [DevmySampleDatabase];
    USE [DevmySampleDatabase];
    
    

    

    
    USE [DevmySampleDatabase];
    EXEC('
        create view "analytics"."customer_and_addresses__dbt_tmp__dbt_tmp_vw" as 

SELECT
  c.id,
  c.first_name,
  c.last_name,
  c.email,
  c.city,
  c.country,
  a.postcode,
  c.created_at,
  c.updated_at
FROM stg.raw_customers c
left join stg.raw_addresses a on c.id=a.id;
    ')

EXEC('
            SELECT * INTO "DevmySampleDatabase"."analytics"."customer_and_addresses__dbt_tmp" FROM "DevmySampleDatabase"."analytics"."customer_and_addresses__dbt_tmp__dbt_tmp_vw" 
    OPTION (LABEL = ''dbt-sqlserver'');

        ')

    
    EXEC('DROP VIEW IF EXISTS analytics.customer_and_addresses__dbt_tmp__dbt_tmp_vw')



    
    use [DevmySampleDatabase];
    if EXISTS (
        SELECT *
        FROM sys.indexes with (nolock)
        WHERE name = 'analytics_customer_and_addresses__dbt_tmp_cci'
        AND object_id=object_id('analytics_customer_and_addresses__dbt_tmp')
    )
    DROP index "analytics"."customer_and_addresses__dbt_tmp".analytics_customer_and_addresses__dbt_tmp_cci
    CREATE CLUSTERED COLUMNSTORE INDEX analytics_customer_and_addresses__dbt_tmp_cci
    ON "analytics"."customer_and_addresses__dbt_tmp"

   


  