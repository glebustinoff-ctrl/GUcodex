import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,copyFile,stat} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {run,probe,renderVideo} from './media.js';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const clean=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/ё/g,'е').replace(/\((?:re)?master(?:ed)?[^)]*\)/g,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
export function matchSong(songs,title,artist) {
  const matches=songs.filter(s=>clean(s.title)===clean(title)&&clean(s.artist)===clean(artist));
  if(!matches.length)throw new Error('Не найдена запись с совпадающими названием и исполнителем. Уточни написание песни.');
  return matches.find(s=>s.duration>30)||matches[0];
}
export function separatorReady(){return existsSync(path.join(ROOT,'.venv/bin/python'))&&existsSync(path.join(ROOT,'.models/ready.json'));}

export async function createAutomaticVideo({job,dataDir,source,title,artist,theme='violet',fontSize=64,lyricsBase='https://lrclib.net',separate=separateVocals,fetchImpl=fetch}) {
  const jobDir=path.join(dataDir,job.id);await mkdir(jobDir,{recursive:true});
  const stage=(step,message,progress)=>Object.assign(job,{step,message,progress});
  stage('search','Находим оригинальную запись',5);
  const acquired=await source.acquire({title,artist,jobDir});
  const originalId=randomUUID(),original=path.join(dataDir,`${originalId}.audio`);
  const size=(await stat(acquired.path)).size;
  if(!size||size>100*1024*1024)throw new Error('Полученный аудиофайл пуст или больше 100 МБ.');
  await copyFile(acquired.path,original);
  const info=await probe(original);
  source.verified=true;job.source=source.name;job.sourceUrl=acquired.sourceUrl;
  await writeFile(path.join(dataDir,`${originalId}.json`),JSON.stringify({id:originalId,...info,name:`${artist} — ${title} · оригинал`,source:acquired.source||'public'}));
  stage('lyrics','Получаем текст и тайминги',20);
  const url=new URL('/api/search',lyricsBase);url.searchParams.set('track_name',title);url.searchParams.set('artist_name',artist);
  let songs;
  try{const result=await fetchImpl(url,{signal:AbortSignal.timeout(20000)});if(!result.ok)throw new Error();songs=await result.json();}
  catch{throw new Error('Не удалось получить текст из LRCLIB. Попробуй позже.');}
  if(!Array.isArray(songs))throw new Error('Источник текста вернул некорректный ответ.');
  const exact=songs.filter(s=>clean(s.trackName)===clean(title)&&clean(s.artistName)===clean(artist)&&(s.syncedLyrics||s.plainLyrics));
  exact.sort((a,b)=>Math.abs((+a.duration||0)-info.duration)-Math.abs((+b.duration||0)-info.duration));
  const song=exact.find(s=>s.syncedLyrics&&Math.abs(+s.duration-info.duration)<=6)||exact.find(s=>s.plainLyrics);
  if(!song)throw new Error('Не найден текст для этой песни. Автоматическое создание остановлено.');
  const synced=!!song.syncedLyrics&&Math.abs(+song.duration-info.duration)<=6;
  const lyrics=synced?song.syncedLyrics:song.plainLyrics;
  await writeFile(path.join(jobDir,'lyrics.txt'),lyrics);
  job.timing=synced?'lrc':'estimated';job.duration=info.duration;
  job.warning=synced?'Таймкоды строк взяты из LRC; подсветка слов приблизительная.':'Точных таймкодов не найдено: строки распределены приблизительно.';
  stage('separating','Отделяем вокал нейросетью и создаём минус',35);
  const minusPath=await separate(original,jobDir);
  const minusInfo=await probe(minusPath);
  if(Math.abs(minusInfo.duration-info.duration)>.2)throw new Error('Длительность минуса не совпала с оригиналом.');
  const minusId=randomUUID();await copyFile(minusPath,path.join(dataDir,`${minusId}.audio`));
  await writeFile(path.join(dataDir,`${minusId}.json`),JSON.stringify({id:minusId,...minusInfo,name:`${artist} — ${title} · минус`,source:'demucs'}));
  stage('video','Собираем полное караоке-видео 9:16',65);
  await renderVideo({audioPath:minusPath,jobDir,title,artist,lyrics,duration:info.duration,theme,fontSize},p=>{job.progress=Math.min(99,65+Math.floor(p*.34));});
  Object.assign(job,{status:'done',step:'done',message:'Караоке готово',progress:100,title,artist,originalId,minusId,downloadUrl:`/api/download/${job.id}`,lyricsUrl:`/api/auto/output/${job.id}?file=lyrics`,minusUrl:`/api/auto/output/${job.id}?file=minus`,originalUrl:`/api/audio/${originalId}`});
  await writeFile(path.join(jobDir,'result.json'),JSON.stringify(job));
}

export async function separateVocals(original,jobDir) {
  if(!separatorReady())throw new Error('Нейросеть для минуса ещё не подготовлена на сервере.');
  const wav=path.join(jobDir,`decoded-${randomUUID()}.wav`);
  await run('ffmpeg',['-v','error','-y','-i',original,'-ac','2','-ar','44100',wav]);
  const output=path.join(jobDir,'stems');
  await run(path.join(ROOT,'.venv/bin/python'),[path.join(ROOT,'scripts/separate.py'),wav,output],{timeout:3600000});
  return path.join(output,'htdemucs','no_vocals.wav');
}
