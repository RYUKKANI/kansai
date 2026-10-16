import test from "node:test";
import assert from "node:assert/strict";
import { typescriptModule } from "./helpers/typescript-module.mjs";
const { createGateway } = await typescriptModule("supabase/functions/staff-auth/gateway.ts");
const ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PROOF = "af".repeat(32);
function fixture() {
  const calls = []; const counters = new Map();
  const service = { rpc: async (name,args) => {
    calls.push({name,args});
    if (name === "staff_auth_rate_limit") { const k=args.p_key_hash; const count=(counters.get(k)??0)+1; counters.set(k,count); return {data:count<=args.p_limit,error:null}; }
    if (name === "staff_auth_support_recovery_request") return {data:{request_id:args.p_request_id,device_fingerprint:args.p_fingerprint,expires_at:new Date(Date.now()+600000).toISOString()},error:null};
    return {data:null,error:{code:"42501"}};
  }, auth:{admin:{updateUserById:async()=>{throw new Error("unapproved Auth invocation");}}} };
  const handler=createGateway({service,authClient:()=>({}),userClient:()=>{throw new Error("public support must not create a user session");},config:{enabled:true,registrationEnabled:true,legacyEmailEnabled:true,registrationCaptchaMode:"disabled",allowedOrigins:["https://club.example.invalid"],emailRedirectTo:"https://club.example.invalid/admin/",recoveryRedirectTo:"https://club.example.invalid/admin/help/",hmacSecret:"isolated-test-hmac-only-at-least-32-characters",ipMode:"disabled",forwardAuthIp:false}});
  const send=(body,headers={})=>handler(new Request("https://auth.example.invalid/functions/v1/staff-auth",{method:"POST",headers:{"content-type":"application/json",origin:"https://club.example.invalid",...headers},body:JSON.stringify(body)}));
  return {calls,send};
}
const input=(extra={})=>({action:"support_recovery_request",username:"EXISTING.Owner",request_id:ID,device_secret:PROOF,...extra});
test("public device proof is purpose-HMACed before DB; response contains no raw proof, target or contacts",async()=>{
  const f=fixture();const res=await f.send(input()); const body=await res.json();
  assert.equal(res.status,200);assert.equal(body.code,"support_recovery_requested");
  const call=f.calls.find(c=>c.name==="staff_auth_support_recovery_request");
  assert.equal(call.args.p_username,"existing.owner");assert.match(call.args.p_proof_hash,/^[a-f0-9]{64}$/);
  assert.notEqual(call.args.p_proof_hash,PROOF);assert.notEqual(call.args.p_fingerprint,call.args.p_proof_hash.slice(0,16));
  assert.equal(JSON.stringify(f.calls).includes(PROOF),false);assert.equal(JSON.stringify(body).includes(PROOF),false);
  assert.equal(Object.keys(body).some(k=>/user_id|email|password|secret|hash/.test(k)),false);
});
for(const extra of [{actor_id:ID},{role:"owner"},{email:"forged@example.invalid"},{approved:true},{password:"not-accepted-on-request"},{device_secret:"short"},{request_id:"invalid"}]){
  test(`support rejects unauthorized field or malformed proof: ${Object.keys(extra).join(",")}`,async()=>{
    const f=fixture();const response=await f.send(input(extra));assert.equal(response.status,400);assert.equal(f.calls.some(c=>c.name==="staff_auth_support_recovery_request"),false);
  });
}
test("public completion cannot bypass approval even with a spoofed Owner bearer",async()=>{
  const f=fixture();const response=await f.send({action:"support_recovery_complete",request_id:ID,device_secret:PROOF,password:"isolated-test-password",password_confirmation:"isolated-test-password"},{authorization:"Bearer forged-owner-token"});
  assert.equal(response.status,403);assert.equal((await response.json()).error,"support_recovery_unavailable");
  assert.equal(f.calls.filter(c=>c.name==="staff_auth_support_recovery_claim").length,1);
});
test("device requests keep identifier limits when forwarding/IP headers are forged",async()=>{
  const f=fixture();for(let n=0;n<3;n++) assert.equal((await f.send(input({request_id:crypto.randomUUID(),device_secret:crypto.randomUUID().replaceAll("-","").repeat(2)}),{"x-forwarded-for":`192.0.2.${n}`})).status,200);
  assert.equal((await f.send(input({request_id:crypto.randomUUID()}),{"x-forwarded-for":"203.0.113.9","cf-connecting-ip":"203.0.113.10"})).status,429);
  assert.equal(f.calls.filter(c=>c.name==="staff_auth_support_recovery_request").length,3);
});
