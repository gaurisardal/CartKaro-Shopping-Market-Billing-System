-- =====================================================================
-- SUPERMARKET BILLING SYSTEM - SCHEMA (PostgreSQL / Supabase)
-- Safe to re-run: uses IF NOT EXISTS and never drops tables or data.
-- Conventions: money = numeric(12,2); prices are tax-EXCLUSIVE and
-- tax_amount is added on top; timestamps are timestamptz.
-- =====================================================================

-- 1) PRODUCTS ---------------------------------------------------------
create table if not exists public.products (
    product_id    bigint generated always as identity primary key,
    product_name  text          not null check (length(trim(product_name)) > 0),
    barcode       text          unique,
    category      text          not null,
    price         numeric(10,2) not null check (price >= 0),
    tax_rate      numeric(5,2)  not null default 0 check (tax_rate between 0 and 100),
    unit          text          not null default 'pack'
);

-- 2) INVENTORY (one row per product) ----------------------------------
create table if not exists public.inventory (
    product_id     bigint primary key
                   references public.products(product_id) on delete cascade,
    quantity       numeric(10,3) not null default 0 check (quantity >= 0),
    reorder_level  numeric(10,3) not null default 10 check (reorder_level >= 0),
    last_updated   timestamptz   not null default now()
);

-- 3) CUSTOMERS --------------------------------------------------------
create table if not exists public.customers (
    customer_id    bigint generated always as identity primary key,
    customer_name  text not null check (length(trim(customer_name)) > 0),
    phone          text unique check (phone ~ '^[0-9]{10}$'),
    email          text unique check (email like '%_@_%')
);

-- 4) BILLS (customer_id is NULL for walk-in customers) -----------------
-- grand_total = subtotal - discount + tax_amount
create table if not exists public.bills (
    bill_id         bigint generated always as identity primary key,
    customer_id     bigint references public.customers(customer_id),
    bill_date       timestamptz   not null default now(),
    subtotal        numeric(12,2) not null default 0 check (subtotal    >= 0),
    discount        numeric(12,2) not null default 0 check (discount    >= 0),
    tax_amount      numeric(12,2) not null default 0 check (tax_amount  >= 0),
    grand_total     numeric(12,2) not null default 0 check (grand_total >= 0),
    payment_method  text not null check (payment_method in ('CASH','CARD','UPI')),
    status          text not null default 'PENDING'
                    check (status in ('PENDING','PAID','CANCELLED','REFUNDED')),
    constraint chk_bills_total
        check (grand_total = round(subtotal - discount + tax_amount, 2))
);

-- 5) BILL_ITEMS (unit_price = price at time of sale = history preserved) --
-- line_total = quantity * unit_price - discount + tax_amount
create table if not exists public.bill_items (
    bill_item_id  bigint generated always as identity primary key,
    bill_id       bigint        not null
                  references public.bills(bill_id) on delete cascade,
    product_id    bigint        not null
                  references public.products(product_id),
    quantity      numeric(10,3) not null check (quantity > 0),
    unit_price    numeric(10,2) not null check (unit_price >= 0),
    discount      numeric(10,2) not null default 0 check (discount >= 0),
    tax_amount    numeric(10,2) not null default 0 check (tax_amount >= 0),
    line_total    numeric(12,2) not null check (line_total >= 0),
    constraint uq_bill_items_bill_product unique (bill_id, product_id),
    constraint chk_bill_items_discount check (discount <= quantity * unit_price),
    constraint chk_bill_items_total
        check (line_total = round(quantity * unit_price - discount + tax_amount, 2))
);

-- 6) PAYMENTS (a bill may have more than one payment, e.g. split payment) --
create table if not exists public.payments (
    payment_id      bigint generated always as identity primary key,
    bill_id         bigint        not null
                    references public.bills(bill_id) on delete cascade,
    payment_date    timestamptz   not null default now(),
    amount          numeric(12,2) not null check (amount > 0),
    payment_method  text not null check (payment_method in ('CASH','CARD','UPI')),
    payment_status  text not null default 'SUCCESS'
                    check (payment_status in ('PENDING','SUCCESS','FAILED','REFUNDED'))
);

