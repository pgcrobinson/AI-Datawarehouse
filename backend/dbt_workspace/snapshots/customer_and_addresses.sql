{% snapshot customer_and_addresses %}

{{
    config(
        target_schema='snapshots',
        unique_key='id',
        strategy='timestamp',
        updated_at='updated_at'
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

{% endsnapshot %}
