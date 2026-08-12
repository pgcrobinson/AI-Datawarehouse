
  
    USE [DevmySampleDatabase];
    USE [DevmySampleDatabase];
    
    

    

    
    USE [DevmySampleDatabase];
    EXEC('
        create view "analytics"."number_of_customers_city__dbt_tmp__dbt_tmp_vw" as 

SELECT
country,  
count(distinct(id)) as number
FROM 
"DevmySampleDatabase"."snapshots"."customer_and_addresses"
group by country;
    ')

EXEC('
            SELECT * INTO "DevmySampleDatabase"."analytics"."number_of_customers_city__dbt_tmp" FROM "DevmySampleDatabase"."analytics"."number_of_customers_city__dbt_tmp__dbt_tmp_vw" 
    OPTION (LABEL = ''dbt-sqlserver'');

        ')

    
    EXEC('DROP VIEW IF EXISTS analytics.number_of_customers_city__dbt_tmp__dbt_tmp_vw')



    
    use [DevmySampleDatabase];
    if EXISTS (
        SELECT *
        FROM sys.indexes with (nolock)
        WHERE name = 'analytics_number_of_customers_city__dbt_tmp_cci'
        AND object_id=object_id('analytics_number_of_customers_city__dbt_tmp')
    )
    DROP index "analytics"."number_of_customers_city__dbt_tmp".analytics_number_of_customers_city__dbt_tmp_cci
    CREATE CLUSTERED COLUMNSTORE INDEX analytics_number_of_customers_city__dbt_tmp_cci
    ON "analytics"."number_of_customers_city__dbt_tmp"

   


  