-- 7) STOCK_TRANSACTIONS (+ve = stock in, -ve = stock out) ---------------
-- reference_id: bill_id (as text) for sales, or a note like 'OPENING-STOCK'
create table if not exists public.stock_transactions (
    transaction_id    bigint generated always as identity primary key,
    product_id        bigint        not null
                      references public.products(product_id),
    transaction_type  text          not null
                      check (transaction_type in ('PURCHASE','SALE','RETURN','ADJUSTMENT')),
    quantity_change   numeric(10,3) not null check (quantity_change <> 0),
    transaction_date  timestamptz   not null default now(),
    reference_id      text
);

-- 8) USERS (staff table; see security notes below) ---------------------
create table if not exists public.users (
    user_id        bigint generated always as identity primary key,
    username       text not null unique check (length(trim(username)) > 0),
    password_hash  text not null,
    role           text not null default 'cashier'
                   check (role in ('admin','manager','cashier'))
);

-- INDEXES (PK / UNIQUE columns are already indexed) ---------------------
create index if not exists idx_products_category      on public.products(category);
create index if not exists idx_products_name          on public.products(product_name);
create index if not exists idx_bills_customer         on public.bills(customer_id);
create index if not exists idx_bills_date             on public.bills(bill_date);
create index if not exists idx_bill_items_product     on public.bill_items(product_id);
create index if not exists idx_payments_bill          on public.payments(bill_id);
create index if not exists idx_stock_tx_product       on public.stock_transactions(product_id);
create index if not exists idx_stock_tx_date          on public.stock_transactions(transaction_date);

-- =====================================================================
-- SECURITY (Row Level Security)
-- 1. Turn RLS ON for all 8 tables. With RLS on and no policy, the public
--    "anon" key can read/write NOTHING.
-- 2. USERS gets no policies and all API access is revoked, so password
--    hashes can never be fetched through the Supabase API.
-- 3. The other 7 tables are opened ONLY to logged-in Supabase Auth users
--    ("authenticated"). In Authentication settings, turn OFF public
--    sign-ups and create staff accounts yourself.
-- 4. Never put the service_role key in frontend code. Use it only in a
--    server/backend. The SQL Editor runs as an admin role, so seeding
--    still works.
-- =====================================================================
do $$
declare
    t text;
begin
    foreach t in array array['products','inventory','customers','bills',
                             'bill_items','payments','stock_transactions','users']
    loop
        execute format('alter table public.%I enable row level security', t);
    end loop;

    foreach t in array array['products','inventory','customers','bills',
                             'bill_items','payments','stock_transactions']
    loop
        execute format('drop policy if exists %I on public.%I', 'staff_all_' || t, t);
        execute format(
            'create policy %I on public.%I for all to authenticated using (true) with check (true)',
            'staff_all_' || t, t);
    end loop;
end $$;

revoke all on public.users from anon, authenticated;
-- =====================================================================
-- SUPERMARKET BILLING SYSTEM - SEED DATA
-- Run AFTER 01_schema.sql.
--
-- ILLUSTRATIVE SYNTHETIC DATA ONLY: product names, INR prices, GST rates,
-- customers, bills and stock levels are generated for a college demo.
-- They are NOT verified live retail prices or tax advice.
--
-- Re-run behaviour: products/customers/users use ON CONFLICT DO NOTHING;
-- the bills block runs only if the bills table is empty, so no duplicates.
-- =====================================================================

-- 1) PRODUCTS (200) - synthetic barcodes 2000000000001 ... 2000000000200 --
insert into public.products (product_name, barcode, category, price, tax_rate, unit)
select v.name,
       '2' || lpad((row_number() over ())::text, 12, '0'),
       v.category, v.price, v.tax, v.unit
