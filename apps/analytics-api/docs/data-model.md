# Data Model

Example Kitchen Intelligence uses a small warehouse layout instead of copying KDS tables.

## Schemas

- `raw`: sanitized Clover payloads and export metadata.
- `staging`: reserved for future cleanup tables.
- `mart`: AI and report-ready facts, dimensions, and materialized views.
- `audit`: backfill status, windows, query logs, failures.
- `meta`: metric definitions for AI tools and humans.

`audit.sync_jobs` is the executable queue. `audit.sync_windows` is the window-level ledger for business progress: export requested/downloaded, raw imported, detail hydrated, dirty window created, mart refreshed, and reconciled.

## Mart Grain

- `mart.fact_orders`: one row per Clover order.
- `mart.fact_order_line_items`: one row per historical order line item.
- `mart.fact_line_item_modifiers`: one row per line item modifier for topping / mix-in analysis.
- `mart.fact_payments`: one row per successful payment, preserving split payments.
- `mart.fact_refunds`: one row per refund.

Amounts are integer cents. Times are stored as UTC plus Central Time reporting fields:

- `business_date`
- `local_hour`
- `weekday`
- `year_month`
- `iso_week`

## Sales Metrics

- `payment_total_cents`: successful captured payment amount.
- `refund_total_cents`: refund amount.
- `net_sales_cents`: payment total minus refund total.
- `gross_sales_cents`: line item sales before refunds, including priced modifiers.
- `modifier_total_cents`: priced modifier add-ons stored separately from item base price.
- `detail_score`: raw order payload completeness hint. Export rows should not replace richer REST/webhook rows.
- `cash_sales_cents`: payment total where `tender_type = 'CASH'`.
- `credit_card_sales_cents`: payment total where `tender_type = 'CREDIT_CARD'`.

Use `mart.sales_daily_mv` and `mart.payment_method_daily_mv` for most owner-facing sales questions.

## Reconciliation

`audit.reconciliation_results` compares raw/export-loaded data to mart facts by business date. `imported` only means Export files landed. `passed` means compared daily metrics matched. `failed` records deltas and queues a repair window.

## Example Queries

Past few months of Mondays:

```sql
select business_date, net_sales_cents
from mart.sales_daily_mv
where business_date >= current_date - interval '6 months'
  and extract(isodow from business_date) = 1
order by business_date;
```

Top items last 30 days:

```sql
select item_name, sum(quantity) as qty, sum(gross_sales_cents) as gross_sales_cents
from mart.item_sales_daily_mv
where business_date >= current_date - interval '30 days'
group by item_name
order by qty desc
limit 20;
```

Cash vs credit by month:

```sql
select date_trunc('month', business_date)::date as month, tender_type, sum(amount_cents) as amount_cents
from mart.payment_method_daily_mv
where tender_type in ('CASH', 'CREDIT_CARD')
group by month, tender_type
order by month, tender_type;
```

Top modifiers last 30 days:

```sql
select modifier_name, count(*) as uses, sum(modifier_amount_cents * quantity) as amount_cents
from mart.fact_line_item_modifiers
where business_date >= current_date - interval '30 days'
group by modifier_name
order by uses desc
limit 20;
```
