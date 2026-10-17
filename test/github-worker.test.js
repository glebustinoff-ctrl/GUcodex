import test from 'node:test';
import assert from 'node:assert/strict';
import {createGitHubTransport} from '../public/github-runtime.js';
import {encodeMessage,decodeMessage,REQUEST_MARKER,RESULT_MARKER,validateRequest} from '../public/github-protocol.js';

const id='e54f6b48-44f1-418e-a45a-d7e70e6f7a9c';
const song={id,title:'Кукушка',artist:'Кино',theme:'violet',fontSize:64};
test('GitHub request keeps arbitrary song text inside JSON and rejects broken input',()=>{
  const request={...song,title:'``` @someone & песня'};
  const body=encodeMessage(REQUEST_MARKER,request);
  assert.equal(body.split('```').length,3);
  assert.deepEqual(validateRequest(decodeMessage(body,REQUEST_MARKER)),request);
  assert.throws(()=>validateRequest({...song,artist:'a\nb'}));
  assert.throws(()=>decodeMessage('random text',REQUEST_MARKER));
});
test('Pages opens reviewable owner request, polls owner issue, ignores forged result and accepts worker release',async()=>{
  let clock=Date.now(),opened,queries=0;
  const request=createGitHubTransport({now:()=>clock,uuid:()=>id,openWindow:url=>{opened=new URL(url);},fetchImpl:async url=>{
    queries++;
    if(url.includes('/comments'))return {ok:true,json:async()=>[
      {user:{login:'github-actions[bot]'},body:encodeMessage(RESULT_MARKER,{id,status:'done',title:song.title,artist:song.artist,downloadUrl:'https://github.com/glebustinoff-ctrl/GUcodex/releases/download/karaoke-7/karaoke.mp4'})},
      {user:{login:'stranger'},body:encodeMessage(RESULT_MARKER,{id,status:'done',downloadUrl:'https://attacker.invalid/'})}
    ]};
    return {ok:true,json:async()=>[{number:7,user:{login:'glebustinoff-ctrl'},title:`Караоке — запрос ${id}`,body:encodeMessage(REQUEST_MARKER,song),html_url:'https://github.com/glebustinoff-ctrl/GUcodex/issues/7'}]};
  }});
  assert.equal((await request('/api/auto/status')).requiresApiKey,false);
  const job=await request('/api/auto',{method:'POST',body:JSON.stringify(song)});
  assert.equal(queries,0);assert.equal(job.status,'processing');assert.equal(opened.hostname,'github.com');
  assert.deepEqual(decodeMessage(opened.searchParams.get('body'),REQUEST_MARKER),song);
  await request(`/api/auto/jobs/${id}`);assert.equal(queries,0);
  clock+=11000;
  const result=await request(`/api/auto/jobs/${id}`);
  assert.equal(result.status,'done');assert.ok(result.downloadUrl.endsWith('/karaoke-7/karaoke.mp4'));assert.equal(queries,2);
});
test('transient GitHub failure retains pending job and throttles retries',async()=>{
  let clock=Date.now(),queries=0;
  const request=createGitHubTransport({now:()=>clock,uuid:()=>id,openWindow:()=>{},fetchImpl:async()=>{queries++;return {ok:false,status:403};}});
  await request('/api/auto',{method:'POST',body:JSON.stringify(song)});clock+=11000;
  const job=await request(`/api/auto/jobs/${id}`);assert.equal(job.status,'processing');assert.match(job.message,/ограничил/);
  clock+=30000;await request(`/api/auto/jobs/${id}`);assert.equal(queries,1);
});

test('pending request and completed downloads survive reload without submitting another issue',async()=>{
  const values=new Map(),storage={getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)};
  let clock=Date.now(),opened=0,finished=false;
  const calls=[];
  const urls={downloadUrl:'https://github.com/glebustinoff-ctrl/GUcodex/releases/download/karaoke-7/karaoke.mp4',minusUrl:'https://github.com/glebustinoff-ctrl/GUcodex/releases/download/karaoke-7/minus.mp3',lyricsUrl:'https://github.com/glebustinoff-ctrl/GUcodex/releases/download/karaoke-7/lyrics.lrc',originalUrl:'https://github.com/glebustinoff-ctrl/GUcodex/releases/download/karaoke-7/original.mp3'};
  const options={storage,now:()=>clock,uuid:()=>id,openWindow:()=>opened++,fetchImpl:async url=>{
    calls.push(url);
    if(url.includes('/comments'))return {ok:true,json:async()=>[{user:{login:'github-actions[bot]'},body:encodeMessage(RESULT_MARKER,{id,status:finished?'done':'processing',step:finished?'done':'separating',progress:finished?100:40,...(finished?urls:{})})}]};
    return {ok:true,json:async()=>[{number:7,user:{login:'glebustinoff-ctrl'},title:`Караоке — запрос ${id}`,body:encodeMessage(REQUEST_MARKER,song)}]};
  }};
  let request=createGitHubTransport(options);
  await request('/api/auto',{method:'POST',body:JSON.stringify(song)});
  request=createGitHubTransport(options);
  assert.equal((await request('/api/auto/resume')).id,id);assert.equal(opened,1);assert.equal(calls.length,0);
  clock+=11000;const pending=await request(`/api/auto/jobs/${id}`);
  assert.equal(pending.step,'separating');assert.equal(pending.issueNumber,7);assert.equal(calls.length,2);
  request=createGitHubTransport(options);finished=true;clock+=61000;
  const done=await request(`/api/auto/jobs/${id}`);assert.equal(done.status,'done');assert.equal(done.originalUrl,urls.originalUrl);
  assert.equal(calls.length,3);assert.ok(calls[2].includes('/7/comments'));assert.equal(opened,1);
  request=createGitHubTransport(options);
  assert.equal((await request('/api/auto/resume')).downloadUrl,urls.downloadUrl);assert.equal(calls.length,3);
});

test('reload after a long absence retrieves an already completed worker result',async()=>{
  let record=JSON.stringify({...song,status:'processing',created:Date.now()-3*60*60*1000,issueNumber:7});
  const request=createGitHubTransport({storage:{getItem:()=>record,setItem:(_,value)=>{record=value;}},openWindow:()=>assert.fail('Unexpected popup'),fetchImpl:async url=>{
    assert.ok(url.includes('/7/comments'));
    return {ok:true,json:async()=>[{user:{login:'github-actions[bot]'},body:encodeMessage(RESULT_MARKER,{id,status:'done',downloadUrl:'https://github.com/glebustinoff-ctrl/GUcodex/releases/download/karaoke-7/karaoke.mp4'})}]};
  }});
  assert.equal((await request(`/api/auto/jobs/${id}`)).status,'done');
});

test('damaged saved data and foreign download URLs cannot restore a result',async()=>{
  for(const saved of ['not JSON',JSON.stringify({...song,created:Date.now(),status:'done',issueNumber:7,downloadUrl:'https://attacker.invalid/',minusUrl:'https://attacker.invalid/',lyricsUrl:'https://attacker.invalid/'})]){
    const request=createGitHubTransport({storage:{getItem:()=>saved},openWindow:()=>assert.fail('Unexpected popup')});
    assert.deepEqual(await request('/api/auto/resume'),{});
  }
  const request=createGitHubTransport({storage:{getItem:()=>null,setItem:()=>{throw new Error('Quota exceeded');}},uuid:()=>id,openWindow:()=>{}});
  assert.equal((await request('/api/auto',{method:'POST',body:JSON.stringify(song)})).status,'processing');
});
