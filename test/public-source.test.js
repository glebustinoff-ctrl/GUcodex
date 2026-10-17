import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {PublicAudioSource} from '../public-source.js';
import {run} from '../media.js';

test('public audio ranking rejects covers, mismatches, previews and login-only results',async()=>{
  await run('python3',['-m','unittest','discover','-s','test','-p','public_audio_test.py']);
});

test('public source prepares without credentials and accepts only files inside the job',async t=>{
  const folder=await mkdtemp(path.join(tmpdir(),'public-audio-'));
  t.after(()=>rm(folder,{recursive:true,force:true}));
  const file=path.join(folder,'source.webm');await writeFile(file,'fixture bytes');
  const calls=[];
  const source=new PublicAudioSource({python:process.execPath,runner:async(command,args)=>{
    calls.push(args);
    return JSON.stringify(args.at(-1)==='probe'?{ready:true}:{ok:true,id:'abcdefghijk',path:file});
  }});
  assert.equal(await source.prepare(),true);
  const output=await source.acquire({title:'A title with "quotes"',artist:'An artist',jobDir:folder});
  assert.equal(output.source,'youtube');assert.equal(output.sourceUrl,'https://www.youtube.com/watch?v=abcdefghijk');
  assert.ok(calls[1].includes('A title with "quotes"'));assert.ok(!calls.flat().some(a=>/token|cookie|api.key/i.test(a)));
  source.runner=async()=>JSON.stringify({ok:true,id:'abcdefghijk',path:'/etc/passwd'});
  await assert.rejects(source.acquire({title:'A',artist:'B',jobDir:folder}),/путь файла/);
});

test('public source reports availability errors without leaking extractor details',async()=>{
  const source=new PublicAudioSource({runner:async()=>{throw new Error('signed media URL and internal trace');}});
  await assert.rejects(source.acquire({title:'A',artist:'B',jobDir:'/tmp'}),e=>/API-ключ не требуется/.test(e.message)&&!e.message.includes('signed media'));
  source.runner=async()=>JSON.stringify({ok:false,error:'Публичный источник недоступен.'});
  await assert.rejects(source.acquire({title:'A',artist:'B',jobDir:'/tmp'}),/источник недоступен/);
});
