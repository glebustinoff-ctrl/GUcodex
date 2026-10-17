import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Transform, Readable } from 'node:stream';
import { parseLyrics, createASS, background, THEMES } from './lib.js';
import { VKMusic } from './vk.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MAX_BYTES = 100 * 1024 * 1024;
const ID = /^[a-f0-9-]{36}$/;
const DEMO = '[00:00.00]Город засыпает\n[00:04.00]Зажигаются огни\n[00:08.00]Мы оставим все заботы\n[00:12.00]Где-то там, за шумом дня\n[00:16.00]Эта музыка с тобою\n[00:20.00]Эта песня про меня\n[00:24.00]Пой, пока не станет светло\n[00:28.00]Начинается наш день';

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

async function probe(file) {
  const result = JSON.parse(await run('ffprobe', ['-v','error','-show_entries','format=duration:stream=codec_type,channels','-of','json', file]));
  const duration = +result.format?.duration;
  const audio = result.streams?.find(s => s.codec_type === 'audio');
  if (!audio || !Number.isFinite(duration) || duration <= 0 || duration > 1200) throw new Error('Нужен аудиофайл длительностью до 20 минут.');
  return { duration, channels: audio.channels };
}
async function jsonBody(req) {
  let body = '';
  for await (const data of req) {
    body += data;
    if (body.length > 100000) throw Object.assign(new Error('Запрос слишком большой.'), { status: 413 });
  }
  try { return JSON.parse(body); } catch { throw new Error('Некорректный JSON.'); }
}

