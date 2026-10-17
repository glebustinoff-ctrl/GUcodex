import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,readFile,rm,copyFile} from 'node:fs/promises';
import {createApp} from '../server.js';
import {matchSong} from '../automatic.js';
import {run} from '../media.js';

const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r(`http://127.0.0.1:${s.address().port}`)));
const close=s=>new Promise(r=>{s.closeAllConnections();s.close(r);});

test('automatic matching rejects another artist and live versions',()=>{
  assert.equal(matchSong([{title:'Ёлка!',artist:'Автор',id:'1'}],'Елка','Автор').id,'1');
  assert.throws(()=>matchSong([{title:'Песня',artist:'Другой'}],'Песня','Автор'),/совпадающими/);
  assert.throws(()=>matchSong([{title:'Песня (Live)',artist:'Автор'}],'Песня','Автор'),/совпадающими/);
});

test('automatic endpoint reports missing VK access without starting a job',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'karaoke-auto-blocked-'));
  const server=await createApp({dataDir:dir,vkOptions:{token:''}}),base=await listen(server);
  t.after(async()=>{await close(server);await rm(dir,{recursive:true,force:true});});
  const status=await(await fetch(base+'/api/auto/status')).json();assert.equal(status.ready,false);
  const response=await fetch(base+'/api/auto',{method:'POST',body:JSON.stringify({title:'Песня',artist:'Автор'})});
  assert.equal(response.status,424);assert.match((await response.json()).error,/VK/);
  const preflight=await fetch(base+'/api/auto',{method:'OPTIONS',headers:{Origin:'https://glebustinoff-ctrl.github.io'}});
  assert.equal(preflight.status,204);assert.equal(preflight.headers.get('Access-Control-Allow-Origin'),'https://glebustinoff-ctrl.github.io');
  assert.equal((await fetch(base+'/api/auto',{method:'OPTIONS',headers:{Origin:'https://untrusted.example'}})).status,403);
});

test('automatic pipeline with test provider and separator stub exports a complete MP4 and survives restart', {timeout:120000},async t=>{
  const temp=await mkdtemp(path.join(tmpdir(),'karaoke-auto-'));
  const wav=path.join(temp,'fixture.wav');
  await run('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=330:duration=2.4','-ac','2',wav]);
  const fixture=await readFile(wav);
  const upstream=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify([{trackName:'Песня',artistName:'Автор',duration:2.4,syncedLyrics:'[00:00]Первая строка\n[00:01.20]Вторая строка'}]));});
  const lyricsBase=await listen(upstream);let separated=0;
  const options={dataDir:path.join(temp,'data'),lyricsBase,vkOptions:{token:'fixture',fetchImpl:async target=>{
    if(String(target).endsWith('audio.search'))return Response.json({response:{items:[{owner_id:1,id:2,title:'Песня',artist:'Автор',duration:2.4}]}});
    if(String(target).endsWith('audio.getById'))return Response.json({response:[{url:'https://fixture.vkuseraudio.net/fixture.mp3'}]});
    return new Response(fixture,{headers:{'Content-Type':'audio/wav'}});
  }},automaticOptions:{separate:async(original,dir)=>{
    // This deliberately tests orchestration, not neural separation quality.
    separated++;const output=path.join(dir,'test-minus.wav');await copyFile(original,output);return output;
  }}};
  let server=await createApp(options),base=await listen(server);
  t.after(async()=>{await close(server);await close(upstream);await rm(temp,{recursive:true,force:true});});
  const response=await fetch(base+'/api/auto',{method:'POST',body:JSON.stringify({title:'Песня',artist:'Автор'})});
  assert.equal(response.status,202);let job=await response.json();
  while(job.status==='processing'){await new Promise(r=>setTimeout(r,100));job=await(await fetch(base+`/api/auto/jobs/${job.id}`)).json();}
  assert.equal(job.status,'done',job.error);assert.equal(separated,1);assert.equal(job.timing,'lrc');
  const file=await fetch(base+job.downloadUrl);assert.equal(file.status,200);assert.ok((await file.arrayBuffer()).byteLength>10000);
  const metadata=JSON.parse(await run('ffprobe',['-v','error','-show_entries','stream=codec_type,width,height:format=duration','-of','json',path.join(options.dataDir,job.id,'karaoke.mp4')]));
  assert.ok(metadata.streams.some(s=>s.width===1080&&s.height===1920));assert.ok(Math.abs(+metadata.format.duration-2.4)<.15);
  assert.ok(metadata.streams.some(s=>s.codec_type==='audio'));
  const minus=await fetch(base+job.minusUrl);assert.equal(minus.status,200);assert.match(minus.headers.get('content-disposition'),/minus.wav/);
  assert.match(await(await fetch(base+job.lyricsUrl)).text(),/Вторая строка/);
  await close(server);server=await createApp(options);base=await listen(server);
  assert.equal((await(await fetch(base+`/api/auto/jobs/${job.id}`)).json()).status,'done');
  assert.equal((await fetch(base+job.downloadUrl)).status,200);
});
