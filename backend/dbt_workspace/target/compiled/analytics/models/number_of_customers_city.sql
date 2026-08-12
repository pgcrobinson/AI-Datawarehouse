

SELECT
country,  
count(distinct(id)) as number
FROM 
"DevmySampleDatabase"."snapshots"."customer_and_addresses"
group by country