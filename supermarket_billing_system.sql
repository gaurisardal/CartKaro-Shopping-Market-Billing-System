-- =====================================================================
-- CARTKARO FIX MIGRATION  (run AFTER supermarket_billing_system.sql)
--
-- What this does (nothing is dropped, no existing rows are deleted):
--   1. Adds a few nullable / defaulted columns to existing tables.
--   2. Backfills bills.bill_number  (BILL-1000 + bill_id, e.g. bill 13 -> BILL-1013).
--   3. Adds PostgreSQL functions (RPC) that the new app.js calls:
--        create_sale   - bill + bill_items + payment + stock deduction + stock ledger, atomically
--        void_bill     - cancel a bill, refund its payment, restore stock, atomically
--        adjust_stock  - stock in / stock out / set exact count, atomically
--        save_product  - create or update a product (+ its inventory row)
--        delete_product- delete a product, or archive it when it has sales history
--        get_bill_json - helper used by the functions above
--   4. Locks the functions to logged-in staff ("authenticated") only.
--
-- Row Level Security is NOT touched. The functions are SECURITY INVOKER
-- (the default), so your existing staff_all_* policies still apply.
-- Safe to re-run.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1) COLUMNS
-- ---------------------------------------------------------------------

-- products: archive flag (products with sales history cannot be hard-deleted),
-- plus the three fields the product form already has but the table lacked.
alter table public.products add column if not exists is_active   boolean not null default true;
alter table public.products add column if not exists cost_price  numeric(10,2);
alter table public.products add column if not exists supplier    text;
alter table public.products add column if not exists expiry_date date;

do $$
begin
    if not exists (select 1 from pg_constraint
                   where conname = 'chk_products_cost_price'
                     and conrelid = 'public.products'::regclass) then
        alter table public.products
            add constraint chk_products_cost_price check (cost_price is null or cost_price >= 0);
    end if;
end $$;

-- bills: human-readable number (kept separate from the numeric bill_id),
-- idempotency key (stops duplicate bills on double-click / retry), and the
-- discount / GST inputs so a receipt can be rebuilt exactly.
alter table public.bills add column if not exists bill_number        text;
alter table public.bills add column if not exists client_request_id  uuid;
alter table public.bills add column if not exists discount_type      text;
alter table public.bills add column if not exists discount_value     numeric(12,2);
alter table public.bills add column if not exists gst_rate           numeric(5,2);

-- payments: cash tendered / change / card or UPI reference shown on receipts.
alter table public.payments add column if not exists amount_tendered numeric(12,2);
alter table public.payments add column if not exists change_due      numeric(12,2);
alter table public.payments add column if not exists reference       text;

-- Backfill bill numbers for existing bills: bill_id 13 -> BILL-1013.
update public.bills
   set bill_number = 'BILL-' || (1000 + bill_id)
 where bill_number is null;

create unique index if not exists uq_bills_bill_number
    on public.bills (bill_number);
create unique index if not exists uq_bills_client_request_id
    on public.bills (client_request_id);

-- New bills get their number automatically, even for inserts made outside the app.
create or replace function public.trg_bills_set_bill_number()
returns trigger
language plpgsql
as $$
begin
    if new.bill_number is null and new.bill_id is not null then
        new.bill_number := 'BILL-' || (1000 + new.bill_id);
    end if;
    return new;
end $$;

drop trigger if exists bills_set_bill_number on public.bills;
create trigger bills_set_bill_number
    before insert on public.bills
    for each row execute function public.trg_bills_set_bill_number();


-- ---------------------------------------------------------------------
-- 2) FUNCTIONS
-- Old signatures are dropped first so re-running never creates overloads.
-- ---------------------------------------------------------------------
drop function if exists public.create_sale(uuid, text, text, jsonb, text, numeric, numeric, text, numeric, text);
drop function if exists public.void_bill(bigint);
drop function if exists public.adjust_stock(bigint, text, numeric, text);
drop function if exists public.save_product(bigint, text, text, text, numeric, numeric, text, numeric, text, date, numeric, numeric);
drop function if exists public.delete_product(bigint);
drop function if exists public.get_bill_json(bigint);