export async function createApp({ dataDir = path.join(ROOT, '.data'), lyricsBase = 'https://lrclib.net', vkOptions } = {}) {
  await mkdir(dataDir, { recursive: true });
  const jobs = new Map();
  const vk = new VKMusic(vkOptions);
  let busy = false;
  async function audioRecord(id) {
    if (!ID.test(id || '')) throw new Error('Выберите аудиофайл.');
    try { return JSON.parse(await readFile(path.join(dataDir, `${id}.json`), 'utf8')); }
    catch { throw Object.assign(new Error('Аудиофайл не найден. Загрузите его ещё раз.'), { status: 404 }); }
  }
  const send = (res, code, data) => { res.writeHead(code, { 'Content-Type':'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { status: 'ok' });
      if (req.method === 'GET' && url.pathname === '/api/vk/status') return send(res,200,{configured:vk.configured,verified:false});
      if (req.method === 'GET' && url.pathname === '/api/vk/search') {
        const title = (url.searchParams.get('title') || '').trim().slice(0,150);
        const artist = (url.searchParams.get('artist') || '').trim().slice(0,150);
        if (!title) throw new Error('Введите название песни для поиска в VK.');
        return send(res,200,await vk.search(title,artist));
      }
      if (req.method === 'POST' && url.pathname === '/api/vk/import') {
        const body = await jsonBody(req);
        const { response, name } = await vk.getFile(body.id);
        if (+response.headers.get('content-length') > MAX_BYTES) { await response.body?.cancel(); throw new Error('Аудиофайл VK больше 100 МБ.'); }
        const id = randomUUID(), file = path.join(dataDir,`${id}.audio`);
        let bytes = 0;
        const limiter = new Transform({ transform(chunk,enc,cb) { bytes += chunk.length; cb(bytes > MAX_BYTES ? new Error('Аудиофайл VK больше 100 МБ.') : null,chunk); } });
        try {
          await pipeline(Readable.fromWeb(response.body),limiter,createWriteStream(file,{flags:'wx'}));
          const info = await probe(file);
          const record = {id,...info,name,source:'vk',sourceId:body.id};
          await writeFile(path.join(dataDir,`${id}.json`),JSON.stringify(record));
          return send(res,201,record);
        } catch (error) { await rm(file,{force:true}); throw new Error(error.message.startsWith('ffprobe:') ? 'Не удалось прочитать аудио VK.' : error.message); }
      }
      if (req.method === 'GET' && url.pathname === '/api/search') {
        const title = (url.searchParams.get('title') || '').trim().slice(0, 150);
        const artist = (url.searchParams.get('artist') || '').trim().slice(0, 150);
        if (!title) throw new Error('Введите название песни.');
        const target = new URL('/api/search', lyricsBase);
        target.searchParams.set('track_name', title);
        if (artist) target.searchParams.set('artist_name', artist);
        try {
          const response = await fetch(target, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent':'KaraokeStudio/0.1 (lyrics search)' } });
          if (!response.ok) throw new Error(`LRCLIB HTTP ${response.status}`);
          const results = await response.json();
          if (!Array.isArray(results)) throw new Error('Unexpected LRCLIB response');
          return send(res, 200, { songs: results.slice(0, 12).map(song => ({ id: song.id, title: song.trackName, artist: song.artistName, album: song.albumName, duration: song.duration, syncedLyrics: song.syncedLyrics || '', plainLyrics: song.plainLyrics || '', instrumental: !!song.instrumental })) });
        } catch (error) {
          console.error('Lyrics search:', error.message);
          return send(res, 502, { error: 'Источник текстов сейчас недоступен. Загрузите LRC/TXT или вставьте текст вручную. В облачной среде нужен сетевой доступ к lrclib.net.' });
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/background') {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control':'public, max-age=86400' });
        return res.end(background(url.searchParams.get('theme') || 'violet'));
      }
      if (req.method === 'POST' && url.pathname === '/api/upload') {
        if (+req.headers['content-length'] > MAX_BYTES) throw Object.assign(new Error('Файл должен быть не больше 100 МБ.'), { status: 413 });
        const id = randomUUID(), file = path.join(dataDir, `${id}.audio`);
        let size = 0;
        const limiter = new Transform({ transform(chunk, enc, cb) { size += chunk.length; cb(size > MAX_BYTES ? new Error('Файл должен быть не больше 100 МБ.') : null, chunk); } });
        try {
          await pipeline(req, limiter, createWriteStream(file, { flags: 'wx' }));
          const info = await probe(file);
          const record = { id, ...info, name: (url.searchParams.get('name') || 'audio').slice(0, 200) };
          await writeFile(path.join(dataDir, `${id}.json`), JSON.stringify(record));
          return send(res, 201, record);
        } catch (error) { await rm(file, { force: true }); throw new Error(error.message.startsWith('ffprobe:') ? 'Не удалось прочитать аудио. Выберите MP3, WAV, M4A, OGG или FLAC.' : error.message); }
      }
      if (req.method === 'POST' && url.pathname === '/api/demo') {
        const id = randomUUID(), file = path.join(dataDir, `${id}.audio`);
        await run('ffmpeg', ['-v','error','-f','lavfi','-i','aevalsrc=0.14*sin(2*PI*220*t)+0.08*sin(2*PI*277.18*t)+0.06*sin(2*PI*329.63*t):s=44100:d=32','-af','afade=t=in:d=1,afade=t=out:st=30:d=2','-ac','2','-f','wav',file]);
        const record = { id, duration: 32, channels: 2, name: 'Демо · синтезированный аккорд.wav' };
        await writeFile(path.join(dataDir, `${id}.json`), JSON.stringify(record));
        return send(res, 201, { ...record, lyrics: DEMO, title: 'Город засыпает', artist: 'Karaoke Studio · демо' });
      }
      if (req.method === 'POST' && url.pathname === '/api/render') {
        if (busy) return send(res, 409, { error:'Уже создаётся видео. Дождитесь завершения.' });
        const body = await jsonBody(req), audio = await audioRecord(body.audioId);
        if (body.vocalMode === 'reduce' && audio.channels < 2) throw new Error('Приглушение вокала работает только со стереофайлами. Загрузите минус или используйте оригинал.');
        const lines = parseLyrics(body.lyrics || '', audio.duration, body.offset || 0);
        if (!lines.length) throw new Error('Таймкоды оказались за пределами трека. Проверьте текст и сдвиг.');
        const id = randomUUID(), jobDir = path.join(dataDir, id);
        await mkdir(jobDir);
        const theme = THEMES[body.theme] ? body.theme : 'violet';
        await writeFile(path.join(jobDir, 'background.png'), background(theme));
        await writeFile(path.join(jobDir, 'lyrics.ass'), createASS({ title: body.title, artist: body.artist, lines, duration: audio.duration, theme, fontSize: body.fontSize }));
        const job = { id, status:'rendering', progress: 0, duration: audio.duration };
        jobs.set(id, job); busy = true;
        const args = ['-hide_banner','-loglevel','error','-y','-loop','1','-framerate','30','-i',path.join(jobDir,'background.png'),'-i',path.join(dataDir,`${audio.id}.audio`),'-map','0:v:0','-map','1:a:0','-vf',`ass=${path.join(jobDir,'lyrics.ass')}`];
        if (body.vocalMode === 'reduce') args.push('-af','pan=stereo|c0=c0-c1|c1=c1-c0');
        args.push('-c:v','libx264','-preset','ultrafast','-crf','23','-threads','2','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-t',String(audio.duration),'-movflags','+faststart','-progress','pipe:1','-nostats',path.join(jobDir,'karaoke.mp4'));
        run('ffmpeg', args, { timeout: Math.max(180000, audio.duration * 15000), onProgress(text) { for (const m of text.matchAll(/out_time_us=(\d+)/g)) job.progress = Math.min(99, Math.round(+m[1] / 1e6 / audio.duration * 100)); } })
          .then(() => { job.status = 'done'; job.progress = 100; job.downloadUrl = `/api/download/${id}`; })
          .catch(error => { console.error('Render:', error.message); job.status = 'error'; job.error = 'Не удалось создать видео. Проверьте аудио и доступное место на диске.'; })
          .finally(() => { busy = false; });
        return send(res, 202, job);
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/jobs/')) {
        const job = jobs.get(url.pathname.split('/').pop());
        return send(res, job ? 200 : 404, job || { error:'Задача не найдена. Сервер мог быть перезапущен.' });
      }
      if (req.method === 'GET' && (url.pathname.startsWith('/api/audio/') || url.pathname.startsWith('/api/download/'))) {
        const id = url.pathname.split('/').pop();
        if (!ID.test(id)) throw Object.assign(new Error('Файл не найден.'), { status: 404 });
        const isVideo = url.pathname.startsWith('/api/download/');
        const file = isVideo ? path.join(dataDir,id,'karaoke.mp4') : path.join(dataDir,`${id}.audio`);
        const info = await stat(file).catch(() => null);
        if (!info) throw Object.assign(new Error('Файл не найден.'), { status: 404 });
        if (isVideo && jobs.get(id)?.status !== 'done') throw new Error('Видео ещё создаётся.');
        const headers = { 'Content-Type': isVideo ? 'video/mp4' : 'application/octet-stream', 'Accept-Ranges':'bytes', 'Cache-Control':'private, no-store' };
        if (isVideo) headers['Content-Disposition'] = 'attachment; filename="karaoke-1080x1920.mp4"';
        let start = 0, end = info.size - 1, code = 200;
        if (req.headers.range) {
          const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
          if (!match) { res.writeHead(416, { 'Content-Range':`bytes */${info.size}` }); return res.end(); }
          start = +match[1]; end = match[2] ? Math.min(+match[2], end) : end; code = 206;
          if (start > end || start >= info.size) { res.writeHead(416, { 'Content-Range':`bytes */${info.size}` }); return res.end(); }
          headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
        }
        headers['Content-Length'] = end - start + 1;
        res.writeHead(code, headers);
        const stream = createReadStream(file, { start, end });
        res.on('close', () => stream.destroy());
        stream.pipe(res); return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error:'Метод не поддерживается.' });
      const files = { '/':'index.html', '/app.js':'app.js', '/styles.css':'styles.css', '/timing.js':'timing.js', '/config.js':'config.js', '/runtime.js':'runtime.js', '/web-render.js':'web-render.js' };
      const name = files[url.pathname];
      if (!name) return send(res, 404, { error:'Страница не найдена.' });
      const content = await readFile(path.join(ROOT, 'public', name));
      const type = { html:'text/html; charset=utf-8', js:'text/javascript; charset=utf-8', css:'text/css; charset=utf-8' }[name.split('.').pop()];
      res.writeHead(200, { 'Content-Type': type, 'Content-Length':content.length }); res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (!res.headersSent && !res.destroyed) send(res, error.status || 400, { error: error.message });
    }
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await createApp();
  server.listen(Number(process.env.PORT) || 3000, '0.0.0.0', () => console.log(`Karaoke Studio listening on port ${Number(process.env.PORT) || 3000}`));
}
