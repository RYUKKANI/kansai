-- [운영 적용] 승인된 예약 콘텐츠만 처리하고, 최근 콘텐츠 이력의 보관 기간을 관리합니다.
create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;
select cron.schedule('kansai-approved-content-publisher','* * * * *','select private.publish_due_content();');
update private.office_automation_settings set publisher_enabled=true where id=1;