-- 2a) get_bill_json: one bill (header + customer + items + payment) as JSON ----
create or replace function public.get_bill_json(p_bill_id bigint)
returns jsonb
language sql
set search_path = public
as $$
    select jsonb_build_object(
        'bill_id',         b.bill_id,
        'bill_number',     b.bill_number,
        'bill_date',       b.bill_date,
        'customer_id',     b.customer_id,
        'customer_name',   c.customer_name,
        'customer_phone',  c.phone,
        'subtotal',        b.subtotal,
        'discount',        b.discount,
        'tax_amount',      b.tax_amount,
        'grand_total',     b.grand_total,
        'payment_method',  b.payment_method,
        'status',          b.status,
        'discount_type',   b.discount_type,
        'discount_value',  b.discount_value,
        'gst_rate',        b.gst_rate,
        'amount_tendered', pay.amount_tendered,
        'change_due',      pay.change_due,
        'reference',       pay.reference,
        'items', coalesce((
            select jsonb_agg(jsonb_build_object(
                       'product_id', bi.product_id,
                       'name',       p.product_name,
                       'barcode',    p.barcode,
                       'quantity',   bi.quantity,
                       'unit_price', bi.unit_price,
                       'discount',   bi.discount,
                       'tax_amount', bi.tax_amount,
                       'line_total', bi.line_total
                   ) order by bi.bill_item_id)
              from public.bill_items bi
              join public.products p on p.product_id = bi.product_id
             where bi.bill_id = b.bill_id
        ), '[]'::jsonb)
    )
    from public.bills b
    left join public.customers c on c.customer_id = b.customer_id
    left join lateral (
        select py.amount_tendered, py.change_due, py.reference
          from public.payments py
         where py.bill_id = b.bill_id
         order by py.payment_id
         limit 1
    ) pay on true
    where b.bill_id = p_bill_id;
$$;


