-- [운영 적용 안내] PR 검토와 마이그레이션 적용 후, 전용 프로젝트에서 승인받아 실행합니다.
-- 외부 메시지는 발송하지 않습니다. 공개 승인된 예약 콘텐츠만 처리합니다.
create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;
select cron.schedule('kansai-approved-content-publisher','* * * * *','select private.publish_due_content();');
-- 복구 이력 영구 정리는 별도 승인을 받을 때까지 예약하지 않습니다.
update private.office_automation_settings set publisher_enabled=true where id=1;
-- 확인: cron.job의 해당 작업 active=true 및 cron.job_run_details 실행 결과를 확인합니다.
-- 중지 시 두 작업을 함께 수행합니다:
-- select cron.alter_job((select jobid from cron.job where jobname='kansai-approved-content-publisher'),active:=false);
-- update private.office_automation_settings set publisher_enabled=false where id=1;
