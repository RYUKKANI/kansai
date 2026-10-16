import assert from 'node:assert/strict';
import test from 'node:test';
import { officeDatabase } from './office-database.mjs';

// 실제 PostgreSQL 정책/트리거/RPC를 가상 계정으로 호출합니다. 운영 계정이나 외부 인증 서비스는 사용하지 않습니다.
const { db, as, user } = await officeDatabase();
const rows = async (sql, values=[]) => (await db.query(sql,values)).rows;
const reject = async (sql, values=[]) => assert.rejects(db.query(sql,values));
async function privileged() {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub','',false),set_config('request.jwt.claim.session_id','',false)");
}
const save = async (entity,id,expected,values,at=null) => (await rows('select public.save_office_content($1,$2,$3,$4,$5) item',[entity,id,expected,values,at]))[0].item;

try {
  await privileged();
  for (const [n,role,status] of [[6,'player','approved'],[7,'staff','pending'],[8,'staff','suspended'],[9,'staff','approved']]) {
    await db.query("insert into auth.users(id,email) values($1,$2)",[user(n),`grade-${n}@example.invalid`]);
    await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[user(n+10000),user(n)]);
    await db.query("insert into public.admin_roles(user_id,email,role,active) values($1,$2,$3,true)",[user(n),`grade-${n}@example.invalid`,role]);
    await db.query("insert into private.staff_accounts(user_id,username,real_name,department,approval_status,email_confirmation_required,notice_accepted_at) values($1,$2,'TEST Grade Member','TEST Assignment',$3,false,now())",[user(n),`grade.${n}`,status]);
  }

  await test('three effective grades preserve existing raw roles and deny pending or suspended authority',async()=>{
    for (const [n,grade] of [[1,'owner'],[2,'staff'],[3,'staff'],[4,'staff'],[6,'player'],[9,'staff'],[5,null],[7,null],[8,null]]) {
      await as(n);
      assert.equal((await rows('select private.current_role() role'))[0].role,grade);
      const caps=(await rows('select public.office_capabilities() item'))[0].item;
      if (grade==='player') {
        assert.equal(caps.player_portal,true);
        for(const key of ['content','schedule','players','media','directory','audit','publish','manage_members','publisher']) assert.equal(caps[key],false,key);
      } else if (grade==='staff') {
        assert.equal(caps.content,true); assert.equal(caps.schedule,true);
        assert.equal(caps.publish,false); assert.equal(caps.manage_members,false);
      } else if (grade===null) assert.deepEqual(caps,{});
    }
    await privileged();
    assert.deepEqual((await rows('select role from public.admin_roles where user_id=any($1::uuid[]) order by user_id',[[user(1),user(2),user(3),user(4)]] )).map(r=>r.role),['owner','administrator','editor','coach']);
  });

  await as(1);
  const liveArticle=(await rows("insert into public.articles(slug,title,summary,body,cover_alt,status) values('grade-live-news','TEST Live','TEST Summary','TEST Body','TEST Alt','published') returning *"))[0];
  const liveAlbum=(await rows("insert into public.media_albums(title,status) values('TEST Live Album','published') returning *"))[0];
  const liveMedia=(await rows("insert into public.media_assets(kind,title,legacy_path,alt_text,consent_confirmed,status,media_category,album_id) values('photo','TEST Live Photo','assets/grade-live-photo.jpg','TEST Alt',true,'published','player',$1) returning *",[liveAlbum.id]))[0];
  const livePlayer=(await rows("insert into public.players(internal_name,profile_consent,photo_consent,photo_asset_id) values('TEST Live Player',true,true,$1) returning *",[liveMedia.id]))[0];
  await db.query("insert into public.public_player_profiles(player_id,slug,display_name,position,photo_path,status) values($1,'grade-live-player','TEST Live Player','DF','assets/grade-live-photo.jpg','published')",[livePlayer.id]);
  const liveFixture=(await rows("insert into public.fixtures(opponent,status) values('TEST Opponent','published') returning *"))[0];
  const liveTraining=(await rows("insert into public.training_sessions(title,starts_at,is_public) values('TEST Live Training',now()+interval '2 days',true) returning *"))[0];
  const liveEvent=(await rows("insert into public.club_events(title,starts_at,is_public) values('TEST Live Event',now()+interval '2 days',true) returning *"))[0];

  await test('all legacy operational roles share staff draft creation, editing and server audit identity',async()=>{
    for (const n of [2,3,4,9]) {
      await as(n);
      const draft=await save('articles',null,null,{slug:`grade-draft-${n}`,title:'TEST Draft',status:'draft'});
      const edited=await save('articles',draft.id,draft.updated_at,{title:'TEST Pending Draft',status:'pending'});
      assert.equal(edited.status,'pending');
      const schedule=(await rows("insert into public.training_sessions(title,starts_at) values('TEST Staff Draft Training',now()+interval '3 days') returning *"))[0];
      assert.equal((await rows('update public.training_sessions set title=$1 where id=$2 returning title',['TEST Changed Draft',schedule.id]))[0].title,'TEST Changed Draft');
      const audit=await rows("select actor_id,actor_role,source from public.audit_logs where entity='articles' and record_id=$1 order by id",[draft.id]);
      assert.ok(audit.length>=2); assert.ok(audit.every(l=>l.actor_id===user(n)&&l.actor_role==='staff'&&l.source==='human'));
    }
  });

  await test('staff cannot publish, alter, withdraw or delete any live content through direct DML or definer RPC',async()=>{
    await as(3);
    const before=(await rows('select count(*)::int n from public.audit_logs'))[0].n;
    const version=(await rows('select version from public.publication_state'))[0].version;
    for(const [table,key,id] of [['articles','id',liveArticle.id],['media_albums','id',liveAlbum.id],['media_assets','id',liveMedia.id],['public_player_profiles','player_id',livePlayer.id],['fixtures','id',liveFixture.id]]) {
      await reject(`update public.${table} set status='draft' where ${key}=$1`,[id]);
      await reject(`delete from public.${table} where ${key}=$1`,[id]);
      const field=table==='public_player_profiles'?'display_name':table==='fixtures'?'opponent':'title';
      await reject(`update public.${table} set ${field}='TEST Unauthorized Published Edit' where ${key}=$1`,[id]);
    }
    await reject("insert into public.articles(slug,title,summary,body,cover_alt,status) values('grade-forbidden-live','TEST','TEST','TEST','TEST','published')");
    await reject("insert into public.articles(slug,title,status,published_at) values('grade-forbidden-timestamp','TEST','draft',now()-interval '1 day')");
    await reject("update public.players set photo_consent=false where id=$1",[livePlayer.id]);
    await reject('select public.save_office_content($1,$2,$3,$4,null)',['articles',liveArticle.id,liveArticle.updated_at,{title:'TEST RPC Live Edit'}]);
    await reject('select public.save_office_content($1,null,null,$2,null)',['articles',{slug:'grade-rpc-live',title:'TEST',summary:'TEST',body:'TEST',cover_alt:'TEST',status:'published'}]);
    const liveHistory=(await rows('select public.office_content_state($1,$2) item',['articles',liveArticle.id]))[0].item;
    await reject('select public.restore_content_revision($1,$2)',[liveHistory.revisions[0].id,liveArticle.updated_at]);
    assert.equal((await rows('select count(*)::int n from public.audit_logs'))[0].n,before,'rejected changes do not commit success audits');
    assert.equal((await rows('select version from public.publication_state'))[0].version,version,'rejected changes do not mark publication as changed');
    assert.equal((await rows('select title,status from public.articles where id=$1',[liveArticle.id]))[0].title,'TEST Live');
    await privileged();
    assert.equal((await rows('select approval_status from private.staff_accounts where user_id=$1',[user(6)]))[0].approval_status,'approved');
  });

  await test('staff draft player form supports draft photo uploads while public approval remains owner-only',async()=>{
    await as(3);
    const storagePath=`${user(3)}/${user(901)}.jpg`;
    await db.query("insert into storage.objects(bucket_id,name) values('kansai-media',$1)",[storagePath]);
    const person={internal_name:'TEST Staff Player',activity_status:'active',profile_consent:true,photo_consent:true};
    const profile={slug:'grade-form-player',display_name:'TEST Staff Player',position:'DF'};
    const upload={id:user(902),storage_path:storagePath,title:'TEST Draft Photo',alt_text:'TEST Draft Alt'};
    const saved=(await rows('select public.save_player_office($1,null,null,$2,$3,null,true,$4,null,$5) item',[user(903),person,profile,upload,'draft']))[0].item;
    assert.equal(saved.player_id,user(903)); assert.equal(saved.profile_status,'draft');
    assert.equal((await rows('select status from public.media_assets where id=$1',[user(902)]))[0].status,'draft');
    await reject('select public.save_player_office($1,null,null,$2,$3,null,false,null,null,$4)',[user(904),person,{...profile,slug:'grade-forbidden-form'},'published']);
    assert.deepEqual(await rows('select id from public.players where id=$1',[user(904)]),[]);
  });

  await test('owner withdrawal lets staff edit a preserved draft before owner republishes it',async()=>{
    await as(1);
    const withdrawn=(await rows("update public.articles set status='draft' where id=$1 returning *",[liveArticle.id]))[0];
    await as(3);
    const edited=await save('articles',withdrawn.id,withdrawn.updated_at,{title:'TEST Reviewed Revision',status:'pending'});
    assert.equal(edited.status,'pending');
    assert.equal(new Date(edited.published_at).getTime(),new Date(withdrawn.published_at).getTime(),'the first publication timestamp remains attached to the same URL');
    await as(null);
    assert.deepEqual(await rows('select slug from public.articles where id=$1',[liveArticle.id]),[],'pending revision is not released');
    await as(1);
    const published=await save('articles',edited.id,edited.updated_at,{status:'published'});
    assert.equal(published.slug,'grade-live-news');
    await as(null);
    assert.equal((await rows('select title from public.articles where id=$1',[liveArticle.id]))[0].title,'TEST Reviewed Revision');
  });

  await test('derived photo consent cannot be forged into publication and owner must explicitly approve the player photo',async()=>{
    await as(3);
    const photo=(await rows('select * from public.media_assets where id=$1',[user(902)]))[0];
    assert.equal(photo.public_approved,true,'the generated legacy-named field records consent eligibility');
    assert.equal(photo.status,'draft','consent does not grant public status');
    await reject('update public.media_assets set public_approved=true where id=$1',[photo.id]);
    await reject("update public.media_assets set status='published' where id=$1",[photo.id]);
    await as(null);
    assert.deepEqual(await rows('select id from public.media_assets where id=$1',[photo.id]),[]);
    assert.deepEqual(await rows('select player_id from public.public_player_profiles where player_id=$1',[user(903)]),[]);
    assert.deepEqual(await rows("select name from storage.objects where bucket_id='kansai-media' and name=$1",[photo.storage_path]),[]);
    await as(1);
    const player=(await rows('select * from public.players where id=$1',[user(903)]))[0];
    const profile=(await rows('select * from public.public_player_profiles where player_id=$1',[user(903)]))[0];
    const approved=(await rows('select public.save_player_office($1,$2,$3,$4,$5,null,false,null,$6,$7) item',[player.id,player.updated_at,profile.updated_at,
      {internal_name:player.internal_name,activity_status:player.activity_status,profile_consent:player.profile_consent,photo_consent:player.photo_consent},
      {slug:profile.slug,display_name:profile.display_name,romanized_name:profile.romanized_name,position:profile.position,jersey_number:profile.jersey_number,bio:profile.bio,activity_status:profile.activity_status,display_order:profile.display_order},
      photo.updated_at,'published']))[0].item;
    assert.equal(approved.profile_status,'published');
    assert.equal((await rows('select approved_by from public.public_player_profiles where player_id=$1',[player.id]))[0].approved_by,user(1));
    await as(null);
    assert.equal((await rows('select status from public.media_assets where id=$1',[photo.id]))[0].status,'published');
    assert.equal((await rows('select player_id from public.public_player_profiles where player_id=$1',[player.id]))[0].player_id,player.id);
  });

  await test('schedule and recurrence paths cannot expose or alter live schedules as staff',async()=>{
    await as(4);
    for (const [table,row] of [['training_sessions',liveTraining],['club_events',liveEvent]]) {
      await reject(`update public.${table} set title='TEST Unauthorized Live Schedule' where id=$1`,[row.id]);
      await reject(`update public.${table} set is_public=false where id=$1`,[row.id]);
      await reject(`delete from public.${table} where id=$1`,[row.id]);
    }
    const before=(await rows("select count(*)::int n from public.audit_logs where entity='training_series'"))[0].n;
    await reject('select * from public.create_training_series($1,1,2)',[{title:'TEST Public Recurrence',starts_at:'2030-01-01T00:00:00Z',is_public:true}]);
    assert.equal((await rows("select count(*)::int n from public.audit_logs where entity='training_series'"))[0].n,before,'failed recurrence rolls back its parent and audit');
    await reject('select public.update_training_occurrences($1,$2,$3,$4)',[liveTraining.id,liveTraining.updated_at,{title:'TEST Recurrence Edit',starts_at:'2030-01-01T00:00:00Z'},'single']);
    const drafts=await rows('select * from public.create_training_series($1,1,2)',[{title:'TEST Private Recurrence',starts_at:'2030-01-01T00:00:00Z',is_public:false}]);
    assert.equal(drafts.length,2); assert.ok(drafts.every(r=>r.is_public===false));
  });

  await test('only owner may approve scheduled publication, and old staff approvals are rechecked',async()=>{
    await privileged();
    await db.query('update private.office_automation_settings set publisher_enabled=true where id=1');
    await db.query("insert into private.content_releases(entity,record_id,scheduled_at,expected_updated_at,approved_by,approved_role,state) values('site_pages','club',now()-interval '1 hour',now(),$1,'owner','failed')",[user(1)]);
    await as(3);
    assert.ok((await rows('select public.office_release_attention() item'))[0].item.some(row=>row.entity==='site_pages'),'staff share the same safe operational release summaries');
    const draft=await save('articles',null,null,{slug:'grade-scheduled-draft',title:'TEST Schedule',summary:'TEST',body:'TEST',cover_alt:'TEST',status:'draft'});
    await reject('select public.save_office_content($1,$2,$3,$4,now()+interval \'1 hour\')',['articles',draft.id,draft.updated_at,{title:'TEST No Staff Release'}]);
    await reject('select public.cancel_content_release($1,$2)',['articles',draft.id]);
    await privileged();
    await db.query("insert into private.content_releases(entity,record_id,scheduled_at,expected_updated_at,approved_by,approved_role,state) values('articles',$1,now()-interval '1 minute',$2,$3,'editor','queued')",[draft.id,draft.updated_at,user(3)]);
    await db.exec('set role service_role');
    assert.equal((await rows('select private.publish_due_content() n'))[0].n,0);
    await privileged();
    assert.equal((await rows('select state from private.content_releases where record_id=$1',[draft.id]))[0].state,'failed');
    assert.equal((await rows('select status from public.articles where id=$1',[draft.id]))[0].status,'draft');
    await as(1);
    const scheduled=await save('articles',draft.id,draft.updated_at,{title:'TEST Owner Approval'},new Date(Date.now()+3600000).toISOString());
    await privileged();
    await db.query("update private.content_releases set scheduled_at=now()-interval '1 minute' where record_id=$1",[draft.id]);
    await db.exec('set role service_role');
    assert.equal((await rows('select private.publish_due_content() n'))[0].n,1);
    await privileged();
    assert.equal((await rows('select status from public.articles where id=$1',[scheduled.id]))[0].status,'published');
  });

  await test('scheduled publisher rechecks approving owner activation, approval and Auth ban without requiring a human session',async()=>{
    await privileged();
    await db.query("insert into auth.users(id,email) values($1,'grade-owner-10@example.invalid')",[user(10)]);
    await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[user(10010),user(10)]);
    await db.query("insert into public.admin_roles(user_id,email,role,active) values($1,'grade-owner-10@example.invalid','owner',true)",[user(10)]);
    await db.query("insert into private.staff_accounts(user_id,username,real_name,department,approval_status,email_confirmation_required,notice_accepted_at) values($1,'grade.owner10','TEST Second Owner','','approved',false,now())",[user(10)]);
    for(const [label,restrict,restore] of [
      ['inactive',"update public.admin_roles set active=false where user_id=$1","update public.admin_roles set active=true where user_id=$1"],
      ['suspended',"update private.staff_accounts set approval_status='suspended' where user_id=$1","update private.staff_accounts set approval_status='approved' where user_id=$1"],
      ['Auth-banned',"update auth.users set banned_until=now()+interval '1 hour' where id=$1","update auth.users set banned_until=null where id=$1"],
    ]) {
      await as(10);
      const draft=await save('articles',null,null,{slug:`grade-scheduled-owner-${label.toLowerCase()}`,title:'TEST Owner Scheduled',summary:'TEST',body:'TEST',cover_alt:'TEST',status:'draft'},new Date(Date.now()+3600000).toISOString());
      await privileged();
      await db.query("update private.content_releases set scheduled_at=now()-interval '1 minute' where record_id=$1",[draft.id]);
      await db.query(restrict,[user(10)]);
      await db.exec('set role service_role');
      assert.equal((await rows('select private.publish_due_content() n'))[0].n,0,label);
      await privileged();
      assert.equal((await rows('select state from private.content_releases where record_id=$1',[draft.id]))[0].state,'failed',label);
      assert.equal((await rows('select status from public.articles where id=$1',[draft.id]))[0].status,'draft',label);
      assert.deepEqual(await rows("select id from public.audit_logs where record_id=$1 and action='publish'",[draft.id]),[],`${label}: rejected job creates no successful publication audit`);
      await db.query(restore,[user(10)]);
    }
  });

  await test('player, pending and suspended sessions cannot read operational base rows or perform writes',async()=>{
    for(const n of [6,7,8]) {
      await as(n);
      for(const table of ['players','public_player_profiles','articles','fixtures','media_assets','media_albums','site_pages','training_sessions','training_series','club_events','match_events','audit_logs']) assert.deepEqual(await rows(`select * from public.${table}`),[],`${n}: ${table}`);
      assert.deepEqual(await rows("select * from storage.objects where bucket_id='kansai-media'"),[]);
      await reject("insert into public.players(internal_name) values('TEST Forbidden')");
      await reject("select public.save_office_content('articles',null,null,'{\"slug\":\"grade-player-edit\",\"title\":\"TEST\"}',null)");
      const schedules=await rows('select * from public.published_schedule');
      assert.ok(schedules.some(s=>s.id===liveTraining.id));
      assert.ok(schedules.every(s=>!('notes' in s)&&!('approved_by' in s)&&!('actor_id' in s)));
    }
    await as(null);
    assert.ok((await rows('select slug,title from public.articles')).some(r=>r.slug==='grade-live-news'),'safe anonymous website projection remains available');
    await reject('select approved_by from public.public_player_profiles');
  });

  await test('same existing session loses staff powers immediately on grade change, revocation and platform ban',async()=>{
    await as(9);
    const draft=await save('articles',null,null,{slug:'grade-session-draft',title:'TEST Before Demotion'});
    await privileged(); await db.query("update public.admin_roles set role='player' where user_id=$1",[user(9)]);
    await as(9);
    assert.deepEqual(await rows('select id from public.articles where id=$1',[draft.id]),[]);
    await reject('select public.save_office_content($1,$2,$3,$4,null)',['articles',draft.id,draft.updated_at,{title:'TEST Stale Staff Edit'}]);
    await privileged(); await db.query("update public.admin_roles set role='staff',active=false where user_id=$1",[user(9)]);
    await as(9); assert.equal((await rows('select private.current_role() role'))[0].role,null);
    await privileged(); await db.query('update public.admin_roles set active=true where user_id=$1',[user(9)]); await db.query("update auth.users set banned_until=now()+interval '1 hour' where id=$1",[user(9)]);
    await as(9); assert.equal((await rows('select private.current_role() role'))[0].role,null);
    await reject("insert into public.training_sessions(title,starts_at) values('TEST Banned',now())");
  });
} finally { await db.close(); }