-- 2b) create_sale ----------------------------------------------------------
-- p_items: [{"product_id": 12, "quantity": 2}, ...]
-- Prices are read from public.products (never trusted from the browser).
-- Discount / GST follow the POS screen: discount is taken off the subtotal
-- (percent or fixed), then ONE GST rate is applied to the discounted amount.
-- Bill-level discount and tax are spread over the lines so
-- sum(bill_items) = bills header exactly.
create or replace function public.create_sale(
    p_request_id      uuid,
    p_customer_name   text,
    p_customer_phone  text,
    p_items           jsonb,
    p_discount_type   text,
    p_discount_value  numeric,
    p_gst_rate        numeric,
    p_payment_method  text,
    p_amount_tendered numeric default null,
    p_reference       text    default null
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
    v_existing_id  bigint;
    v_method       text;
    v_phone        text;
    v_customer_id  bigint;
    v_dtype        text;
    v_dval         numeric(12,2);
    v_gst          numeric(5,2);
    v_subtotal     numeric(12,2) := 0;
    v_discount     numeric(12,2) := 0;
    v_taxable      numeric(12,2);
    v_tax          numeric(12,2);
    v_total        numeric(12,2);
    v_tendered     numeric(12,2);
    v_change       numeric(12,2);
    v_bill_id      bigint;
    v_name         text;
    v_price        numeric(10,2);
    v_stock        numeric(10,3);
    r              record;
    v_ids          bigint[]  := '{}';
    v_qtys         numeric[] := '{}';
    v_prices       numeric[] := '{}';
    v_n            int;
    v_i            int;
    v_gross        numeric;
    v_item_d       numeric(12,2);
    v_item_t       numeric(12,2);
    v_alloc_d      numeric(12,2) := 0;
    v_alloc_t      numeric(12,2) := 0;
begin
    if p_request_id is null then
        raise exception 'INVALID_REQUEST: a request id is required';
    end if;

    -- Serialise concurrent calls that carry the same request id, so a double-click
    -- or a retry waits for the first call and then simply gets its bill back.
    perform pg_advisory_xact_lock(hashtextextended(p_request_id::text, 0));

    select bill_id into v_existing_id from public.bills where client_request_id = p_request_id;
    if found then
        return public.get_bill_json(v_existing_id) || jsonb_build_object('already_processed', true);
    end if;

    -- payment method
    v_method := upper(trim(coalesce(p_payment_method, '')));
    if v_method not in ('CASH', 'CARD', 'UPI') then
        raise exception 'INVALID_PAYMENT_METHOD: %', coalesce(p_payment_method, '(none)');
    end if;

    -- items
    if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
        raise exception 'EMPTY_CART: the bill has no items';
    end if;

    -- Pass 1: validate each product, lock its inventory row, check stock.
    -- Products are processed in product_id order so concurrent sales cannot deadlock.
    for r in
        select (e->>'product_id')::bigint as product_id,
               sum((e->>'quantity')::numeric) as qty
          from jsonb_array_elements(p_items) e
         group by 1
         order by 1
    loop
        if r.product_id is null or r.qty is null or r.qty <= 0 then
            raise exception 'INVALID_QUANTITY: every item needs a product and a quantity greater than 0';
        end if;

        select p.product_name, p.price
          into v_name, v_price
          from public.products p
         where p.product_id = r.product_id and p.is_active;
        if not found then
            raise exception 'PRODUCT_NOT_FOUND: product % does not exist or has been removed', r.product_id;
        end if;

        insert into public.inventory (product_id) values (r.product_id)
        on conflict (product_id) do nothing;

        select i.quantity into v_stock
          from public.inventory i
         where i.product_id = r.product_id
         for update;

        if v_stock < r.qty then
            raise exception 'INSUFFICIENT_STOCK: "%" has only % in stock but % requested',
                v_name, v_stock, r.qty;
        end if;

        v_ids    := v_ids    || r.product_id;
        v_qtys   := v_qtys   || r.qty;
        v_prices := v_prices || v_price;
        v_subtotal := v_subtotal + (r.qty * v_price);
    end loop;

    v_subtotal := round(v_subtotal, 2);
    v_n := coalesce(array_length(v_ids, 1), 0);

    -- discount (same rules as the POS screen)
    v_dtype := case when lower(coalesce(p_discount_type, '')) = 'percent' then 'percent' else 'fixed' end;
    v_dval  := round(greatest(0, coalesce(p_discount_value, 0)), 2);
    if v_dtype = 'percent' then
        v_discount := round(v_subtotal * least(100, v_dval) / 100, 2);
    else
        v_discount := round(least(v_subtotal, v_dval), 2);
    end if;

    -- GST: one rate on the discounted amount
    v_gst     := least(100, greatest(0, coalesce(p_gst_rate, 0)));
    v_taxable := v_subtotal - v_discount;
    v_tax     := round(v_taxable * v_gst / 100, 2);
    v_total   := v_taxable + v_tax;

    -- payment amounts
    if v_method = 'CASH' then
        v_tendered := coalesce(p_amount_tendered, v_total);
        if v_tendered < v_total then
            raise exception 'INSUFFICIENT_PAYMENT: cash tendered (%) is less than the total (%)', v_tendered, v_total;
        end if;
        v_change := v_tendered - v_total;
    else
        v_tendered := v_total;
        v_change   := 0;
    end if;

    -- customer: find by phone, else create. No phone => walk-in (customer_id NULL).
    v_phone := right(regexp_replace(coalesce(p_customer_phone, ''), '\D', '', 'g'), 10);
    if v_phone <> '' then
        if length(v_phone) <> 10 then
            raise exception 'INVALID_PHONE: phone number must have 10 digits';
        end if;

        select c.customer_id into v_customer_id from public.customers c where c.phone = v_phone;
        if v_customer_id is null then
            insert into public.customers (customer_name, phone)
            values (coalesce(nullif(trim(p_customer_name), ''), 'Customer ' || v_phone), v_phone)
            on conflict (phone) do nothing
            returning customer_id into v_customer_id;

            if v_customer_id is null then   -- created by someone else a moment ago
                select c.customer_id into v_customer_id from public.customers c where c.phone = v_phone;
            end if;
        end if;
    end if;

    -- bill header
    insert into public.bills
        (customer_id, bill_date, subtotal, discount, tax_amount, grand_total,
         payment_method, status, client_request_id, discount_type, discount_value, gst_rate)
    values
        (v_customer_id, now(), v_subtotal, v_discount, v_tax, v_total,
         v_method, 'PAID', p_request_id, v_dtype, v_dval, v_gst)
    on conflict (client_request_id) do nothing
    returning bill_id into v_bill_id;

    if v_bill_id is null then
        select bill_id into v_existing_id from public.bills where client_request_id = p_request_id;
        return public.get_bill_json(v_existing_id) || jsonb_build_object('already_processed', true);
    end if;

    update public.bills
       set bill_number = 'BILL-' || (1000 + bill_id)
     where bill_id = v_bill_id and bill_number is null;

    -- Pass 2: bill items (discount and tax spread over the lines), stock, ledger.
    for v_i in 1 .. v_n loop
        v_gross := v_qtys[v_i] * v_prices[v_i];

        if v_i = v_n then
            v_item_d := v_discount - v_alloc_d;
            v_item_t := v_tax - v_alloc_t;
        else
            v_item_d := case when v_subtotal > 0
                             then round(v_discount * v_gross / v_subtotal, 2) else 0 end;
            v_item_t := case when v_taxable > 0
                             then round(v_tax * (v_gross - v_item_d) / v_taxable, 2) else 0 end;
        end if;

        if v_item_d < 0 or v_item_d > v_gross or v_item_t < 0 then
            raise exception 'ALLOCATION_ERROR: could not split discount/tax across items';
        end if;
        v_alloc_d := v_alloc_d + v_item_d;
        v_alloc_t := v_alloc_t + v_item_t;

        insert into public.bill_items
            (bill_id, product_id, quantity, unit_price, discount, tax_amount, line_total)
        values
            (v_bill_id, v_ids[v_i], v_qtys[v_i], v_prices[v_i], v_item_d, v_item_t,
             round(v_gross - v_item_d + v_item_t, 2));

        update public.inventory
           set quantity     = quantity - v_qtys[v_i],
               last_updated = now()
         where product_id = v_ids[v_i]
           and quantity  >= v_qtys[v_i];
        if not found then
            raise exception 'INSUFFICIENT_STOCK: stock changed while the bill was being saved';
        end if;

        insert into public.stock_transactions
            (product_id, transaction_type, quantity_change, transaction_date, reference_id)
        values
            (v_ids[v_i], 'SALE', -v_qtys[v_i], now(), v_bill_id::text);
    end loop;

    -- payment (payments.amount must be > 0, so a 100%-discount bill has no payment row)
    if v_total > 0 then
        insert into public.payments
            (bill_id, payment_date, amount, payment_method, payment_status,
             amount_tendered, change_due, reference)
        values
            (v_bill_id, now(), v_total, v_method, 'SUCCESS',
             v_tendered, v_change, nullif(trim(coalesce(p_reference, '')), ''));
    end if;

    return public.get_bill_json(v_bill_id) || jsonb_build_object('already_processed', false);
end $$;


-- 2c) void_bill ------------------------------------------------------------
create or replace function public.void_bill(p_bill_id bigint)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
    v_status text;
    v_number text;
    r        record;
