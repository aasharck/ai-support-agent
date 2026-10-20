-- Demo orders for the fictional shop. Emails use the reserved example.com domain.
insert into orders (id, customer_email, status, items, total_usd, placed_at, shipped_at, carrier, tracking_number, estimated_delivery) values
  ('TB-10041', 'maya@example.com', 'delivered', '[{"sku": "BLOOM-ONE", "name": "Bloom One espresso machine", "qty": 1}]', 649.00, '2026-10-02 09:14+04', '2026-10-02 15:30+04', 'Aramex', 'AX55012931', '2026-10-04'),
  ('TB-10042', 'sam@example.com', 'shipped', '[{"sku": "BURRLINE-64", "name": "Burrline 64 grinder", "qty": 1}, {"sku": "PELLETS", "name": "Grinder-cleaning pellets", "qty": 2}]', 412.00, '2026-10-15 11:02+04', '2026-10-16 13:45+04', 'DHL Express', '7741029384', '2026-10-21'),
  ('TB-10043', 'lena@example.com', 'processing', '[{"sku": "POURWELL", "name": "Pourwell kettle", "qty": 1}]', 119.00, '2026-10-19 20:31+04', null, null, null, null),
  ('TB-10044', 'omar@example.com', 'cancelled', '[{"sku": "GIFT-50", "name": "Gift card $50", "qty": 1}]', 50.00, '2026-10-08 08:00+04', null, null, null, null)
on conflict (id) do nothing;
