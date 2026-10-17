import {readFile,mkdir,copyFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {PublicAudioSource} from '../public-source.js';
import {createAutomaticVideo,separateVocals} from '../automatic.js';
import {run,probe,renderVideo} from '../media.js';
import {REQUEST_MARKER,RESULT_MARKER,validateRequest,encodeMessage,decodeMessage} from '../public/github-protocol.js';

const event=JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH,'utf8'));
const repository=process.env.GITHUB_REPOSITORY;
if(!/^[\w-]+\/[\w.-]+$/.test(repository||''))throw new Error('Repository is required');
const owner=repository.split('/')[0];
const issue=event.issue;
const mode=issue?'issue':event.inputs?.mode||'source-check';
if(issue&&(issue.user.login.toLowerCase()!==owner.toLowerCase()||!issue.title.startsWith('Караоке — запрос ')))throw new Error('Only owner requests are processed');
const request=issue?validateRequest(decodeMessage(issue.body,REQUEST_MARKER)):validateRequest({id:randomUUID(),title:event.inputs?.title||'Test',artist:event.inputs?.artist||'Test'});
const dataDir=path.resolve('.data'),jobDir=path.join(dataDir,request.id);
await mkdir(jobDir,{recursive:true});
let job={...request,status:'processing',step:'search',progress:0,message:'Подготавливаем поиск на YouTube'},commentId,queue=Promise.resolve(),timer;
async function api(route,method='GET',data){
  const response=await fetch(`https://api.github.com/repos/${repository}${route}`,{method,headers:{Authorization:`Bearer ${process.env.GITHUB_TOKEN}`,Accept:'application/vnd.github+json','Content-Type':'application/json'},body:data?JSON.stringify(data):undefined,signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error(`GitHub: HTTP ${response.status}`);
  return response.status===204?null:response.json();
}
function report(){
  if(!issue)return Promise.resolve();
  const published=job.downloadUrl?.startsWith(`https://github.com/${repository}/releases/download/`);
  const visible={id:job.id,title:job.title,artist:job.artist,status:job.status==='done'&&!published?'processing':job.status,step:job.step,progress:job.progress,message:job.message};
  for(const key of ['error','warning'])if(job[key])visible[key]=job[key];
  if(published)for(const key of ['downloadUrl','minusUrl','lyricsUrl'])visible[key]=job[key];
  const body=encodeMessage(RESULT_MARKER,visible);
  queue=queue.catch(()=>{}).then(async()=>{
    if(commentId)await api(`/issues/comments/${commentId}`,'PATCH',{body});
    else commentId=(await api(`/issues/${issue.number}/comments`,'POST',{body})).id;
  });
  return queue;
}
try{
  await report();
  if(process.env.PREPARE_OUTCOME&&process.env.PREPARE_OUTCOME!=='success')throw new Error('Не удалось подготовить обработчик. Подробности — во вкладке Actions репозитория.');
  const source=new PublicAudioSource();await source.prepare();
  if(!source.configured)throw new Error('Обработчик YouTube не установлен.');
  if(mode==='source-check'){
    const acquired=await source.acquire({...request,jobDir});
    const info=await probe(acquired.path);
    console.log(JSON.stringify({source:'YouTube',sourceId:acquired.sourceId,duration:info.duration,downloadVerified:true}));
  }else if(mode==='selftest'){
    const original=path.join(jobDir,'synthetic.wav');
    await run('ffmpeg',['-v','error','-y','-f','lavfi','-i','sine=frequency=440:sample_rate=44100:duration=8','-ac','2',original]);
    const minus=await separateVocals(original,jobDir);
    await renderVideo({audioPath:minus,jobDir,title:'Проверка караоке',artist:'Karaoke Studio',lyrics:'[00:00.00]Проверяем музыку\n[00:04.00]И полное видео',duration:8});
    await mkdir('worker-output',{recursive:true});
    await copyFile(path.join(jobDir,'karaoke.mp4'),'worker-output/karaoke.mp4');
    const details=await probe('worker-output/karaoke.mp4');
    if(Math.abs(details.duration-8)>.2)throw new Error('Selftest duration mismatch');
    console.log('Neural inference and full 8-second MP4 verified');
  }else{
    timer=setInterval(()=>{void report().catch(()=>{});},30000);
    await createAutomaticVideo({job,dataDir,source,...request});
    // Keep the public status processing until all downloadable assets are uploaded.
    job.status='processing';job.message='Загружаем готовое видео';job.progress=99;
    await report();
    const output=path.resolve('worker-output');await mkdir(output,{recursive:true});
    await copyFile(path.join(jobDir,'karaoke.mp4'),path.join(output,'karaoke.mp4'));
    await run('ffmpeg',['-v','error','-y','-i',path.join(dataDir,`${job.minusId}.audio`),'-c:a','libmp3lame','-b:a','192k',path.join(output,'minus.mp3')]);
    const lyricsFile=job.timing==='lrc'?'lyrics.lrc':'lyrics.txt';
    await copyFile(path.join(jobDir,'lyrics.txt'),path.join(output,lyricsFile));
    if(!issue){
      const info=await probe(path.join(output,'karaoke.mp4'));
      if(Math.abs(info.duration-job.duration)>.2)throw new Error('Full video duration mismatch');
      const verification={source:job.source,sourceUrl:job.sourceUrl,fullVideoSeconds:info.duration,timing:job.timing,neuralSeparationVerified:true};
      await writeFile(path.join(output,'verification.json'),JSON.stringify(verification,null,2));
      console.log(JSON.stringify(verification));
    }else{
    const tag=`karaoke-${issue.number}`;
    await writeFile(path.join(jobDir,'notes.md'),`Результат запроса #${issue.number}. Исходная запись: ${job.sourceUrl}\n\n${job.warning||'Таймкоды строк из LRC; подсветка слов приблизительная.'}\n`);
    // gh uses the automatic workflow token, never a token supplied by a website visitor.
    await run('gh',['release','create',tag,'--repo',repository,'--title',`Караоке #${issue.number}`,'--notes-file',path.join(jobDir,'notes.md'),path.join(output,'karaoke.mp4'),path.join(output,'minus.mp3'),path.join(output,lyricsFile)],{timeout:600000});
    const base=`https://github.com/${repository}/releases/download/${tag}`;
    Object.assign(job,{status:'done',step:'done',progress:100,message:'Караоке готово',downloadUrl:`${base}/karaoke.mp4`,minusUrl:`${base}/minus.mp3`,lyricsUrl:`${base}/${lyricsFile}`});
    delete job.originalUrl;
    }
  }
  clearInterval(timer);await report();
}catch(error){
  clearInterval(timer);
  Object.assign(job,{status:'error',error:error.message,message:error.message});
  await report().catch(()=>{});
  console.error(error.message);process.exitCode=1;
}