begin
    select b.status, b.bill_number into v_status, v_number
      from public.bills b
     where b.bill_id = p_bill_id
     for update;

    if not found then
        raise exception 'BILL_NOT_FOUND: bill % does not exist', p_bill_id;
    end if;
    if v_status <> 'PAID' then
        raise exception 'BILL_NOT_VOIDABLE: bill % is already %', coalesce(v_number, p_bill_id::text), v_status;
    end if;

    for r in
        select bi.product_id, bi.quantity
          from public.bill_items bi
         where bi.bill_id = p_bill_id
         order by bi.product_id
    loop
        insert into public.inventory (product_id) values (r.product_id)
        on conflict (product_id) do nothing;

        update public.inventory
           set quantity     = quantity + r.quantity,
               last_updated = now()
         where product_id = r.product_id;

        insert into public.stock_transactions
            (product_id, transaction_type, quantity_change, transaction_date, reference_id)
        values
            (r.product_id, 'RETURN', r.quantity, now(), 'VOID-' || coalesce(v_number, p_bill_id::text));
    end loop;

    update public.payments
       set payment_status = 'REFUNDED'
     where bill_id = p_bill_id and payment_status = 'SUCCESS';

    update public.bills set status = 'CANCELLED' where bill_id = p_bill_id;

    return public.get_bill_json(p_bill_id);
end $$;


