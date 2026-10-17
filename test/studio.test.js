import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp, run } from '../server.js';
import { parseLyrics, createASS, background } from '../lib.js';

test('LRC: multiple timestamps, sorting, offset and clipped duration', () => {
  assert.deepEqual(parseLyrics('[ar:Исполнитель]\n[00:02.00][00:06.00]Припев\n[00:00.50]Начало', 8, -1), [
    { text:'Начало', start:0, end:1 },
    { text:'Припев', start:1, end:5 },
    { text:'Припев', start:5, end:7 },
  ]);
  assert.deepEqual(parseLyrics('Первая\nВторая', 10), [{text:'Первая',start:0,end:5},{text:'Вторая',start:5,end:10}]);
  assert.throws(() => parseLyrics('[00:01]Первая\nВторая', 10), /для всех строк/);
  assert.throws(() => parseLyrics('[00:99]Ошибка', 10), /Некорректное время/);
  assert.throws(() => parseLyrics('Текст', 10, NaN), /Сдвиг/);
  assert.throws(() => parseLyrics('', 10), /Добавьте текст/);
  assert.deepEqual(parseLyrics('[00:01]Строка\n[00:03]\n[00:05]После паузы\n[00:07]', 10), [
    {text:'Строка',start:1,end:3}, {text:'После паузы',start:5,end:7},
  ]);
});

test('ASS contains progressive karaoke and strips subtitle control sequences', () => {
  const ass = createASS({ title:'{\\pos(1,1)}Название', artist:'Автор', duration:2, lines:[{start:0,end:2,text:'Привет мир'}] });
  assert.match(ass, /PlayResX: 1080/); assert.match(ass, /PlayResY: 1920/);
  assert.match(ass, /\\kf133/); assert.match(ass, /\\kf67/);
  assert.doesNotMatch(ass, /\{\\pos\(1,1\)\}/);
  for (const theme of ['violet','ocean','sunset']) assert.equal(background(theme).subarray(1,4).toString(), 'PNG');
  assert.notDeepEqual(background('violet'), background('ocean'));
});

