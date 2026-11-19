create table if not exists article_likes (slug text primary key, likes integer not null default 0, updated_at timestamptz not null default now());