from (values
-- ---- Grocery (50) ----
('Basmati Rice 1 kg','Grocery',120,5,'pack'),
('Basmati Rice 5 kg','Grocery',590,5,'pack'),
('Sona Masoori Rice 5 kg','Grocery',360,5,'pack'),
('Whole Wheat Atta 5 kg','Grocery',255,5,'pack'),
('Whole Wheat Atta 10 kg','Grocery',480,5,'pack'),
('Multigrain Atta 1 kg','Grocery',70,5,'pack'),
('Maida 1 kg','Grocery',48,5,'pack'),
('Sooji (Rava) 500 g','Grocery',34,5,'pack'),
('Besan 500 g','Grocery',62,5,'pack'),
('Poha Thick 500 g','Grocery',48,5,'pack'),
('Toor Dal 1 kg','Grocery',165,5,'pack'),
('Moong Dal 1 kg','Grocery',130,5,'pack'),
('Chana Dal 1 kg','Grocery',98,5,'pack'),
('Masoor Dal 1 kg','Grocery',95,5,'pack'),
('Urad Dal 1 kg','Grocery',150,5,'pack'),
('Rajma 500 g','Grocery',82,5,'pack'),
('Kabuli Chana 500 g','Grocery',88,5,'pack'),
('Green Moong Whole 500 g','Grocery',70,5,'pack'),
('Sunflower Oil 1 litre','Grocery',145,5,'pouch'),
('Mustard Oil 1 litre','Grocery',170,5,'bottle'),
('Groundnut Oil 1 litre','Grocery',195,5,'bottle'),
('Sugar 1 kg','Grocery',48,5,'pack'),
('Jaggery 500 g','Grocery',45,5,'pack'),
('Iodised Salt 1 kg','Grocery',25,0,'pack'),
('Turmeric Powder 200 g','Grocery',55,5,'pack'),
('Red Chilli Powder 200 g','Grocery',78,5,'pack'),
('Coriander Powder 200 g','Grocery',52,5,'pack'),
('Garam Masala 100 g','Grocery',68,5,'pack'),
('Cumin Seeds 100 g','Grocery',58,5,'pack'),
('Mustard Seeds 100 g','Grocery',22,5,'pack'),
('Black Pepper 50 g','Grocery',62,5,'pack'),
('Cashew Nuts 250 g','Grocery',240,5,'pack'),
('Almonds 250 g','Grocery',260,5,'pack'),
('Raisins 250 g','Grocery',120,5,'pack'),
('Raw Peanuts 500 g','Grocery',90,5,'pack'),
('Tamarind 200 g','Grocery',40,5,'pack'),
('Mango Pickle 400 g','Grocery',110,12,'jar'),
('Tomato Ketchup 500 g','Grocery',110,12,'bottle'),
('Mixed Fruit Jam 500 g','Grocery',145,12,'jar'),
('Peanut Butter 340 g','Grocery',175,12,'jar'),
('Honey 250 g','Grocery',130,12,'bottle'),
('Instant Noodles 70 g','Grocery',14,12,'pack'),
('Penne Pasta 500 g','Grocery',95,12,'pack'),
('Vermicelli 400 g','Grocery',45,5,'pack'),
('Corn Flakes 475 g','Grocery',195,12,'pack'),
('Rolled Oats 1 kg','Grocery',175,12,'pack'),
('Muesli 500 g','Grocery',230,12,'pack'),
('Baking Soda 100 g','Grocery',20,18,'pack'),
('Coconut Oil 500 ml','Grocery',140,5,'bottle'),
('Sabudana 500 g','Grocery',60,5,'pack'),
-- ---- Dairy (30) ----
('Toned Milk 500 ml','Dairy',27,0,'pouch'),
('Full Cream Milk 500 ml','Dairy',34,0,'pouch'),
('Double Toned Milk 1 litre','Dairy',54,0,'pouch'),
('Curd Cup 400 g','Dairy',40,5,'pack'),
('Curd Pouch 1 kg','Dairy',85,5,'pouch'),
('Plain Dahi Cup 200 g','Dairy',22,5,'pack'),
('Greek Yogurt 100 g','Dairy',40,5,'pack'),
('Buttermilk 200 ml','Dairy',15,5,'pack'),
('Sweet Lassi 200 ml','Dairy',25,12,'pack'),
('Salted Butter 100 g','Dairy',58,12,'pack'),
('Salted Butter 500 g','Dairy',280,12,'pack'),
('Cow Ghee 500 ml','Dairy',340,12,'jar'),
('Cow Ghee 1 litre','Dairy',660,12,'jar'),
('Paneer 200 g','Dairy',90,5,'pack'),
('Paneer 500 g','Dairy',215,5,'pack'),
('Cheese Slices 200 g','Dairy',140,12,'pack'),
('Processed Cheese Block 400 g','Dairy',260,12,'pack'),
('Mozzarella Cheese 200 g','Dairy',150,12,'pack'),
('Cheese Spread 180 g','Dairy',110,12,'jar'),
('Fresh Cream 200 ml','Dairy',70,5,'pack'),
('Condensed Milk 400 g','Dairy',135,12,'pack'),
('Milk Powder 500 g','Dairy',290,5,'pack'),
('Chocolate Milk 200 ml','Dairy',30,12,'pack'),
('Rose Milk 200 ml','Dairy',30,12,'pack'),
('Mango Shrikhand 100 g','Dairy',45,5,'pack'),
('Vanilla Ice Cream 500 ml','Dairy',190,18,'pack'),
('Chocolate Ice Cream 500 ml','Dairy',210,18,'pack'),
('Farm Eggs 6 pcs','Dairy',48,0,'tray'),
('Farm Eggs 12 pcs','Dairy',92,0,'tray'),
('Strawberry Yogurt 100 g','Dairy',30,12,'pack'),
-- ---- Beverages (30) ----
('Black Tea Leaves 250 g','Beverages',135,5,'pack'),
('Black Tea Leaves 500 g','Beverages',255,5,'pack'),
('Green Tea Bags 25 pcs','Beverages',150,5,'pack'),
('Masala Tea Powder 250 g','Beverages',140,5,'pack'),
('Instant Coffee 50 g','Beverages',165,18,'jar'),
('Instant Coffee 100 g','Beverages',310,18,'jar'),
('Filter Coffee Powder 200 g','Beverages',150,18,'pack'),
('Malt Health Drink 500 g','Beverages',235,18,'jar'),
('Chocolate Health Drink 500 g','Beverages',240,18,'jar'),
('Cola 750 ml','Beverages',40,18,'bottle'),
('Cola 2 litre','Beverages',95,18,'bottle'),
('Lemon Soda 750 ml','Beverages',40,18,'bottle'),
('Orange Soft Drink 750 ml','Beverages',40,18,'bottle'),
('Packaged Drinking Water 1 litre','Beverages',20,18,'bottle'),
('Mineral Water 500 ml','Beverages',12,18,'bottle'),
('Sparkling Water 750 ml','Beverages',60,18,'bottle'),
('Mixed Fruit Juice 1 litre','Beverages',120,12,'pack'),
('Orange Juice 1 litre','Beverages',125,12,'pack'),
('Apple Juice 1 litre','Beverages',130,12,'pack'),
('Mango Drink 600 ml','Beverages',45,12,'bottle'),
('Guava Drink 200 ml','Beverages',15,12,'pack'),
('Coconut Water 200 ml','Beverages',40,12,'pack'),
('Energy Drink 250 ml','Beverages',125,18,'pack'),
('Glucose Powder Orange 200 g','Beverages',70,18,'pack'),
('Rose Syrup 750 ml','Beverages',150,18,'bottle'),
('Jaljeera Drink 200 ml','Beverages',20,12,'pack'),
('Lemon Iced Tea 250 ml','Beverages',30,12,'pack'),
('Cold Coffee 200 ml','Beverages',50,12,'pack'),
('Soda Water 750 ml','Beverages',25,18,'bottle'),
('Lemon Squash 750 ml','Beverages',140,12,'bottle'),
-- ---- Snacks (35) ----
('Potato Chips Salted 52 g','Snacks',20,12,'pack'),
('Potato Chips Masala 52 g','Snacks',20,12,'pack'),
('Potato Chips Cream & Onion 90 g','Snacks',40,12,'pack'),
('Corn Puffs 40 g','Snacks',10,12,'pack'),
('Aloo Bhujia 200 g','Snacks',55,12,'pack'),
('Namkeen Mixture 400 g','Snacks',110,12,'pack'),
('Moong Dal Namkeen 200 g','Snacks',60,12,'pack'),
('Roasted Chana 200 g','Snacks',45,5,'pack'),
('Salted Peanuts 150 g','Snacks',40,12,'pack'),
('Butter Popcorn 100 g','Snacks',40,12,'pack'),
('Cheese Nachos 150 g','Snacks',70,12,'pack'),
('Cream Biscuits 100 g','Snacks',20,18,'pack'),
('Glucose Biscuits 200 g','Snacks',25,18,'pack'),
('Marie Biscuits 250 g','Snacks',40,18,'pack'),
('Digestive Biscuits 250 g','Snacks',85,18,'pack'),
('Choco Chip Cookies 150 g','Snacks',60,18,'pack'),
('Butter Cookies 200 g','Snacks',90,18,'pack'),
('Rusk Toast 300 g','Snacks',55,18,'pack'),
('Methi Khakhra 200 g','Snacks',70,12,'pack'),
('Urad Papad 200 g','Snacks',65,12,'pack'),
('Milk Chocolate Bar 40 g','Snacks',50,18,'pc'),
('Dark Chocolate Bar 50 g','Snacks',85,18,'pc'),
('Chocolate Wafer 30 g','Snacks',20,18,'pc'),
('Fruit & Nut Chocolate 90 g','Snacks',120,18,'pc'),
('Assorted Candy Pouch 150 g','Snacks',60,18,'pack'),
('Mint Candy Pack 100 g','Snacks',40,18,'pack'),
('Bubble Gum Pack 10 pcs','Snacks',10,18,'pack'),
('Gulab Jamun Mix 175 g','Snacks',70,12,'pack'),
('Instant Tomato Soup 4 sachets','Snacks',50,18,'pack'),
('Instant Cup Noodles 70 g','Snacks',50,12,'pc'),
('Protein Bar 50 g','Snacks',100,18,'pc'),
('Granola Bar 35 g','Snacks',30,18,'pc'),
('Seedless Dates 250 g','Snacks',85,5,'pack'),
('Roasted Makhana 60 g','Snacks',95,5,'pack'),
('Trail Mix 200 g','Snacks',190,12,'pack'),
-- ---- Household (28) ----
('Detergent Powder 1 kg','Household',120,18,'pack'),
('Detergent Powder 4 kg','Household',440,18,'pack'),
('Liquid Detergent 1 litre','Household',230,18,'bottle'),
('Detergent Bar Pack of 4','Household',70,18,'pack'),
('Dishwash Liquid 500 ml','Household',105,18,'bottle'),
('Dishwash Bar 250 g','Household',25,18,'pc'),
('Floor Cleaner 1 litre','Household',190,18,'bottle'),
('Toilet Cleaner 500 ml','Household',95,18,'bottle'),
('Glass Cleaner 500 ml','Household',120,18,'bottle'),
('Disinfectant Liquid 500 ml','Household',130,18,'bottle'),
('Fabric Softener 1 litre','Household',210,18,'bottle'),
('Toilet Paper 4 rolls','Household',120,18,'pack'),
('Kitchen Tissue 2 rolls','Household',110,18,'pack'),
('Facial Tissue Box 100 pulls','Household',60,18,'box'),
('Aluminium Foil 9 m','Household',80,18,'roll'),
('Cling Wrap 30 m','Household',95,18,'roll'),
('Garbage Bags Medium 30 pcs','Household',85,18,'pack'),
('Sponge Scrub Pack of 3','Household',45,18,'pack'),
('Steel Scrub Pad Pack of 3','Household',40,18,'pack'),
('Mosquito Repellent Refill','Household',78,18,'pc'),
('Room Freshener Spray 220 ml','Household',180,18,'bottle'),
('Insect Spray 400 ml','Household',230,18,'bottle'),
('Matchbox Pack of 10','Household',20,12,'pack'),
('Candles Pack of 6','Household',45,18,'pack'),
('Incense Sticks Pack','Household',60,12,'pack'),
('Camphor Tablets 50 g','Household',70,12,'pack'),
('LED Bulb 9W','Household',99,18,'pc'),
('AA Batteries Pack of 4','Household',120,18,'pack'),
-- ---- Personal Care (27) ----
('Bath Soap 100 g','Personal Care',40,18,'pc'),
('Bath Soap Pack of 4','Personal Care',150,18,'pack'),
('Body Wash 250 ml','Personal Care',220,18,'bottle'),
('Shampoo 180 ml','Personal Care',150,18,'bottle'),
('Anti-Dandruff Shampoo 340 ml','Personal Care',330,18,'bottle'),
('Hair Conditioner 180 ml','Personal Care',170,18,'bottle'),
('Coconut Hair Oil 200 ml','Personal Care',95,18,'bottle'),
('Amla Hair Oil 200 ml','Personal Care',110,18,'bottle'),
('Toothpaste 150 g','Personal Care',95,18,'pack'),
('Herbal Toothpaste 200 g','Personal Care',120,18,'pack'),
('Toothbrush Medium','Personal Care',35,18,'pc'),
('Toothbrush Pack of 3','Personal Care',90,18,'pack'),
('Mouthwash 250 ml','Personal Care',125,18,'bottle'),
('Face Wash 100 ml','Personal Care',150,18,'pc'),
('Face Cream 50 g','Personal Care',140,18,'pc'),
('Body Lotion 250 ml','Personal Care',230,18,'bottle'),
('Sunscreen SPF 50 50 g','Personal Care',280,18,'pc'),
('Deodorant Spray 150 ml','Personal Care',190,18,'bottle'),
('Talcum Powder 200 g','Personal Care',110,18,'pack'),
('Disposable Razor Pack of 3','Personal Care',60,18,'pack'),
('Shaving Foam 200 g','Personal Care',160,18,'pc'),
('Sanitary Pads Regular 20 pcs','Personal Care',140,12,'pack'),
('Sanitary Pads XL 30 pcs','Personal Care',210,12,'pack'),
('Liquid Hand Wash 250 ml','Personal Care',99,18,'bottle'),
('Hand Sanitizer 100 ml','Personal Care',75,18,'bottle'),
('Cotton Buds 100 pcs','Personal Care',45,18,'pack'),
('Baby Diapers Medium 20 pcs','Personal Care',320,12,'pack')
) as v(name, category, price, tax, unit)
on conflict (barcode) do nothing;

