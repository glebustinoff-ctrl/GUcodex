import { renderInBrowser, browserFormat } from './web-render.js';

export const staticMode = window.KARAOKE_STATIC === true;
export const backgroundURL = theme => staticMode ? `./assets/background-${theme}.png` : `/api/background?theme=${theme}`;
export const videoFormat = staticMode ? browserFormat() : { extension:'mp4', label:'MP4' };
const urls = new Map(), jobs = new Map();
let database;
function db() {
  return database ||= new Promise((resolve,reject) => {
    const request = indexedDB.open('karaoke-audio',1);
    request.onupgradeneeded = () => request.result.createObjectStore('files');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Хранилище аудио в браузере недоступно.'));
  });
}
async function store(id,record) {
  const database = await db();
  return new Promise((resolve,reject) => {
    const tx = database.transaction('files','readwrite');
    tx.objectStore('files').put(record,id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(new Error('Не хватает места в браузере для аудио.'));
    tx.onabort = tx.onerror;
  });
}
async function read(id) {
  const database = await db();
  return new Promise((resolve,reject) => {
    const request = database.transaction('files').objectStore('files').get(id);
    request.onsuccess = () => request.result ? resolve(request.result) : reject(new Error('Аудиофайл не найден в этом браузере. Выбери его заново.'));
    request.onerror = () => reject(new Error('Не удалось прочитать аудио.'));
  });
}
export async function audioURL(track) {
  if (!staticMode) return `/api/audio/${track.id}`;
  if (!urls.has(track.id)) urls.set(track.id,URL.createObjectURL((await read(track.id)).blob));
  return urls.get(track.id);
}
async function addFile(blob,name) {
  if (!(blob instanceof Blob) || !blob.size || blob.size > 100*1024*1024) throw new Error('Нужен аудиофайл до 100 МБ.');
  const objectURL = URL.createObjectURL(blob);
  const probe = new Audio();
  let duration;
  try {
    duration = await new Promise((resolve,reject) => {
      const timer = setTimeout(() => { probe.removeAttribute('src'); probe.load(); reject(new Error('Не удалось прочитать длительность аудио.')); },30000);
      probe.onloadedmetadata = () => { clearTimeout(timer); resolve(probe.duration); };
      probe.onerror = () => { clearTimeout(timer); reject(new Error('Браузер не поддерживает этот аудиофайл. Попробуй MP3 или WAV.')); };
      probe.src = objectURL;
    });
  } finally { probe.removeAttribute('src'); probe.load(); URL.revokeObjectURL(objectURL); }
  if (!Number.isFinite(duration) || duration <= 0 || duration > 1200) throw new Error('Нужен аудиофайл длительностью до 20 минут.');
  const id = crypto.randomUUID(), meta = {id,name,duration};
  await store(id,{blob,meta}); return meta;
}
function demoWav() {
  const rate = 22050, length = rate*32, buffer = new ArrayBuffer(44+length*2), view = new DataView(buffer);
  const word = (offset,text) => [...text].forEach((c,i) => view.setUint8(offset+i,c.charCodeAt(0)));
  word(0,'RIFF');view.setUint32(4,36+length*2,true);word(8,'WAVE');word(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,rate,true);view.setUint32(28,rate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);word(36,'data');view.setUint32(40,length*2,true);
  for(let i=0;i<length;i++){const t=i/rate,fade=Math.min(1,t,(32-t)/2);view.setInt16(44+i*2,Math.round(32767*fade*(.14*Math.sin(2*Math.PI*220*t)+.08*Math.sin(2*Math.PI*277.18*t)+.06*Math.sin(2*Math.PI*329.63*t))),true);}
  return new Blob([buffer],{type:'audio/wav'});
}
async function staticRequest(path,options) {
  const url = new URL(path,location.origin);
  if(url.pathname==='/api/vk/status')return {configured:false,verified:false};
  if(url.pathname.startsWith('/api/vk/'))throw new Error('Поиск VK требует отдельного сервера с аудиодоступом VK. На этой странице можно загрузить свои аудиофайлы.');
  if(url.pathname==='/api/upload')return addFile(options.body,url.searchParams.get('name')||'Аудио');
  if(url.pathname==='/api/demo')return {...await addFile(demoWav(),'Демо · синтезированный аккорд.wav'),title:'Город засыпает',artist:'Karaoke Studio · демо',lyrics:'[00:00.00]Город засыпает\n[00:04.00]Зажигаются огни\n[00:08.00]Мы оставим все заботы\n[00:12.00]Где-то там, за шумом дня\n[00:16.00]Эта музыка с тобою\n[00:20.00]Эта песня про меня\n[00:24.00]Пой, пока не станет светло\n[00:28.00]Начинается наш день'};
  if(url.pathname==='/api/search') {
    const target = new URL('https://lrclib.net/api/search');
    target.searchParams.set('track_name',url.searchParams.get('title')||'');
    if(url.searchParams.get('artist'))target.searchParams.set('artist_name',url.searchParams.get('artist'));
    let response;
    try{response=await fetch(target,{signal:options.signal||AbortSignal.timeout(20000)});}catch{throw new Error('Не удалось подключиться к библиотеке текстов. Вставь текст вручную или загрузи LRC.');}
    if(!response.ok)throw new Error('Библиотека текстов временно недоступна.');
    const songs=await response.json();
    if(!Array.isArray(songs))throw new Error('Источник вернул некорректный результат.');
    return {songs:songs.slice(0,12).map(s=>({id:s.id,title:s.trackName,artist:s.artistName,album:s.albumName,duration:s.duration,syncedLyrics:s.syncedLyrics||'',plainLyrics:s.plainLyrics||''}))};
  }
  if(url.pathname==='/api/render') {
    if([...jobs.values()].some(job=>job.status==='rendering'))throw new Error('Дождись завершения текущего видео.');
    const body=JSON.parse(options.body),id=crypto.randomUUID(),job={id,status:'rendering',progress:0};
    jobs.set(id,job);
    // Start synchronously while user activation is available for Web Audio.
    renderInBrowser(body,async()=>(await read(body.audioId)).blob,progress=>{job.progress=progress;})
      .then(result=>Object.assign(job,{status:'done',progress:100,downloadUrl:URL.createObjectURL(result.blob),extension:result.extension,label:result.label}))
      .catch(error=>Object.assign(job,{status:'error',error:error.message}));
    return {...job};
  }
  if(url.pathname.startsWith('/api/jobs/')) {
    const job=jobs.get(url.pathname.split('/').pop());
    if(!job)throw new Error('Задача не найдена.');
    return {...job};
  }
  throw new Error('Эта операция требует серверной версии сайта.');
}
export async function requestJSON(url,options={}) {
  if(staticMode)return staticRequest(url,options);
  const response=await fetch(url,{signal:AbortSignal.timeout(120000),...options});
  let data;
  try{data=await response.json();}catch{throw new Error('Сервер не ответил. Проверь соединение и повтори попытку.');}
  if(!response.ok)throw new Error(data.error||'Не удалось выполнить запрос.');
  return data;
}
