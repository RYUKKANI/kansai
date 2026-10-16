import test from "node:test";
import assert from "node:assert/strict";
import { typescriptModule } from "./helpers/typescript-module.mjs";

const { supportRecoveryRequest, supportRecoveryStatus, completeSupportRecovery } = await typescriptModule("supabase/functions/staff-auth/support-recovery.ts");
const requestId = "00000000-0000-4000-8000-000000000700";
const targetId = "00000000-0000-4000-8000-000000000001";
const proofHash = "a".repeat(64);
const fingerprint = "a1b2c3d4e5f60718";
const password = "TEST-ONLY-new-private-password";
const expires = "2026-10-16T01:00:00.000Z";
const ok = data => ({ data, error: null });
function fixture(options = {}) {
  const calls = [];
  const service = {
    async rpc(name, args) {
      calls.push({ type: "rpc", name, args: structuredClone(args) });
      if (options.rpc) { const result = await options.rpc(name,args); if(result !== undefined) return result; }
      if (name === "staff_auth_support_recovery_request") return ok({ request_id: requestId, device_fingerprint: fingerprint, expires_at: expires, target_user_id: targetId, email: "private@example.invalid" });
      if (name === "staff_auth_support_recovery_status") return ok({ request_id: requestId, device_fingerprint: fingerprint, expires_at: expires, state: "approved", target_user_id: targetId });
      if (name === "staff_auth_support_recovery_claim") return ok({ request_id: requestId, target_user_id: targetId, state: "executing" });
      if (name === "staff_auth_support_recovery_finish") return ok(null);
      throw new Error("unexpected fixture RPC");
    },
    auth: { admin: { async updateUserById(id, input) {
      calls.push({type:"auth", id, input:structuredClone(input)});
      return options.update ? options.update(id,input) : ok({user:{id:targetId}});
    } } },
  };
  const proof = { service, requestId, proofHash };
  return { calls, service, proof, request: () => supportRecoveryRequest({...proof,username:"owner.one",fingerprint}), status: () => supportRecoveryStatus(proof), complete: () => completeSupportRecovery({...proof,password}) };
}
test("request and status return only public workflow metadata and never create Auth sessions", async () => {
  const f = fixture();
  const requested = await f.request();
  assert.deepEqual(requested, {status:200,body:{success:true,code:"support_recovery_requested",request_id:requestId,device_fingerprint:fingerprint,expires_at:expires}});
  const status = await f.status();
  assert.deepEqual(status,{status:200,body:{success:true,code:"support_recovery_status",request_id:requestId,state:"approved",device_fingerprint:fingerprint,expires_at:expires}});
  assert.equal(f.calls.some(call=>call.type==="auth"),false);
  assert.equal(JSON.stringify([requested,status]).includes(targetId),false);
  assert.equal(JSON.stringify([requested,status]).includes("email"),false);
});
test("unknown and incorrect proof status share a generic failure", async () => {
  for (const data of [{state:"unavailable"},null,{state:"approved"},{request_id:requestId,state:"unexpected-state"}]) {
    const f = fixture({rpc: name => name.endsWith("_status") ? ok(data) : undefined});
    assert.deepEqual(await f.status(),{status:403,body:{error:"support_recovery_unavailable"}});
  }
});
test("database errors and malformed public metadata fail closed without error detail", async () => {
  for (const result of [{data:null,error:{message:"sensitive-contact-and-internal-error"}},ok({request_id:requestId,device_fingerprint:"incorrect",expires_at:expires})]) {
    const f = fixture({rpc: () => result});
    const response = await f.request();
    assert.equal(response.status,403);
    assert.equal(JSON.stringify(response).includes("sensitive"),false);
    assert.equal(f.calls.some(call=>call.type==="auth"),false);
  }
  const f = fixture({rpc:()=>{throw new Error("internal transport detail")}});
  assert.equal((await f.request()).status,403);
  assert.equal((await f.status()).status,403);
});
test("approved one-time claim changes only same UUID password then confirms final audit", async () => {
  const f = fixture();
  assert.deepEqual(await f.complete(),{status:200,body:{success:true,code:"support_password_updated",request_id:requestId}});
  assert.deepEqual(f.calls.map(call=>call.type==="auth"?"auth":call.name),["staff_auth_support_recovery_claim","auth","staff_auth_support_recovery_finish"]);
  assert.deepEqual(f.calls.find(call=>call.type==="auth"),{type:"auth",id:targetId,input:{password}});
  const rpc = f.calls.filter(call=>call.type==="rpc");
  assert.equal(JSON.stringify(rpc).includes(password),false);
  assert.deepEqual(rpc[1].args,{p_request_id:requestId,p_proof_hash:proofHash,p_state:"succeeded"});
  assert.equal(JSON.stringify(await f.status()).includes(proofHash),false);
});
test("unapproved claim never calls Auth or final audit", async () => {
  const f = fixture({rpc:()=>({data:null,error:{code:"42501",message:"private reason"}})});
  assert.deepEqual(await f.complete(),{status:403,body:{error:"support_recovery_unavailable",request_id:requestId}});
  assert.equal(f.calls.length,1);
});
test("lost claim result is uncertain and never automatically retries or calls Auth", async () => {
  for (const rpc of [()=>({data:null,error:{code:"network_error"}}),()=>{throw new Error("network") }]) {
    const f=fixture({rpc});
    assert.deepEqual(await f.complete(),{status:409,body:{error:"support_recovery_uncertain",request_id:requestId}});
    assert.equal(f.calls.length,1);
  }
});
test("success replay explicitly reports previous completion without applying new input", async () => {
  const f=fixture({rpc:name=>name.endsWith("_claim")?ok({request_id:requestId,state:"succeeded"}):undefined});
  assert.deepEqual(await f.complete(),{status:200,body:{success:true,code:"support_password_already_updated",request_id:requestId}});
  assert.equal(f.calls.length,1);
});
test("terminal failed and uncertain retries cannot execute Auth", async () => {
  for (const [state,status,error] of [["failed",400,"support_recovery_failed"],["uncertain",409,"support_recovery_uncertain"]]) {
    const f=fixture({rpc:name=>name.endsWith("_claim")?ok({request_id:requestId,state}):undefined});
    assert.deepEqual(await f.complete(),{status,body:{error,request_id:requestId}});
    assert.equal(f.calls.length,1);
  }
});
test("mismatched request, missing target or malformed claim cannot update Auth", async () => {
  for(const data of [{request_id:"wrong",state:"executing",target_user_id:targetId},{request_id:requestId,state:"executing"},{request_id:requestId,state:"executing",target_user_id:"not-a-uuid"},{request_id:requestId,state:"requested",target_user_id:targetId}]) {
    const f=fixture({rpc:()=>ok(data)});
    assert.notEqual((await f.complete()).status,200);
    assert.equal(f.calls.some(call=>call.type==="auth"),false);
  }
});
test("definite Auth policy rejection records failed and never reports changed", async () => {
  const f=fixture({update:()=>({data:null,error:{status:422,message:"must not expose internal contact"}})});
  assert.deepEqual(await f.complete(),{status:400,body:{error:"support_recovery_failed",request_id:requestId}});
  assert.equal(f.calls.at(-1).args.p_state,"failed");
  assert.equal(f.calls.filter(call=>call.type==="auth").length,1);
});
test("network, server errors and returned UUID mismatch record uncertain without retry", async () => {
  for(const update of [()=>{throw new Error("network")},()=>({data:null,error:{status:500}}),()=>({data:null,error:{status:408}}),()=>ok({user:{id:"00000000-0000-4000-8000-000000000002"}})]) {
    const f=fixture({update});
    assert.deepEqual(await f.complete(),{status:409,body:{error:"support_recovery_uncertain",request_id:requestId}});
    assert.equal(f.calls.at(-1).args.p_state,"uncertain");
    assert.equal(f.calls.filter(call=>call.type==="auth").length,1);
  }
});
test("Auth success without confirmed final audit never becomes visible success", async () => {
  for(const finish of [()=>({data:null,error:{code:"network"}}),()=>ok({unexpected:true}),()=>{throw new Error("network")}]) {
    const f=fixture({rpc:name=>name.endsWith("_finish")?finish():undefined});
    assert.deepEqual(await f.complete(),{status:409,body:{error:"support_recovery_uncertain",request_id:requestId}});
    assert.equal(f.calls.filter(call=>call.type==="auth").length,1);
    assert.equal(f.calls.filter(call=>call.name?.endsWith("_finish")).length,1);
  }
});