-- 2) CUSTOMERS (30 fictional) - phones are 10-digit placeholders starting
--    with 0 (not dialable); emails use the reserved example.com domain.
insert into public.customers (customer_name, phone, email)
select t.name,
       lpad(t.n::text, 10, '0'),
       'customer' || lpad(t.n::text, 2, '0') || '@example.com'
from unnest(array[
  'Aarav Mehta','Diya Nair','Vivaan Kulkarni','Ananya Iyer','Aditya Deshmukh',
  'Isha Reddy','Kabir Malhotra','Meera Joshi','Rohan Patil','Saanvi Gupta',
  'Arjun Singh','Kavya Menon','Neil Fernandes','Priya Shetty','Yash Chauhan',
  'Tanvi Bhatt','Om Pawar','Riya Kapoor','Dev Sharma','Sneha Rao',
  'Harsh Vora','Pooja Naik','Karan Thakur','Nisha Pillai','Siddharth Jain',
  'Ritika Sawant','Manav Bose','Aisha Khan','Varun Gokhale','Lavanya Das'
]) with ordinality as t(name, n)
on conflict (phone) do nothing;

-- 3) USERS (3) - PLACEHOLDER hashes that cannot be used to log in.
--    Real hashes must be generated by your backend (bcrypt/argon2), or
--    better, use Supabase Auth for actual login.
insert into public.users (username, password_hash, role)
values ('demo_admin',   'PLACEHOLDER_NOT_A_REAL_HASH', 'admin'),
       ('demo_manager', 'PLACEHOLDER_NOT_A_REAL_HASH', 'manager'),
       ('demo_cashier', 'PLACEHOLDER_NOT_A_REAL_HASH', 'cashier')
