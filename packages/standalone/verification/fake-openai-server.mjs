import http from 'node:http';
const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) { res.writeHead(404).end(); return; }
  const chunks=[]; for await (const chunk of req) chunks.push(chunk);
  const body=JSON.parse(Buffer.concat(chunks).toString('utf8')); const prompt=body.messages?.at(-1)?.content ?? '';
  let kind='work'; try { const json=JSON.parse(prompt.split('\n').at(-1)); kind=json.work_item?.kind ?? kind; } catch {}
  const verify=kind==='verify';
  const payload={ summary:`${kind} completed by fake live provider`, deliverables: verify?[]:[{name:`${kind}-artifact`,media_type:'application/json',content:{kind,live:true}}], evidence:verify?['fake-provider independent evidence']:[], verification:{passed:verify,independent:verify,findings:[]}, file_operations:[], commands:[] };
  const out={id:`req_${kind}`,model:body.model,choices:[{message:{content:JSON.stringify(payload)},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:15,total_tokens:35}};
  res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify(out));
});
server.listen(0,'127.0.0.1',()=>process.stdout.write(`${JSON.stringify({port:server.address().port})}\n`));
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
