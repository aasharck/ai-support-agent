-- Schema for the support agent. Runs unchanged on Supabase (supabase db push, or
-- `npm run db:setup`) and on the embedded PGlite database used for local runs.
create extension if not exists vector;

-- Knowledge base: one row per source file, one row per chunk.
create table if not exists documents (
  id bigint generated always as identity primary key,
  path text not null unique,
  title text not null,
  checksum text not null,
  ingested_at timestamptz not null default now()
);

create table if not exists chunks (
  id bigint generated always as identity primary key,
  document_id bigint not null references documents (id) on delete cascade,
  ordinal int not null,
  section text not null,
  content text not null,
  -- 1024 dimensions: the local embedder produces this size, and the optional Voyage
  -- embedder asks for it (output_dimension: 1024).
  embedding vector(1024) not null
);

create index if not exists chunks_embedding_idx on chunks using hnsw (embedding vector_cosine_ops);

-- Cosine similarity search. Returns at most match_count chunks above min_similarity.
create or replace function match_chunks(query_embedding vector(1024), match_count int, min_similarity float)
returns table (id bigint, path text, title text, section text, content text, similarity float)
language sql stable
as $$
  select c.id, d.path, d.title, c.section, c.content, 1 - (c.embedding <=> query_embedding) as similarity
  from chunks c
  join documents d on d.id = c.document_id
  where 1 - (c.embedding <=> query_embedding) >= min_similarity
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

-- Demo business data the agent's tools read and write.
create table if not exists orders (
  id text primary key check (id ~ '^TB-[0-9]{5}$'),
  customer_email text not null,
  status text not null check (status in ('processing', 'shipped', 'delivered', 'cancelled')),
  items jsonb not null,
  total_usd numeric(10, 2) not null,
  placed_at timestamptz not null,
  shipped_at timestamptz,
  carrier text,
  tracking_number text,
  estimated_delivery date
);

create table if not exists tickets (
  id bigint generated always as identity primary key,
  email text not null,
  order_id text references orders (id),
  subject text not null,
  description text not null,
  priority text not null default 'normal' check (priority in ('low', 'normal', 'urgent')),
  status text not null default 'open',
  created_at timestamptz not null default now()
);

-- The app talks to the database from the server only. RLS on with no policies means
-- Supabase's public anon key can't read or write any of these tables through the API.
alter table documents enable row level security;
alter table chunks enable row level security;
alter table orders enable row level security;
alter table tickets enable row level security;