on conflict (username) do nothing;

-- 4) BILLS (50), BILL_ITEMS (200), PAYMENTS (50), STOCK_TRANSACTIONS (400),
--    INVENTORY (200). Generated deterministically so every total matches.
--    Bills 4, 8, 12 ... are walk-in customers (customer_id NULL).
do $$
begin
    if exists (select 1 from public.bills) then
        raise notice 'Bills already exist - sample bills skipped.';
        return;
    end if;

    -- 4a) work table: line items (2 to 6 distinct products per bill)
    create temp table seed_items on commit drop as
    with prod as (
        select product_id, price, tax_rate,
               row_number() over (order by barcode) as rn
        from public.products
        where barcode like '2000000000%'
    ),
    pairs as (
        select b.i as bill_id, g.j,
               ((b.i * 13 + g.j * 41) % 200) + 1 as rn,
               1 + ((b.i + g.j * 3) % 3)         as qty
        from generate_series(1, 50) as b(i)
        cross join lateral generate_series(1, 2 + (b.i % 5)) as g(j)
    ),
    priced as (
        select pa.bill_id, p.product_id,
               pa.qty::numeric(10,3) as quantity,
               p.price               as unit_price,
               case when (pa.bill_id + pa.j) % 6 = 0
                    then round(pa.qty * p.price * 0.05, 2)
                    else 0 end       as discount,
               p.tax_rate
        from pairs pa
        join prod p on p.rn = pa.rn
    ),
    taxed as (
        select bill_id, product_id, quantity, unit_price, discount,
               round((quantity * unit_price - discount) * tax_rate / 100, 2) as tax_amount
        from priced
    )
    select bill_id, product_id, quantity, unit_price, discount, tax_amount,
           round(quantity * unit_price - discount + tax_amount, 2) as line_total
    from taxed;

    -- 4b) bills (explicit IDs 1..50; sequence is fixed at the end)
    with cust as (
        select customer_id, row_number() over (order by customer_id) as rn
        from public.customers
        where email like 'customer%@example.com'
    ),
    agg as (
        select bill_id,
               round(sum(quantity * unit_price), 2) as subtotal,
               sum(discount)                        as discount,
               sum(tax_amount)                      as tax_amount
        from seed_items
        group by bill_id
    )
    insert into public.bills
        (bill_id, customer_id, bill_date, subtotal, discount, tax_amount,
         grand_total, payment_method, status)
    overriding system value
    select a.bill_id,
           c.customer_id,
           timestamptz '2026-10-01 09:00:00+05:30'
               + (a.bill_id - 1) * interval '11 hours 17 minutes',
           a.subtotal, a.discount, a.tax_amount,
           round(a.subtotal - a.discount + a.tax_amount, 2),
           (array['CASH','UPI','CARD'])[1 + a.bill_id % 3],
           'PAID'
    from agg a
    left join cust c
           on c.rn = ((a.bill_id * 7) % 30) + 1
          and a.bill_id % 4 <> 0;

    -- 4c) bill items (unit_price = selling price captured at sale time)
    insert into public.bill_items
        (bill_id, product_id, quantity, unit_price, discount, tax_amount, line_total)
    select bill_id, product_id, quantity, unit_price, discount, tax_amount, line_total
    from seed_items
    order by bill_id, product_id;

    -- 4d) one successful payment per bill
    insert into public.payments
        (bill_id, payment_date, amount, payment_method, payment_status)
    select bill_id, bill_date + interval '2 minutes', grand_total, payment_method, 'SUCCESS'
    from public.bills
    order by bill_id;

    -- 4e) stock ledger: opening stock, then one SALE row per bill item
    insert into public.stock_transactions
        (product_id, transaction_type, quantity_change, transaction_date, reference_id)
    select product_id, 'PURCHASE',
           100 + ((row_number() over (order by barcode) * 7) % 150),
           timestamptz '2026-09-30 08:00:00+05:30',
           'OPENING-STOCK'
    from public.products
    where barcode like '2000000000%';

    insert into public.stock_transactions
        (product_id, transaction_type, quantity_change, transaction_date, reference_id)
    select si.product_id, 'SALE', -si.quantity, b.bill_date, si.bill_id::text
    from seed_items si
    join public.bills b on b.bill_id = si.bill_id
    order by si.bill_id, si.product_id;

    -- 4f) inventory = sum of the stock ledger
    insert into public.inventory (product_id, quantity, reorder_level, last_updated)
    select product_id, sum(quantity_change), 20, now()
    from public.stock_transactions
    group by product_id
    on conflict (product_id) do nothing;

    -- 4g) make the identity sequence continue after the seeded bill IDs
    perform setval(pg_get_serial_sequence('public.bills', 'bill_id'),
                   (select max(bill_id) from public.bills));
