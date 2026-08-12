{{
  config(
    materialized='table'
  )
}}

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
left join stg.raw_addresses a on c.id=a.id