-- 2d) adjust_stock ---------------------------------------------------------
-- p_op: 'IN' (add), 'OUT' (remove, never below 0), 'SET' (exact count)
create or replace function public.adjust_stock(
    p_product_id bigint,
    p_op         text,
    p_quantity   numeric,
    p_reason     text default null
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
    v_name   text;
    v_prev   numeric(10,3);
    v_new    numeric(10,3);
    v_change numeric(10,3);
    v_type   text;
begin
    p_op := upper(trim(coalesce(p_op, '')));
    if p_op not in ('IN', 'OUT', 'SET') then
        raise exception 'INVALID_OPERATION: %', coalesce(p_op, '(none)');
    end if;
    if p_quantity is null or p_quantity < 0 or (p_op <> 'SET' and p_quantity = 0) then
        raise exception 'INVALID_QUANTITY: quantity must be greater than 0';
    end if;

    select p.product_name into v_name
      from public.products p
     where p.product_id = p_product_id and p.is_active;
    if not found then
        raise exception 'PRODUCT_NOT_FOUND: product % does not exist or has been removed', p_product_id;
    end if;

    insert into public.inventory (product_id) values (p_product_id)
    on conflict (product_id) do nothing;

    select i.quantity into v_prev
      from public.inventory i
     where i.product_id = p_product_id
     for update;

    if p_op = 'IN' then
        v_new  := v_prev + p_quantity;
        v_type := 'PURCHASE';
    elsif p_op = 'OUT' then
        if p_quantity > v_prev then
            raise exception 'INSUFFICIENT_STOCK: cannot remove % - "%" has only % in stock',
                p_quantity, v_name, v_prev;
        end if;
        v_new  := v_prev - p_quantity;
        v_type := 'ADJUSTMENT';
    else
        v_new  := p_quantity;
        v_type := 'ADJUSTMENT';
    end if;

    v_change := v_new - v_prev;

    if v_change <> 0 then
        update public.inventory
           set quantity = v_new, last_updated = now()
         where product_id = p_product_id;

        insert into public.stock_transactions
            (product_id, transaction_type, quantity_change, transaction_date, reference_id)
        values
            (p_product_id, v_type, v_change, now(),
             left(coalesce(nullif(trim(p_reason), ''), 'Manual stock adjustment'), 200));
    end if;

    return jsonb_build_object(
        'product_id',     p_product_id,
        'product_name',   v_name,
        'previous_stock', v_prev,
        'new_stock',      v_new,
        'change',         v_change
    );
end $$;


-- 2e) save_product ---------------------------------------------------------
-- p_product_id NULL  => create (p_quantity = opening stock)
-- p_product_id set   => update; stock is changed only when p_quantity is not NULL
create or replace function public.save_product(
    p_product_id    bigint,
    p_name          text,
    p_barcode       text,
    p_category      text,
    p_price         numeric,
    p_tax_rate      numeric,
    p_unit          text,
    p_cost_price    numeric,
    p_supplier      text,
    p_expiry        date,
    p_quantity      numeric,
    p_reorder_level numeric
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
    v_id   bigint;
    v_prev numeric(10,3);
begin
    if p_name is null or length(trim(p_name)) = 0 then
        raise exception 'INVALID_PRODUCT: product name is required';
    end if;
    if p_category is null or length(trim(p_category)) = 0 then
        raise exception 'INVALID_PRODUCT: category is required';
    end if;
    if p_price is null or p_price < 0 then
        raise exception 'INVALID_PRODUCT: selling price must be 0 or more';
    end if;
    if p_quantity is not null and p_quantity < 0 then
        raise exception 'INVALID_QUANTITY: stock cannot be negative';
    end if;

    p_barcode := nullif(trim(coalesce(p_barcode, '')), '');

    -- free the barcode if only an archived (deleted) product holds it
    if p_barcode is not null then
        update public.products
           set barcode = barcode || '-ARCHIVED-' || product_id
         where barcode = p_barcode
           and not is_active
           and (p_product_id is null or product_id <> p_product_id);
    end if;

    if p_product_id is null then
        insert into public.products
            (product_name, barcode, category, price, tax_rate, unit, cost_price, supplier, expiry_date)
        values
            (trim(p_name), p_barcode, trim(p_category), p_price,
             coalesce(p_tax_rate, 0), coalesce(nullif(trim(p_unit), ''), 'pack'),
             p_cost_price, nullif(trim(coalesce(p_supplier, '')), ''), p_expiry)
        returning product_id into v_id;

        insert into public.inventory (product_id, quantity, reorder_level, last_updated)
        values (v_id, coalesce(p_quantity, 0), coalesce(p_reorder_level, 10), now());

        if coalesce(p_quantity, 0) > 0 then
            insert into public.stock_transactions
                (product_id, transaction_type, quantity_change, transaction_date, reference_id)
            values (v_id, 'PURCHASE', p_quantity, now(), 'New product opening stock');
        end if;
    else
        update public.products
           set product_name = trim(p_name),
               barcode      = p_barcode,
               category     = trim(p_category),
               price        = p_price,
               tax_rate     = coalesce(p_tax_rate, tax_rate),
               unit         = coalesce(nullif(trim(p_unit), ''), unit),
               cost_price   = p_cost_price,
               supplier     = nullif(trim(coalesce(p_supplier, '')), ''),
               expiry_date  = p_expiry
         where product_id = p_product_id and is_active
        returning product_id into v_id;
        if v_id is null then
            raise exception 'PRODUCT_NOT_FOUND: product % does not exist or has been removed', p_product_id;
        end if;

        insert into public.inventory (product_id) values (v_id)
        on conflict (product_id) do nothing;

        select i.quantity into v_prev from public.inventory i where i.product_id = v_id for update;

        update public.inventory
           set reorder_level = coalesce(p_reorder_level, reorder_level),
               last_updated  = now()
         where product_id = v_id;

        if p_quantity is not null and p_quantity <> v_prev then
            update public.inventory
               set quantity = p_quantity, last_updated = now()
             where product_id = v_id;

            insert into public.stock_transactions
                (product_id, transaction_type, quantity_change, transaction_date, reference_id)
            values (v_id, 'ADJUSTMENT', p_quantity - v_prev, now(), 'Manual stock count edit via product update');
        end if;
    end if;

    return jsonb_build_object('product_id', v_id);
end $$;


-- 2f) delete_product -------------------------------------------------------
-- Never sold   => removed completely (its stock ledger rows go with it).
-- Has sales    => archived (is_active = false) so old bills stay intact.
create or replace function public.delete_product(p_product_id bigint)
returns jsonb
language plpgsql
set search_path = public
as $$
begin
    perform 1 from public.products where product_id = p_product_id;
    if not found then
        raise exception 'PRODUCT_NOT_FOUND: product % does not exist', p_product_id;
    end if;

    if exists (select 1 from public.bill_items where product_id = p_product_id) then
        update public.products set is_active = false where product_id = p_product_id;
        return jsonb_build_object('product_id', p_product_id, 'mode', 'archived');
    end if;

    delete from public.stock_transactions where product_id = p_product_id;
    delete from public.products where product_id = p_product_id;   -- inventory row cascades
    return jsonb_build_object('product_id', p_product_id, 'mode', 'deleted');
