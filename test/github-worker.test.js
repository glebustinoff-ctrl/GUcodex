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
