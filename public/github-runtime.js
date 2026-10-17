import {REQUEST_MARKER,RESULT_MARKER,validateRequest,encodeMessage,decodeMessage} from './github-protocol.js';

export function createGitHubTransport({repository='glebustinoff-ctrl/GUcodex',fetchImpl=fetch,openWindow=(...args)=>window.open(...args),now=Date.now,uuid=()=>crypto.randomUUID()}={}){
  if(!/^[\w-]+\/[\w.-]+$/.test(repository))throw new Error('Некорректный репозиторий обработки.');
  const owner=repository.split('/')[0],jobs=new Map(),base=`https://api.github.com/repos/${repository}`;
  async function get(path){
    const response=await fetchImpl(base+path,{headers:{Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new Error(response.status===403||response.status===429?'GitHub временно ограничил частоту проверок.':'GitHub сейчас недоступен.');
    return response.json();
  }
  return async function githubRequest(path,options={}){
    if(path==='/api/auto/status')return {ready:true,requiresApiKey:false,transport:'github',source:'YouTube',notice:'YouTube → минус → MP4. После нажатия подтверди публичный запрос в GitHub кнопкой Create. Обработка доступна владельцу репозитория.'};
    if(path==='/api/auto'&&options.method==='POST'){
      const request=validateRequest({...JSON.parse(options.body),id:uuid()});
      const url=new URL(`https://github.com/${repository}/issues/new`);
      url.searchParams.set('title',`Караоке — запрос ${request.id}`);
      url.searchParams.set('body',encodeMessage(REQUEST_MARKER,request));
      const created=now(),job={...request,status:'processing',step:'search',progress:0,message:'Подтверди запрос в открывшемся GitHub: нажми Create / Submit new issue. Затем вернись сюда.',confirmUrl:url.href,created,nextPoll:created+10000};
      jobs.set(request.id,job);openWindow(url.href,'_blank','noopener,noreferrer');
      return {...job};
    }
    const id=path.split('/').pop(),job=jobs.get(id);
    if(!job)throw new Error('Запрос не найден. Запусти создание ещё раз.');
    if(job.status!=='processing'||now()<job.nextPoll)return {...job};
    if(now()-job.created>60*60*1000){job.status='error';job.error='Время ожидания истекло. Проверь задачу в GitHub и повтори запуск.';return {...job};}
    job.nextPoll=now()+(job.issueNumber?60000:30000);
    try{
      if(!job.issueNumber){
        const query=new URLSearchParams({creator:owner,state:'all',since:new Date(job.created-60000).toISOString(),per_page:'30'});
        const issues=await get(`/issues?${query}`);
        const issue=issues.find(item=>item.user?.login?.toLowerCase()===owner.toLowerCase()&&item.title===`Караоке — запрос ${id}`&&!item.pull_request);
        if(!issue)return {...job};
        // Check the submitted body too: changing title/artist in GitHub creates a different request.
        const submitted=validateRequest(decodeMessage(issue.body,REQUEST_MARKER));
        if(submitted.id!==id||submitted.title!==job.title||submitted.artist!==job.artist)throw new Error('Поля запроса в GitHub изменились. Запусти новый запрос на сайте.');
        job.issueNumber=issue.number;job.taskUrl=issue.html_url;job.confirmUrl=null;
        job.message='Запрос принят. Ожидаем запуска обработки; подготовка нейросети может занять несколько минут.';
      }
      const comments=await get(`/issues/${job.issueNumber}/comments?per_page=100`);
      for(const comment of comments.slice().reverse()){
        if(comment.user?.login!=='github-actions[bot]')continue;
        let result;try{result=decodeMessage(comment.body,RESULT_MARKER);}catch{continue;}
        if(result.id!==id)continue;
        for(const key of ['downloadUrl','minusUrl','lyricsUrl'])if(result[key]&&!result[key].startsWith(`https://github.com/${repository}/releases/download/karaoke-${job.issueNumber}/`))throw new Error('Некорректная ссылка результата.');
        for(const key of ['status','step','progress','message','error','title','artist','warning','downloadUrl','minusUrl','lyricsUrl'])if(result[key]!==undefined)job[key]=result[key];
        break;
      }
    }catch(error){job.message=`${error.message} Повторим проверку через минуту; задача продолжает выполняться.`;job.nextPoll=now()+60000;}
    return {...job};
  };
}
