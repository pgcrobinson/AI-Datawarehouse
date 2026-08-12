{{
  config(
    materialized='table'
  )
}}

SELECT
country,  
count(distinct(id)) as number
FROM 
{{ ref('customer_and_addresses') }}
group by country