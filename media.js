import {spawn} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {parseLyrics,createASS,background,THEMES} from './lib.js';

export function run(command, args, { onProgress, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', data => { stdout = (stdout + data).slice(-100000); onProgress?.(data.toString()); });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-12000); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(`${command}: ${stderr || `exit ${code}`}`)); });
  });
}

export async function probe(file) {
  const result = JSON.parse(await run('ffprobe', ['-v','error','-show_entries','format=duration:stream=codec_type,channels','-of','json', file]));
  const duration = +result.format?.duration;
  const audio = result.streams?.find(s => s.codec_type === 'audio');
  if (!audio || !Number.isFinite(duration) || duration <= 0 || duration > 1200) throw new Error('Нужен аудиофайл длительностью до 20 минут.');
  return { duration, channels: audio.channels };
}

export async function renderVideo({audioPath,jobDir,title,artist,lyrics,duration,theme='violet',fontSize=64,vocalMode='original',offset=0},onProgress=()=>{}) {
  const lines=parseLyrics(lyrics,duration,offset);
  if(!lines.length)throw new Error('Таймкоды находятся за пределами трека.');
  if(!THEMES[theme])theme='violet';
  await writeFile(path.join(jobDir,'background.png'),background(theme));
  await writeFile(path.join(jobDir,'lyrics.ass'),createASS({title,artist,lines,duration,theme,fontSize}));
  const args=['-hide_banner','-loglevel','error','-y','-loop','1','-framerate','30','-i',path.join(jobDir,'background.png'),'-i',audioPath,'-map','0:v:0','-map','1:a:0','-vf',`ass=${path.join(jobDir,'lyrics.ass')}`];
  if(vocalMode==='reduce')args.push('-af','pan=stereo|c0=c0-c1|c1=c1-c0');
  args.push('-c:v','libx264','-preset','ultrafast','-crf','23','-threads','2','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-t',String(duration),'-movflags','+faststart','-progress','pipe:1','-nostats',path.join(jobDir,'karaoke.mp4'));
  await run('ffmpeg',args,{timeout:Math.max(180000,duration*15000),onProgress(text){for(const m of text.matchAll(/out_time_us=(\d+)/g))onProgress(Math.min(99,Math.round(+m[1]/1e6/duration*100)));}});
  onProgress(100);
}