end $$;


-- ---------------------------------------------------------------------
-- 3) PERMISSIONS: staff (authenticated) only, never the public anon key
-- ---------------------------------------------------------------------
revoke all on function public.get_bill_json(bigint)                                   from public, anon;
revoke all on function public.create_sale(uuid, text, text, jsonb, text, numeric, numeric, text, numeric, text) from public, anon;
revoke all on function public.void_bill(bigint)                                       from public, anon;
revoke all on function public.adjust_stock(bigint, text, numeric, text)               from public, anon;
revoke all on function public.save_product(bigint, text, text, text, numeric, numeric, text, numeric, text, date, numeric, numeric) from public, anon;
revoke all on function public.delete_product(bigint)                                  from public, anon;

grant execute on function public.get_bill_json(bigint)                                to authenticated;
grant execute on function public.create_sale(uuid, text, text, jsonb, text, numeric, numeric, text, numeric, text) to authenticated;
grant execute on function public.void_bill(bigint)                                    to authenticated;
grant execute on function public.adjust_stock(bigint, text, numeric, text)            to authenticated;
grant execute on function public.save_product(bigint, text, text, text, numeric, numeric, text, numeric, text, date, numeric, numeric) to authenticated;
grant execute on function public.delete_product(bigint)                               to authenticated;

-- Make the new functions and columns visible to the Supabase API immediately.
notify pgrst, 'reload schema';


-- ---------------------------------------------------------------------
-- 4) OPTIONAL CHECKS (run one at a time AFTER the migration; all read-only)
-- ---------------------------------------------------------------------
-- a) Bills without a number. Expected: 0 rows
--    select bill_id from public.bills where bill_number is null;
-- b) Inventory vs stock ledger. Expected: 0 rows
--    select i.product_id, i.quantity, coalesce(sum(t.quantity_change),0) as ledger
--      from public.inventory i
--      left join public.stock_transactions t using (product_id)
--     group by i.product_id, i.quantity
--    having i.quantity <> coalesce(sum(t.quantity_change),0);
-- c) Bill header vs bill items. Expected: 0 rows
--    select b.bill_id from public.bills b
--      join public.bill_items bi using (bill_id)
--     group by b.bill_id, b.grand_total
--    having b.grand_total <> sum(bi.line_total);
-- d) Paid bills without a payment. Expected: 0 rows (except 100%-discount bills)
--    select b.bill_id from public.bills b
--     where b.status = 'PAID' and b.grand_total > 0
--       and not exists (select 1 from public.payments p where p.bill_id = b.bill_id);