const listen = server => new Promise(resolve => server.listen(0,'127.0.0.1',() => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
const json = (base, url, body) => fetch(base + url, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });

test('HTTP workflow: lyrics lookup, real audio upload, full MP4 export and range playback', { timeout:120000 }, async t => {
  const temp = await mkdtemp(path.join(tmpdir(), 'karaoke-test-'));
  const upstream = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.searchParams.get('track_name') === 'unavailable') { res.writeHead(503); return res.end(); }
    assert.equal(url.pathname, '/api/search');
    assert.equal(url.searchParams.get('track_name'), 'Тест');
    assert.equal(url.searchParams.get('artist_name'), 'Автор');
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify([{ id:1, trackName:'Тест',artistName:'Автор',duration:2.4,syncedLyrics:'[00:00]Первая строка\n[00:01.20]Вторая строка',plainLyrics:'Первая строка\nВторая строка' }]));
  });
  const upstreamURL = await listen(upstream);
  let fixtureAudio;
  const server = await createApp({ dataDir:path.join(temp,'data'),lyricsBase:upstreamURL, vkOptions:{token:'test-fixture-token',fetchImpl:async target => {
    if (String(target).endsWith('audio.search')) return Response.json({response:{items:[{owner_id:1,id:2,title:'Тест',artist:'Автор',duration:2.4}]}});
    if (String(target).endsWith('audio.getById')) return Response.json({response:[{title:'Тест',artist:'Автор',url:'https://fixture.vkuseraudio.net/audio.mp3'}]});
    return new Response(fixtureAudio,{headers:{'content-type':'audio/wav'}});
  }} });
  const base = await listen(server);
  t.after(async () => { await close(server); await close(upstream); await rm(temp,{recursive:true,force:true}); });

  const page = await fetch(base); assert.equal(page.status,200); assert.match(await page.text(), /Дай песне/);
  const search = await fetch(base + '/api/search?' + new URLSearchParams({ title:'Тест', artist:'Автор' }));
  const song = (await search.json()).songs[0]; assert.equal(song.title,'Тест'); assert.match(song.syncedLyrics, /00:01.20/);
  assert.equal((await fetch(base + '/api/search?title=unavailable')).status,502);
  assert.equal((await fetch(base + '/api/search')).status,400);
  const invalid = await fetch(base + '/api/upload?name=broken.mp3',{ method:'POST',body:'not audio' }); assert.equal(invalid.status,400);

  const wav = path.join(temp,'track.wav');
  await run('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:duration=2.4','-ac','2',wav]);
  fixtureAudio = await readFile(wav);
  const vkResults = await (await fetch(base + '/api/vk/search?title=Test')).json();
  assert.equal(vkResults.plus[0].id,'1_2');
  const imported = await json(base,'/api/vk/import',{id:'1_2'});
  assert.equal(imported.status,201); const vkAudio = await imported.json(); assert.equal(vkAudio.duration,2.4); assert.equal(vkAudio.source,'vk');
  assert.equal((await fetch(base + `/api/audio/${vkAudio.id}`)).status,200);
  const upload = await fetch(base + '/api/upload?name=track.wav',{ method:'POST',body:await readFile(wav) });
  assert.equal(upload.status,201); const audio = await upload.json(); assert.equal(audio.channels,2); assert.equal(audio.duration,2.4);
  const range = await fetch(base + `/api/audio/${audio.id}`,{ headers:{ Range:'bytes=0-99' } }); assert.equal(range.status,206); assert.equal((await range.arrayBuffer()).byteLength,100);
  assert.equal((await fetch(base + `/api/audio/${audio.id}`,{headers:{Range:'bytes=999999999-'}})).status,416);

  const body = { audioId:audio.id,title:'Тест',artist:'Автор',lyrics:song.syncedLyrics,theme:'ocean',fontSize:64 };
  assert.equal((await json(base,'/api/render',{...body,lyrics:''})).status,400);
  const render = await json(base,'/api/render',body); assert.equal(render.status,202); let job = await render.json();
  assert.equal((await json(base,'/api/render',body)).status,409);
  while (job.status === 'rendering') { await new Promise(r => setTimeout(r,200)); job = await (await fetch(base + `/api/jobs/${job.id}`)).json(); }
  assert.equal(job.status,'done'); assert.equal(job.progress,100);
  const download = await fetch(base + job.downloadUrl); assert.equal(download.status,200); assert.match(download.headers.get('content-type'),/video\/mp4/);
  const mp4 = path.join(temp,'output.mp4'); await writeFile(mp4,Buffer.from(await download.arrayBuffer()));
  const output = JSON.parse(await run('ffprobe',['-v','error','-show_streams','-show_format','-of','json',mp4]));
  const video = output.streams.find(s => s.codec_type === 'video');
  assert.equal(video.width,1080); assert.equal(video.height,1920); assert.equal(video.r_frame_rate,'30/1');
  assert.ok(Math.abs(+output.format.duration - audio.duration) < .15);
  assert.ok(output.streams.some(s => s.codec_type === 'audio' && s.codec_name === 'aac'));
  // Decode two lyric frames: the video must change as the karaoke progresses.
  const first = await run('ffmpeg',['-v','error','-ss','0.5','-i',mp4,'-frames:v','1','-f','md5','-']);
  const second = await run('ffmpeg',['-v','error','-ss','1.8','-i',mp4,'-frames:v','1','-f','md5','-']);
  assert.notEqual(first,second);

  const mono = path.join(temp,'mono.wav'); await run('ffmpeg',['-v','error','-f','lavfi','-i','sine=duration=1',mono]);
  const monoAudio = await (await fetch(base + '/api/upload?name=mono.wav',{method:'POST',body:await readFile(mono)})).json();
  const monoRender = await json(base,'/api/render',{...body,audioId:monoAudio.id,vocalMode:'reduce'}); assert.equal(monoRender.status,400); assert.match((await monoRender.json()).error,/стерео/);
});
