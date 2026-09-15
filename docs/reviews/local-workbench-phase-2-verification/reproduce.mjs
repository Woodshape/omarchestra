import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
// Negative characterization only: exit 0 means the documented defects reproduced,
// NOT that Phase 2 acceptance passed. All stores are disposable; Git is injected.
const base = new URL('../../../packages/local-workbench-v1/runner/', import.meta.url).href;
const {openWorkbenchRunner} = await import(base+'runner.ts');
const {WorkbenchAuthority} = await import(base+'authority.ts');
const {decodeFrame} = await import(base+'transport.ts');
const {verifyBackup} = await import(base+'backup.ts');
const {inspectProjectPath} = await import(base+'git-context.ts');
function git(argv,cwd) {
 const k=argv.join(' '), values={'rev-parse --is-inside-work-tree':'true','rev-parse --is-bare-repository':'false','rev-parse --show-toplevel':cwd,'rev-parse --git-common-dir':'.git','rev-parse --git-dir':'.git','rev-parse --verify HEAD':'a'.repeat(40),'rev-parse --show-superproject-working-tree':'','status --porcelain':''};
 return {status:k in values?0:128,stdout:values[k]??'',stderr:''};
}
function scenario(name, fn) {
 const root=mkdtempSync(join(tmpdir(),'p2-independent-')); let r;
 try {
  const project=join(root,'project'); mkdirSync(project);
  let now=1000, n=0; const handlers=[], sent=[];
  const port={transportId:'current',send(f){sent.push(f)},subscribe(h){handlers.push(h);return()=>{}},close(){}};
  r=openWorkbenchRunner({roots:{stateDir:join(root,'state')},clock:()=>now});
  const a=new WorkbenchAuthority({runner:r,sessionId:'session',pluginGeneration:7,clock:()=>now,newId:p=>p+(++n),git,transport:()=>port});
  const inspection=a.inspect(project), p=a.confirmRegistration(inspection.inspectionId); const g=a.createGoal(p.projectId,'goal');
  const intent=(kind,payload,extra={})=>({intentId:'intent-'+(++n),sessionId:a.sessionId,pluginGeneration:7,runnerEpoch:r.epoch,expectedRevision:a.currentRevision,kind,target:null,payload,...extra});
  fn({r,a,p,g,port,sent,root,project,setTime:v=>now=v,intent});
  console.log('REPRODUCED: '+name);
 } finally {r?.close();rmSync(root,{recursive:true,force:true});}
}
scenario('F4: ACK after proposal expiry from wrong transport commits',({a,p,g,r,setTime})=>{
 const proposal=a.adoption.propose({projectId:p.projectId,goalId:g.goalId,role:'implementer',observedSessionId:'observed'});
 setTime(proposal.expiresAt-1);a.adoption.authorize(proposal.proposalId);setTime(proposal.expiresAt+1);
 a.adoption.onTransportEvent({type:'adopt_ack',runId:proposal.runId,bindingDigest:proposal.proposalDigest,nonce:proposal.nonce,transportId:'WRONG',source:'extension',detail:''});
 assert.equal(r.store.getBinding(proposal.runId).state,'committed');
});
scenario('F3: abandoned proposal blocks another and failed ACK projects a disconnected binding',({a,p,g,r})=>{
 const one=a.adoption.propose({projectId:p.projectId,goalId:g.goalId,role:'implementer',observedSessionId:'one'});
 const two=a.adoption.propose({projectId:p.projectId,goalId:g.goalId,role:'implementer',observedSessionId:'two'});
 a.adoption.authorize(two.proposalId);
 assert.throws(()=>a.adoption.onTransportEvent({type:'adopt_ack',runId:two.runId,bindingDigest:two.proposalDigest,nonce:two.nonce,transportId:'current',source:'extension',detail:''}),/already occupied/);
 assert.equal(r.store.getBinding(one.runId).state,'proposed');assert.equal(r.store.getBinding(two.runId).state,'disconnected');
});
scenario('F6: deleting owner.sqlite permits a second simultaneous owner',({r})=>{
 unlinkSync(r.roots.ownerDatabasePath);
 const second=openWorkbenchRunner({roots:{stateDir:r.roots.stateDir}});
 try {assert.equal(second.ownershipHeld,true);assert.equal(r.ownershipHeld,true);} finally {second.close();}
});
scenario('F7: effect survives failed outcome persistence',({r,a,p,intent})=>{
 const call=intent('create_goal',{projectId:p.projectId,goalText:'committed without receipt'});
 r.store.putIntentResult=()=>{throw Error('injected receipt failure')};
 assert.throws(()=>a.handleIntent(call),/receipt failure/);
 assert(r.store.listGoals().some(g=>g.goalText==='committed without receipt'));assert.equal(r.store.getIntentResult(call.intentId),null);
});
scenario('F7: wrong plugin generation is acknowledged',({a,p,intent})=>{
 assert.equal(a.handleIntent(intent('create_goal',{projectId:p.projectId,goalText:'wrong generation'},{pluginGeneration:999})).status,'acknowledged');
});
scenario('F10: invalid nonexistent resource draft accepted',({a,p})=>{
 const c=a.createCheck(p.projectId,{name:'invalid',summary:'',mode:'validator',commandSummary:'',definitionDraft:{executable:'/does-not-exist',extraAuthority:true}});
 assert.equal(c.version,1);assert.match(c.canonicalJson,/extraAuthority/);
});
scenario('F11: non-SQLite bytes accepted as verified backup',({r})=>{
 mkdirSync(r.roots.backupDir,{mode:0o700});const bytes='not sqlite';
 writeFileSync(join(r.roots.backupDir,'backup-1.sqlite'),bytes,{mode:0o600});
 writeFileSync(join(r.roots.backupDir,'backup-1.json'),JSON.stringify({schemaVersion:1,digest:createHash('sha256').update(bytes).digest('hex')}),{mode:0o600});
 assert.equal(verifyBackup(r.roots,'backup-1.sqlite').schemaVersion,1);
});
scenario('F9: failed git status is reported supported and clean',({project})=>{
 const result=inspectProjectPath(project,(args,cwd)=>args[0]==='status'?{status:128,stdout:'',stderr:'failed'}:git(args,cwd));
 assert.equal(result.supported,true);assert.equal(result.dirty,false);
});
const frame=decodeFrame(JSON.stringify({frameId:'f',kind:'adopt',runId:null,bindingDigest:null,nonce:null,payload:{unexpected:{nested:['secret-content']}}}));
assert.deepEqual(frame.payload.unexpected,{nested:['secret-content']});console.log('REPRODUCED: F12 nested arbitrary frame payload accepted');
