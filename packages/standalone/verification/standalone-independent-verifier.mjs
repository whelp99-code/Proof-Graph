import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

const root=path.resolve(path.dirname(new URL(import.meta.url).pathname),'..');
const data=await fs.mkdtemp(path.join(os.tmpdir(),'pg-v5-independent-'));
const results=[];
function ok(name,condition,details={}){results.push({name,passed:Boolean(condition),details}); if(!condition) throw new Error(name);}
function line(child){return new Promise((resolve,reject)=>{let buf=''; child.stdout.on('data',c=>{buf+=c; const i=buf.indexOf('\n'); if(i>=0)resolve(buf.slice(0,i));}); child.once('error',reject); child.once('exit',c=>{if(c&&!buf)reject(new Error(`child exited ${c}`));});});}
async function request(url,token,method,pathname,body){const r=await fetch(url+pathname,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':`command_${crypto.randomUUID().replaceAll('-', '')}`},body:body?JSON.stringify(body):undefined}); const j=await r.json(); if(!r.ok)throw new Error(`${r.status} ${JSON.stringify(j)}`); return j;}
const fake=spawn(process.execPath,[path.join(root,'verification/fake-openai-server.mjs')],{stdio:['ignore','pipe','inherit']});
const fakeInfo=JSON.parse(await line(fake)); ok('fake provider starts',fakeInfo.port>0,fakeInfo);
const daemon=spawn(process.execPath,[path.join(root,'bin/proofgraphd.mjs'),'--data-dir',data,'--port','0','--provider-url',`http://127.0.0.1:${fakeInfo.port}/v1`,'--provider-model','local/fake-model','--provider-name','independent-fake','--native-local'],{stdio:['ignore','pipe','inherit'],env:{...process.env,PROOFGRAPH_ALLOW_SIMULATION_PROMOTION:'0'}});
const daemonInfo=JSON.parse(await line(daemon)); const url=daemonInfo.url; ok('daemon uses native local mode',daemonInfo.execution_mode==='native_local',daemonInfo);
const token=(await fs.readFile(path.join(data,'.operator-api-token'),'utf8')).trim();
const created=await request(url,token,'POST','/v1/runs',{objective:'Implement and independently verify a bounded API',signals:{requires_implementation:true},auto_start:true}); const id=created.run.run_id; ok('mission created',Boolean(id),created);
let run; for(let i=0;i<120;i++){run=(await request(url,token,'GET',`/v1/runs/${id}`)).run;if(['completed_clean','completed_with_recovery','failed','partial','simulation_complete'].includes(run.status))break; await new Promise(r=>setTimeout(r,50));}
ok('native mission completes clean',run.status==='completed_clean',run); ok('quality gate passes',run.quality_gate_passed===true); ok('real execution recorded',run.execution?.real_execution===true,run.execution); ok('verified artifact exists',(run.artifacts?.verified?.length??0)>0,run.artifacts);
await request(url,token,'POST','/v1/shutdown',{}); fake.kill('SIGTERM'); daemon.kill('SIGTERM');
const report={schema_version:1,version:'5.0.0',passed:results.filter(r=>r.passed).length,failed:results.filter(r=>!r.passed).length,results};
const output=process.argv.includes('--output')?process.argv[process.argv.indexOf('--output')+1]:path.join(root,'verification/standalone-independent-results.json'); await fs.writeFile(output,JSON.stringify(report,null,2)+'\n'); process.stdout.write(`${JSON.stringify(report,null,2)}\n`); if(report.failed)process.exitCode=1;