end $$;
-- Run these one at a time in the Supabase SQL Editor (or select one and press Run).

-- 1) Row counts. Expected: products 200, inventory 200, customers 30,
--    bills 50, bill_items 200, payments 50, stock_transactions 400, users 3
select 'products' as tbl, count(*) from public.products
union all select 'inventory',          count(*) from public.inventory
union all select 'customers',          count(*) from public.customers
union all select 'bills',              count(*) from public.bills
union all select 'bill_items',         count(*) from public.bill_items
union all select 'payments',           count(*) from public.payments
union all select 'stock_transactions', count(*) from public.stock_transactions
union all select 'users',              count(*) from public.users;

-- 2) Bill header totals vs. their items. Expected: 0 rows
select b.bill_id
from public.bills b
join public.bill_items i on i.bill_id = b.bill_id
group by b.bill_id, b.subtotal, b.discount, b.tax_amount, b.grand_total
having b.subtotal    <> round(sum(i.quantity * i.unit_price), 2)
    or b.discount    <> sum(i.discount)
    or b.tax_amount  <> sum(i.tax_amount)
    or b.grand_total <> sum(i.line_total);

-- 3) Payments vs. bill totals. Expected: 0 rows
select b.bill_id, b.grand_total, coalesce(sum(p.amount), 0) as paid
from public.bills b
left join public.payments p on p.bill_id = b.bill_id and p.payment_status = 'SUCCESS'
where b.status = 'PAID'
group by b.bill_id, b.grand_total
having b.grand_total <> coalesce(sum(p.amount), 0);

