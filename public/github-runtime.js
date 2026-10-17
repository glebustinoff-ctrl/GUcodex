import {REQUEST_MARKER,RESULT_MARKER,validateRequest,encodeMessage,decodeMessage} from './github-protocol.js';

function browserStorage(){try{return globalThis.localStorage;}catch{return null;}}
export function createGitHubTransport({repository='glebustinoff-ctrl/GUcodex',fetchImpl=fetch,openWindow=(...args)=>window.open(...args),now=Date.now,uuid=()=>crypto.randomUUID(),storage=browserStorage()}={}){
  if(!/^[\w-]+\/[\w.-]+$/.test(repository))throw new Error('Некорректный репозиторий обработки.');
  const owner=repository.split('/')[0],jobs=new Map(),base=`https://api.github.com/repos/${repository}`;
  const storageKey=`karaoke-github-job:${repository}`;
  let latestId;
  function confirmationURL(request){
    const url=new URL(`https://github.com/${repository}/issues/new`);
    url.searchParams.set('title',`Караоке — запрос ${request.id}`);
    url.searchParams.set('body',encodeMessage(REQUEST_MARKER,validateRequest(request)));
    return url.href;
  }
  function checkResultURLs(result,issueNumber){
    const prefix=`https://github.com/${repository}/releases/download/karaoke-${issueNumber}/`;
    for(const key of ['downloadUrl','minusUrl','lyricsUrl','originalUrl'])if(result[key]&&(typeof result[key]!=='string'||!result[key].startsWith(prefix)))throw new Error('Некорректная ссылка результата.');
  }
  function remember(job){latestId=job.id;try{storage?.setItem(storageKey,JSON.stringify(job));}catch{/* Processing also works without browser storage. */}}
  try{
    const saved=JSON.parse(storage?.getItem(storageKey)||'null');
    if(saved){
      const request=validateRequest(saved);
      if(!Number.isFinite(saved.created)||saved.created<0||saved.created>now()+60000||!['processing','done','error'].includes(saved.status))throw new Error('Invalid saved job');
      const job={...request,created:saved.created,status:saved.status,step:['search','lyrics','separating','video','done'].includes(saved.step)?saved.step:'search',progress:Math.max(0,Math.min(100,Number(saved.progress)||0)),nextPoll:Math.min(Number(saved.nextPoll)||0,now()+60000)};
      for(const key of ['message','error','warning'])if(typeof saved[key]==='string')job[key]=saved[key].slice(0,1000);
      if(Number.isSafeInteger(saved.issueNumber)&&saved.issueNumber>0){job.issueNumber=saved.issueNumber;job.taskUrl=`https://github.com/${repository}/issues/${saved.issueNumber}`;}
      else if(job.status==='processing')job.confirmUrl=confirmationURL(request);
      if(job.status==='done'){
        if(!job.issueNumber||!saved.downloadUrl||!saved.minusUrl||!saved.lyricsUrl)throw new Error('Incomplete saved result');
        checkResultURLs(saved,job.issueNumber);
        for(const key of ['downloadUrl','minusUrl','lyricsUrl','originalUrl'])if(saved[key])job[key]=saved[key];
      }
      jobs.set(job.id,job);latestId=job.id;
    }
  }catch{/* Ignore damaged or outdated saved data. */}
  async function get(path){
    const response=await fetchImpl(base+path,{headers:{Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new Error(response.status===403||response.status===429?'GitHub временно ограничил частоту проверок.':'GitHub сейчас недоступен.');
    return response.json();
  }
  return async function githubRequest(path,options={}){
    if(path==='/api/auto/status')return {ready:true,requiresApiKey:false,transport:'github',source:'YouTube',notice:'YouTube → минус → MP4. После нажатия подтверди публичный запрос в GitHub кнопкой Create. Обработка доступна владельцу репозитория.'};
    if(path==='/api/auto/resume')return {...jobs.get(latestId)};
    if(path==='/api/auto'&&options.method==='POST'){
      const request=validateRequest({...JSON.parse(options.body),id:uuid()});
      const created=now(),job={...request,status:'processing',step:'search',progress:0,message:'Подтверди запрос в открывшемся GitHub: нажми Create / Submit new issue. Затем вернись сюда.',confirmUrl:confirmationURL(request),created,nextPoll:created+10000};
      jobs.set(request.id,job);remember(job);openWindow(job.confirmUrl,'_blank','noopener,noreferrer');
      return {...job};
    }
    const id=path.split('/').pop(),job=jobs.get(id);
    if(!job)throw new Error('Запрос не найден. Запусти создание ещё раз.');
    if(job.status!=='processing'||now()<job.nextPoll)return {...job};
    const expired=now()-job.created>2*60*60*1000;
    job.nextPoll=now()+(job.issueNumber||now()-job.created>120000?60000:30000);
    try{
      if(!job.issueNumber){
        const query=new URLSearchParams({creator:owner,state:'all',since:new Date(job.created-60000).toISOString(),per_page:'30'});
        const issues=await get(`/issues?${query}`);
        const issue=issues.find(item=>item.user?.login?.toLowerCase()===owner.toLowerCase()&&item.title===`Караоке — запрос ${id}`&&!item.pull_request);
        if(!issue){
          if(expired){job.status='error';job.confirmUrl=null;job.error='Запрос не был подтверждён в GitHub. Создай новый запрос на сайте.';}
          remember(job);return {...job};
        }
        // Check the submitted body too: changing title/artist in GitHub creates a different request.
        const submitted=validateRequest(decodeMessage(issue.body,REQUEST_MARKER));
        if(submitted.id!==id||submitted.title!==job.title||submitted.artist!==job.artist)throw new Error('Поля запроса в GitHub изменились. Запусти новый запрос на сайте.');
        job.issueNumber=issue.number;job.taskUrl=`https://github.com/${repository}/issues/${issue.number}`;job.confirmUrl=null;
        job.message='Запрос принят. Ожидаем запуска обработки; подготовка нейросети может занять несколько минут.';
      }
      const comments=await get(`/issues/${job.issueNumber}/comments?per_page=100`);
      for(const comment of comments.slice().reverse()){
        if(comment.user?.login!=='github-actions[bot]')continue;
        let result;try{result=decodeMessage(comment.body,RESULT_MARKER);}catch{continue;}
        if(result.id!==id)continue;
        checkResultURLs(result,job.issueNumber);
        for(const key of ['status','step','progress','message','error','title','artist','warning','downloadUrl','minusUrl','lyricsUrl','originalUrl'])if(result[key]!==undefined)job[key]=result[key];
        break;
      }
      if(expired&&job.status==='processing'){job.status='error';job.error='Время ожидания истекло. Проверь задачу в GitHub; готовый результат останется там.';}
    }catch(error){job.message=`${error.message} Повторим проверку через минуту; задача продолжает выполняться.`;job.nextPoll=now()+60000;}
    remember(job);
    return {...job};
  };
}
