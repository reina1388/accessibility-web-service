-- ============================================================
-- 웹 접근성 모니터링용 테이블
-- Supabase 대시보드 → SQL Editor → New query 에 전체를 붙여넣고 Run 하세요.
-- 여러 번 실행해도 안전합니다 (이미 있으면 건너뜀).
-- ============================================================

-- 1) 모니터링 설정 (id=1 한 행만 사용)
create table if not exists public.monitor_settings (
  id          int primary key default 1,
  enabled     boolean not null default true,
  cycle       text not null default 'daily'
              check (cycle in ('daily', 'weekly', 'biweekly', 'monthly')),
  updated_at  timestamptz not null default now(),
  constraint monitor_settings_single_row check (id = 1)
);

insert into public.monitor_settings (id) values (1)
on conflict (id) do nothing;

-- 2) 모니터링 대상 URL
create table if not exists public.monitors (
  id               uuid primary key default gen_random_uuid(),
  url              text not null unique,
  enabled          boolean not null default true,
  created_at       timestamptz not null default now(),
  last_checked_at  timestamptz,
  last_error       text,
  last_error_at    timestamptz
);

-- 3) 검사 이력 (URL이 삭제되면 이력도 함께 삭제)
create table if not exists public.check_history (
  id            uuid primary key default gen_random_uuid(),
  monitor_id    uuid not null references public.monitors(id) on delete cascade,
  checked_at    timestamptz not null default now(),
  triggered_by  text not null default 'schedule',   -- 'schedule'(자동) | 'manual'(수동)
  page_title    text,
  total         int not null default 0,              -- 위반 건수
  by_severity   jsonb not null default '{}'::jsonb,  -- {"critical":0,"serious":2,...}
  score         int,
  grade         text,
  findings      jsonb not null default '[]'::jsonb   -- [{"ruleId","title","severity"}, ...]
);

create index if not exists check_history_monitor_checked_idx
  on public.check_history (monitor_id, checked_at desc);

-- 4) 보안: RLS를 켜고 정책은 만들지 않음
--    → 브라우저용 공개 키(publishable/anon)로는 이 테이블을 전혀 읽을 수 없고,
--      서버의 비밀 키(secret / service_role)만 접근할 수 있습니다.
alter table public.monitor_settings enable row level security;
alter table public.monitors         enable row level security;
alter table public.check_history    enable row level security;

-- 5) 서버(비밀 키 = service_role 역할)에만 접근 권한 부여
--    ※ 2026년 5월 30일 이후 새 Supabase 프로젝트는 테이블을 만들어도 API 접근 권한이
--      자동으로 붙지 않으므로, 이 GRANT가 반드시 필요합니다.
grant select, insert, update, delete
  on public.monitor_settings, public.monitors, public.check_history
  to service_role;
