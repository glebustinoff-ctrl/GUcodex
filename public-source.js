import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {existsSync} from 'node:fs';
import {stat} from 'node:fs/promises';
import {run} from './media.js';

const ROOT=path.dirname(fileURLToPath(import.meta.url));

export class PublicAudioSource {
  constructor({python=path.join(ROOT,'.venv/bin/python'),runner=run}={}){
    this.python=python;this.runner=runner;this.name='YouTube';this.configured=false;
  }
  async prepare(){
    if(!existsSync(this.python))return false;
    try{
      const result=JSON.parse(await this.runner(this.python,[path.join(ROOT,'scripts/public_audio.py'),'probe'],{timeout:30000}));
      this.configured=result.ready===true;
    }catch{this.configured=false;}
    return this.configured;
  }
  async acquire({title,artist,jobDir}){
    let result;
    try{
      result=JSON.parse(await this.runner(this.python,[path.join(ROOT,'scripts/public_audio.py'),'acquire','--title',title,'--artist',artist,'--directory',jobDir],{timeout:300000}));
    }catch{
      throw new Error('Не удалось получить песню из открытого источника. Возможны сетевая блокировка, недоступная запись или запрос входа на стороне YouTube. API-ключ не требуется.');
    }
    if(result.ok!==true)throw new Error(result.error||'Источник не предоставил аудиофайл.');
    if(!/^[A-Za-z0-9_-]{11}$/.test(result.id||''))throw new Error('Источник вернул некорректный идентификатор записи.');
    const file=path.resolve(String(result.path||'')),root=path.resolve(jobDir)+path.sep;
    if(!file.startsWith(root))throw new Error('Источник вернул неподдерживаемый путь файла.');
    const info=await stat(file);
    if(!info.isFile()||info.size===0||info.size>100*1024*1024)throw new Error('Полученный аудиофайл пуст или больше 100 МБ.');
    return {path:file,source:'youtube',sourceId:result.id,sourceUrl:`https://www.youtube.com/watch?v=${result.id}`};
  }
}