-- 4) Inventory vs. stock ledger. Expected: 0 rows
select i.product_id, i.quantity, s.ledger_qty
from public.inventory i
join (select product_id, sum(quantity_change) as ledger_qty
      from public.stock_transactions group by product_id) s using (product_id)
where i.quantity <> s.ledger_qty;

-- 5) Walk-in bills (no customer). Expected: 12
select count(*) as walk_in_bills from public.bills where customer_id is null;

-- 6) One full bill with its items
select b.bill_id, b.bill_date, coalesce(c.customer_name, 'Walk-in') as customer,
       p.product_name, i.quantity, i.unit_price, i.discount, i.tax_amount, i.line_total,
       b.grand_total
from public.bills b
left join public.customers c on c.customer_id = b.customer_id
join public.bill_items i     on i.bill_id = b.bill_id
join public.products p       on p.product_id = i.product_id
where b.bill_id = 1
order by i.bill_item_id;

-- 7) Products per category
select category, count(*) as products, min(price) as min_price, max(price) as max_price
from public.products group by category order by category;

-- 8) Low-stock check (empty right after seeding)
select p.product_name, i.quantity, i.reorder_level
from public.inventory i join public.products p using (product_id)
where i.quantity <= i.reorder_level;
SELECT
    table_name,
    (xpath(
        '/row/count/text()',
        query_to_xml(
            format(
                'SELECT COUNT(*) AS count FROM public.%I',
                table_name
            ),
            false,
            true,
            ''
        )
    ))[1]::text::bigint AS total_records
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_type = 'BASE TABLE'
ORDER BY table_name;