-- Minimal stand-ins for what Supabase provides (auth schema, auth.uid(), storage, roles) so the schema can be tested on plain Postgres.
create schema auth; create schema storage;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create table storage.buckets(id text primary key,name text,public bool);
create table storage.objects(id serial primary key,bucket_id text,name text);
create function storage.foldername(name text) returns text[] language sql as $$ select (string_to_array(name,'/'))[1:array_length(string_to_array(name,'/'),1)-1] $$;
do $$ begin if not exists (select 1 from pg_roles where rolname=$q$authenticated$q$) then create role authenticated; end if; if not exists (select 1 from pg_roles where rolname=$q$anon$q$) then create role anon; end if; end $$;
alter table storage.objects enable row level security;
