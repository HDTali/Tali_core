alter table reading_requests add column if not exists lang text not null default 'en';
