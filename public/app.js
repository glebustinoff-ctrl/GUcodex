import { parseLyrics } from './timing.js';
import {requestJSON,staticMode,backgroundURL,audioURL,videoFormat} from './runtime.js';

const $ = id => document.getElementById(id);
const fields = { title: $('song-title'), artist: $('song-artist'), lyrics: $('lyrics-input'), offset: $('lyrics-offset'), fontSize: $('font-size'), source: $('audio-source') };
const audio = $('audio-player');
const state = { minus: null, plus: null, theme: 'violet', lines: [], currentAudioId: null, uploading: 0, rendering: false, projectId: null };
let vkSearching = false;
let vkEnabled = false;
let automaticMode = true;
let stopWaiting=false;
let toastTimer, searchController, lastLine = -2, activeWords = [];
const accents = { violet:'#dfb7f6', ocean:'#a1e5da', sunset:'#ffb68d' };
const time = seconds => `${Math.floor((seconds || 0) / 60)}:${String(Math.floor((seconds || 0) % 60)).padStart(2, '0')}`;
const el = (tag, className, text) => { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; };

function toast(message) {
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6000);
}
async function api(url, options = {}) {
  return requestJSON(url,options);
}
const post = (url, data) => api(url, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) });
function selectedAudio() { return fields.source.value === 'minus' ? state.minus : state.plus; }
function isTimed() { return /\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/.test(fields.lyrics.value); }
function invalidateExport() { if (!state.rendering) { $('download-link').hidden = true; $('render-status').hidden = true; $('render-progress').hidden = true; } }

function updateLines() {
  const track = selectedAudio();
  try { state.lines = parseLyrics(fields.lyrics.value, track?.duration || 180, fields.offset.value); }
  catch { state.lines = []; }
  lastLine = -2;
  const count = fields.lyrics.value.trim().split('\n').filter(s => s.trim() && !/^\[(ar|al|ti|by|offset|length):/i.test(s)).length;
  $('line-count').textContent = `${count} строк`;
  $('sync-badge').classList.toggle('synced', isTimed());
  $('sync-badge').replaceChildren(el('span'), document.createTextNode(isTimed() ? 'Тайминги из LRC' : 'Автотайминг'));
  $('timing-note').textContent = isTimed() ? 'Время каждой строки взято из LRC. Подсветка слов внутри строки рассчитывается приблизительно.' : 'Без LRC строки распределяются равномерно. Для точного совпадения с вокалом отредактируй таймкоды.';
  $('workflow-audio').classList.toggle('current', !!track || count > 0);
  $('workflow-ready').classList.toggle('current', !!track && count > 0);
  updatePreview();
}

function updatePreview() {
  $('preview-title').textContent = fields.title.value.trim() || 'Здесь будет твоя песня';
  $('preview-artist').textContent = fields.artist.value.trim() || 'И твой голос в главной роли';
  const now = audio.currentTime || 0;
  let index = state.lines.findIndex(line => now >= line.start && now < line.end);
  const upcoming = state.lines.find(line => line.start > now);
  if (index !== lastLine) {
    lastLine = index;
    const current = $('lyric-current');
    current.replaceChildren(); activeWords = [];
    if (index >= 0) {
      const words = state.lines[index].text.split(/\s+/);
      const total = words.reduce((sum, w) => sum + w.length, 0);
      let offset = 0;
      words.forEach(word => {
        const span = el('span', 'word', word);
        activeWords.push({ span, start: offset / total, length: word.length / total });
        offset += word.length; current.append(span);
      });
    } else current.textContent = state.lines.length ? (upcoming ? 'Сейчас начнётся…' : 'Спасибо, что поёшь ♡') : 'Пой в своём ритме';
    $('lyric-next').textContent = index >= 0 ? (state.lines[index + 1]?.text || 'Твой голос — твоя сцена') : (upcoming?.text || 'А мы подскажем слова');
  }
  if (index >= 0) {
    const line = state.lines[index];
    const progress = Math.min(1, Math.max(0, (now - line.start) / (line.end - line.start)));
    activeWords.forEach(({ span, start, length }) => { span.style.setProperty('--word-progress', `${Math.max(0, Math.min(100, (progress - start) / length * 100))}%`); });
  }
  $('current-time').textContent = time(now);
  $('seek').value = now;
}
function updateAudio() {
  const track = selectedAudio();
  if (track?.id !== state.currentAudioId) {
    audio.pause();
    if (track) void audioURL(track).then(url=>{if(state.currentAudioId===track.id)audio.src=url;}).catch(error=>toast(error.message));
    else { audio.removeAttribute('src'); audio.load(); }
    state.currentAudioId = track?.id || null;
  }
  $('play-button').disabled = !track;
  $('seek').disabled = !track;
  $('seek').max = track?.duration || 100;
  $('total-time').textContent = time(track?.duration);
  $('audio-duration').replaceChildren();
  const durationIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use'); use.setAttribute('href', '#i-clock'); durationIcon.append(use);
  $('audio-duration').append(durationIcon, document.createTextNode(track ? `${time(track.duration)} · полный трек` : 'Аудио не выбрано'));
  $('reduce-note').hidden = fields.source.value !== 'reduce';
  updateLines();
}
function showTrack(kind, track) {
  state[kind] = track;
  $(`${kind}-zone`).classList.toggle('loaded', !!track);
  $(`${kind}-description`).textContent = track ? track.name : 'Перетащи или выбери файл';
}
function selectTheme(theme) {
  if (!accents[theme]) return;
  state.theme = theme;
  $('preview-background').src = backgroundURL(theme);
  $('phone-preview').style.setProperty('--highlight', accents[theme]);
  document.querySelectorAll('.theme-option').forEach(button => {
    const selected = button.dataset.theme === theme;
    button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected));
  });
  invalidateExport();
}
function updateFont() {
  $('lyric-current').style.fontSize = `${+fields.fontSize.value / 10.8}cqw`;
  $('lyric-next').style.fontSize = `${+fields.fontSize.value * .7 / 10.8}cqw`;
}

$('search-form').addEventListener('submit', async event => {
  event.preventDefault();
  if(automaticMode)return runAutomatic();
  if(vkEnabled)void searchVK();
  searchController?.abort(); searchController = new AbortController();
  const status = $('search-status'); status.hidden = false; status.classList.remove('error'); status.textContent = 'Ищем твою песню…';
  const button = $('search-button'); button.disabled = true; $('search-results').replaceChildren();
  try {
    const params = new URLSearchParams({ title:fields.title.value, artist:fields.artist.value });
    const data = await api(`/api/search?${params}`, { signal: searchController.signal });
    status.textContent = data.songs.length ? `Нашли ${data.songs.length}. Выбери подходящую версию:` : 'Песню не нашли. Попробуй другое название или вставь текст вручную.';
    for (const song of data.songs) {
      const result = el('button', 'song-result'); result.type = 'button';
      const text = el('span'); text.append(el('strong', '', song.title), el('small', '', `${song.artist} · ${time(song.duration)}${song.album ? ` · ${song.album}` : ''}`));
      result.append(text, el('span', 'result-badge', song.syncedLyrics ? 'Текст + таймкоды' : song.plainLyrics ? 'Текст песни' : 'Без текста'));
      if (!song.syncedLyrics && !song.plainLyrics) { result.disabled = true; result.title = 'У этой версии нет текста'; }
      result.addEventListener('click', () => {
        fields.title.value = song.title; fields.artist.value = song.artist;
        fields.lyrics.value = song.syncedLyrics || song.plainLyrics;
        fields.offset.value = 0;
        updateLines(); invalidateExport();
        $('lyrics-caption').textContent = `Текст найден · ${song.artist}`;
        status.textContent = 'Текст добавлен. Теперь загрузи аудио этой версии песни.';
        $('search-results').replaceChildren(); toast('Текст добавлен. Загрузи аудио, чтобы продолжить.');
      });
      $('search-results').append(result);
    }
  } catch (error) {
    if (error.name !== 'AbortError') { status.textContent = error.message; status.classList.add('error'); }
  } finally { button.disabled = false; }
});

function setMode(automatic){
  if(state.rendering)return toast('Дождись завершения текущего видео.');
  automaticMode=automatic;document.body.classList.toggle('automatic-mode',automatic);
  $('automatic-panel').hidden=!automatic;
  for(const [id,selected] of [['automatic-mode',automatic],['manual-mode',!automatic]]){$(id).classList.toggle('selected',selected);$(id).setAttribute('aria-pressed',String(selected));}
  const label=[...$('search-button').childNodes].find(n=>n.nodeType===Node.TEXT_NODE&&n.textContent.trim());
  if(label)label.textContent=automatic?'Создать караоке автоматически':'Найти текст песни';
  $('song-artist').required=automatic;
  if(!automatic){$('automatic-video').hidden=true;$('phone-preview').hidden=false;}
  else if($('automatic-video').getAttribute('src')){$('automatic-video').hidden=false;$('phone-preview').hidden=true;}
}
$('automatic-mode').addEventListener('click',()=>setMode(true));
$('manual-mode').addEventListener('click',()=>setMode(false));
async function runAutomatic(){
  if(state.rendering||state.uploading)return toast('Дождись завершения текущей операции.');
  const title=fields.title.value.trim(),artist=fields.artist.value.trim();
  if(!title||!artist)return toast('Укажи название песни и исполнителя.');
  stopWaiting=false;state.rendering=true;state.automaticResult=null;$('search-button').disabled=true;$('automatic-task').hidden=true;$('automatic-cancel').hidden=false;
  const status=$('automatic-status'),progress=$('automatic-progress');
  status.hidden=false;status.classList.remove('error');status.textContent='Запускаем автоматическое создание…';
  progress.hidden=false;progress.value=0;$('automatic-result').hidden=true;
  $('automatic-video').pause();$('automatic-video').hidden=true;$('phone-preview').hidden=false;audio.pause();
  const steps=['search','lyrics','separating','video'];
  try{
    let job=await post('/api/auto',{title,artist,theme:state.theme,fontSize:+fields.fontSize.value});
    while(job.status==='processing'){
      if(stopWaiting)throw new Error('Ожидание прекращено. Если запрос уже отправлен, обработка продолжится; результат будет в задаче GitHub.');
      status.textContent=job.message||'Обрабатываем песню…';progress.value=job.progress||0;
      const taskURL=job.confirmUrl||job.taskUrl;
      if(taskURL){$('automatic-task').hidden=false;$('automatic-task-link').href=taskURL;$('automatic-task-link').textContent=job.confirmUrl?'Подтвердить запрос в GitHub':'Открыть задачу в GitHub';}
      const index=steps.indexOf(job.step);
      document.querySelectorAll('.automatic-steps li').forEach((item,i)=>{item.classList.toggle('active',i===index);item.classList.toggle('done',i<index);});
      await new Promise(resolve=>setTimeout(resolve,1500));
      job=await api(`/api/auto/jobs/${job.id}`);
    }
    if(job.status!=='done')throw new Error(job.error||'Не удалось завершить создание.');
    showAutomaticResult(job);
    toast('Полное караоке готово. Можно скачать видео, минус и текст.');
  }catch(error){status.textContent=error.message;status.classList.add('error');progress.hidden=true;}
  finally{state.rendering=false;$('search-button').disabled=false;$('automatic-cancel').hidden=true;}
}
$('automatic-cancel').addEventListener('click',()=>{stopWaiting=true;});
function showAutomaticResult(job){
  state.automaticResult=job;
  $('automatic-task').hidden=!job.taskUrl;
  if(job.taskUrl){$('automatic-task-link').href=job.taskUrl;$('automatic-task-link').textContent='Открыть задачу в GitHub';}
  $('automatic-progress').hidden=false;$('automatic-progress').value=100;$('automatic-status').hidden=false;
  $('automatic-status').classList.remove('error');$('automatic-status').textContent=`Готово: ${job.artist} — ${job.title}`;
  document.querySelectorAll('.automatic-steps li').forEach(item=>{item.classList.remove('active');item.classList.add('done');});
  for(const [id,key] of [['automatic-download','downloadUrl'],['automatic-minus','minusUrl'],['automatic-lyrics','lyricsUrl']]){$(id).href=job[key];$(id).setAttribute('download','');}
  $('automatic-warning').textContent=job.warning||'';$('automatic-warning').hidden=!job.warning;
  $('automatic-result').hidden=false;$('automatic-video').src=job.downloadUrl;$('automatic-video').hidden=!automaticMode;$('phone-preview').hidden=automaticMode;
}
api('/api/auto/status').then(status=>{$('automatic-availability').classList.toggle('unavailable',!status.ready);$('automatic-availability').textContent=status.notice||(status.ready?(status.sourceVerified?'Обработчик доступен. Поиск музыки — без API-ключа.':'Обработчик подготовлен. Доступность записи проверится при поиске; API-ключ не нужен.'):status.reason||'Автоматическая обработка пока недоступна.');}).catch(()=>{$('automatic-availability').classList.add('unavailable');$('automatic-availability').textContent='Сервер обработки сейчас недоступен.';});

async function searchVK() {
  if (vkSearching) return;
  if (!fields.title.value.trim()) return toast('Укажи название песни для поиска в VK.');
  vkSearching = true;
  const status = $('vk-status'), button = $('vk-search-button');
  button.disabled = true; status.hidden = false; status.classList.remove('error');
  status.textContent = 'Ищем оригинал и версии «минус» в VK Музыке…';
  $('vk-results').replaceChildren();
  try {
    const params = new URLSearchParams({title:fields.title.value,artist:fields.artist.value});
    const data = await api(`/api/vk/search?${params}`);
    $('vk-connection').textContent = 'Аудиопоиск подключён';
    for (const kind of ['minus','plus']) {
      const songs = data[kind] || [];
      if (!songs.length) continue;
      $('vk-results').append(el('div','vk-results-label',kind === 'minus' ? 'По запросу «минус» · проверь версию после загрузки' : 'Оригинальные записи'));
      for (const song of songs) {
        const result = el('button','song-result'); result.type = 'button';
        const text = el('span'); text.append(el('strong','',song.title),el('small','',`${song.artist} · ${time(song.duration)}`));
        result.append(text,el('span','result-badge',kind === 'minus' ? '+ Минус' : '+ Оригинал'));
        result.addEventListener('click',async () => {
          if (state.uploading || state.rendering) return toast('Дождись завершения текущей операции.');
          state.uploading++; result.disabled = true; const original = result.querySelector('.result-badge').textContent;
          result.querySelector('.result-badge').textContent = 'Загружаем…';
          try {
            const track = await post('/api/vk/import',{id:song.id});
            showTrack(kind,track); fields.source.value = kind; updateAudio(); invalidateExport();
            result.querySelector('.result-badge').textContent = 'Добавлено ✓';
            toast('Полный аудиофайл из VK добавлен. Проверь, совпадает ли версия с текстом.');
          } catch (error) { result.querySelector('.result-badge').textContent = original; toast(error.message); }
          finally { state.uploading--; result.disabled = false; }
        });
        $('vk-results').append(result);
      }
    }
    status.textContent = data.minus?.length || data.plus?.length ? 'Выбери подходящие записи. Поиск «минус» не гарантирует, что в версии нет вокала.' : 'Записи не найдены. Уточни запрос или загрузи свои файлы.';
  } catch (error) { status.textContent = error.message; status.classList.add('error'); }
  finally { vkSearching = false; button.disabled = false; }
}
$('vk-search-button').addEventListener('click',searchVK);
api('/api/vk/status').then(status => {vkEnabled=status.configured;document.querySelector('.vk-source').hidden=!vkEnabled;document.querySelector('.upload-divider').hidden=!vkEnabled; $('vk-connection').textContent=status.configured?'Дополнительный источник подключён':'Не подключено';}).catch(() => {document.querySelector('.vk-source').hidden=true;document.querySelector('.upload-divider').hidden=true;});

async function upload(kind, file) {
  if (!file) return;
  if (file.size > 100 * 1024 * 1024) return toast('Файл должен быть не больше 100 МБ.');
  state.uploading++;
  $(`${kind}-description`).textContent = 'Загружаем и проверяем…';
  $(`${kind}-file`).disabled = true;
  try {
    const track = await api(`/api/upload?name=${encodeURIComponent(file.name)}`, { method:'POST', headers:{'Content-Type':'application/octet-stream'}, body:file });
    showTrack(kind, track); fields.source.value = kind; updateAudio(); invalidateExport(); toast('Аудио готово. Можно проверить тайминги в плеере.');
  } catch (error) { showTrack(kind, state[kind]); toast(error.message); }
  finally { state.uploading--; $(`${kind}-file`).disabled = false; }
}
for (const kind of ['minus', 'plus']) {
  $(`${kind}-file`).addEventListener('change', e => { upload(kind, e.target.files[0]); e.target.value = ''; });
  const zone = $(`${kind}-zone`);
  zone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $(`${kind}-file`).click(); } });
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragging'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragging'));
  zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('dragging'); if (!state.uploading) upload(kind, e.dataTransfer.files[0]); });
}
$('lyrics-file').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  try {
    if (file.size > 100000) throw new Error('Текстовый файл слишком большой. Максимум 100 КБ.');
    const text = await file.text();
    if (text.length > 30000) throw new Error('Максимум 30 000 символов текста.');
    fields.lyrics.value = text; updateLines(); invalidateExport(); toast('Текст загружен. Проверь таймкоды и кодировку.');
  } catch (error) { toast(error.message); }
  event.target.value = '';
});
['title', 'artist', 'lyrics', 'offset'].forEach(key => fields[key].addEventListener('input', () => { updateLines(); invalidateExport(); }));
fields.source.addEventListener('change', () => { updateAudio(); invalidateExport(); });
fields.fontSize.addEventListener('change', () => { updateFont(); invalidateExport(); });
document.querySelectorAll('.theme-option').forEach(button => button.addEventListener('click', () => selectTheme(button.dataset.theme)));
$('make-timings').addEventListener('click', () => {
  const track = selectedAudio();
  if (!track) return toast('Сначала загрузи аудио — нужна длительность песни.');
  try {
    const lines = parseLyrics(fields.lyrics.value, track.duration, 0);
    fields.lyrics.value = lines.map(line => {
      const cs = Math.round(line.start * 100);
      return `[${String(Math.floor(cs / 6000)).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}]${line.text}`;
    }).join('\n');
    updateLines(); invalidateExport(); toast('Таймкоды добавлены. Отредактируй их по записи для точного совпадения.');
  } catch (error) { toast(error.message); }
});

$('play-button').addEventListener('click', async () => {
  if (!selectedAudio()) return;
  try { if (audio.paused) await audio.play(); else audio.pause(); }
  catch { toast('Аудио недоступно. Загрузите файл ещё раз.'); }
});
audio.addEventListener('play', () => { $('play-button').setAttribute('aria-label', 'Пауза'); $('play-button').querySelector('use').setAttribute('href', '#i-pause'); $('sound-bars').classList.add('playing'); });
audio.addEventListener('pause', () => { $('play-button').setAttribute('aria-label', 'Воспроизвести'); $('play-button').querySelector('use').setAttribute('href', '#i-play'); $('sound-bars').classList.remove('playing'); });
audio.addEventListener('timeupdate', updatePreview);
audio.addEventListener('seeked', updatePreview);
audio.addEventListener('error', () => { if (audio.getAttribute('src')) toast('Аудиофайл не найден или не поддерживается браузером. Можно загрузить его заново; сервер также принимает FLAC.'); });
$('seek').addEventListener('input', e => { audio.currentTime = +e.target.value; updatePreview(); });
for (let i = 0; i < 35; i++) {
  const bar = el('i'); bar.style.setProperty('--height', `${5 + Math.sin(i * 1.7) ** 2 * 17}px`); bar.style.setProperty('--delay', `${i * -.08}s`); $('sound-bars').append(bar);
}

$('load-demo').addEventListener('click', async () => {
  if (state.uploading || state.rendering) return toast('Дождись завершения текущей операции.');
  if ((fields.lyrics.value || selectedAudio() || state.automaticResult) && !confirm('Заменить текущий проект демонстрационным?')) return;
  setMode(false);
  const button = $('load-demo'); button.disabled = true;
  try {
    const demo = await post('/api/demo', {});
    fields.title.value = demo.title; fields.artist.value = demo.artist; fields.lyrics.value = demo.lyrics;
    fields.source.value = 'minus'; fields.offset.value = 0; state.projectId = null;
    showTrack('minus', demo); showTrack('plus', null); updateAudio(); invalidateExport();
    toast('Демо готово: авторский текст и синтезированный аккорд, 32 секунды.');
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
});

$('render-button').addEventListener('click', async () => {
  if (state.uploading) return toast('Дождись окончания загрузки аудио.');
  if (state.rendering) return;
  const track = selectedAudio();
  if (!track) return toast('Загрузи аудио и выбери источник звука для видео.');
  if (!fields.title.value.trim()) { fields.title.focus(); return toast('Укажи название песни.'); }
  try {
    const lines = parseLyrics(fields.lyrics.value, track.duration, fields.offset.value);
    if (!lines.length) throw new Error('Таймкоды находятся за пределами аудио. Проверь текст и сдвиг.');
  } catch (error) { return toast(error.message); }
  state.rendering = true; audio.pause();
  const button = $('render-button'), status = $('render-status'), progress = $('render-progress');
  button.disabled = true; status.hidden = false; status.classList.remove('error'); progress.hidden = false; progress.value = 0; $('download-link').hidden = true;
  status.textContent = 'Подготавливаем полное караоке-видео…';
  try {
    let job = await post('/api/render', { audioId: track.id, lyrics: fields.lyrics.value, title:fields.title.value.trim(), artist:fields.artist.value.trim(), offset:+fields.offset.value, theme:state.theme, fontSize:+fields.fontSize.value, vocalMode:fields.source.value === 'reduce' ? 'reduce' : 'original' });
    while (job.status === 'rendering') {
      progress.value = job.progress;
      status.textContent = `Создаём видео · ${job.progress}% · весь трек ${time(track.duration)}. ${staticMode?'Не сворачивай и не закрывай вкладку: запись идёт в реальном времени.':'Можно оставить вкладку открытой.'}`;
      await new Promise(resolve => setTimeout(resolve, 1000));
      job = await api(`/api/jobs/${job.id}`);
    }
    if (job.status !== 'done') throw new Error(job.error || 'Не удалось создать видео.');
    progress.value = 100; status.textContent = 'Готово! Полная песня, текст и подсветка — в одном видео.';
    const format=job.extension||'mp4';
    $('download-link').href = job.downloadUrl; $('download-link').download = `karaoke-1080x1920.${format}`; $('download-link').hidden = false;
    $('download-link').lastChild.textContent=`Скачать караоке · ${job.label||'MP4'}`;
    toast('Твоё караоке готово к скачиванию.');
  } catch (error) { status.textContent = error.message; status.classList.add('error'); progress.hidden = true; }
  finally { state.rendering = false; button.disabled = false; }
});

function getProjects() { try { const projects = JSON.parse(localStorage.getItem('karaoke-projects') || '[]'); return Array.isArray(projects) ? projects : []; } catch { return []; } }
function refreshProjectCount() { $('project-count').textContent = getProjects().length; }
function storeProjects(projects) { localStorage.setItem('karaoke-projects', JSON.stringify(projects)); refreshProjectCount(); }
$('save-project').addEventListener('click', () => {
  if(state.rendering||state.uploading)return toast('Дождись завершения текущей операции.');
  if (!fields.title.value.trim()) return toast('Сначала укажи название проекта.');
  state.projectId ||= crypto.randomUUID();
  const project = { id:state.projectId, savedAt:Date.now(), title:fields.title.value, artist:fields.artist.value, lyrics:fields.lyrics.value, offset:fields.offset.value, fontSize:fields.fontSize.value, source:fields.source.value, theme:state.theme, minus:state.minus, plus:state.plus,mode:automaticMode?'automatic':'manual',result:automaticMode?state.automaticResult:null };
  try { storeProjects([project, ...getProjects().filter(p => p.id !== project.id)].slice(0, 30)); toast('Проект сохранён в этом браузере.'); }
  catch { toast('Не удалось сохранить: хранилище браузера недоступно или заполнено.'); }
});
function loadProject(project) {
  if (state.rendering || state.uploading) return toast('Дождись завершения текущей операции.');
  setMode(project.mode==='automatic');
  audio.pause();
  for (const key of ['title', 'artist', 'lyrics', 'offset', 'fontSize', 'source']) fields[key].value = project[key] ?? '';
  state.projectId = project.id; showTrack('minus', project.minus); showTrack('plus', project.plus);
  selectTheme(project.theme); updateFont(); updateAudio(); invalidateExport();
  $('automatic-result').hidden=true;$('automatic-status').hidden=true;$('automatic-progress').hidden=true;
  $('automatic-video').pause();$('automatic-video').removeAttribute('src');$('automatic-video').hidden=true;$('phone-preview').hidden=false;
  if(project.mode==='automatic'&&project.result)showAutomaticResult(project.result);
  $('projects-dialog').close(); toast(staticMode?'Проект открыт. Аудио хранится в этом браузере.':'Проект открыт. Если сервер менялся, загрузи аудио заново.');
}
function renderProjects() {
  const list = $('projects-list'); list.replaceChildren();
  const projects = getProjects();
  if (!projects.length) list.append(el('p', 'empty-projects', 'Пока пусто. Сохрани свой первый проект в редакторе.'));
  for (const project of projects) {
    const row = el('div', 'project-row'), open = el('button');
    open.append(el('strong', '', project.title), el('small', '', `${project.artist || 'Без исполнителя'} · ${new Date(project.savedAt).toLocaleDateString('ru-RU')}`));
    open.addEventListener('click', () => loadProject(project));
    const remove = el('button', 'delete-project', 'Удалить');
    remove.addEventListener('click', () => { try { storeProjects(getProjects().filter(p => p.id !== project.id)); renderProjects(); } catch { toast('Не удалось удалить проект.'); } });
    row.append(open, remove); list.append(row);
  }
}
$('open-projects').addEventListener('click', () => { renderProjects(); $('projects-dialog').showModal(); });
$('new-project').addEventListener('click', () => {
  if (state.rendering || state.uploading) return toast('Дождись завершения текущей операции.');
  if ((fields.lyrics.value || selectedAudio() || state.automaticResult) && !confirm('Создать новый проект? Несохранённые изменения будут потеряны.')) return;
  audio.pause(); state.projectId = null;
  fields.title.value = ''; fields.artist.value = ''; fields.lyrics.value = ''; fields.offset.value = 0; fields.source.value = 'minus'; fields.fontSize.value = '64';
  showTrack('minus', null); showTrack('plus', null); selectTheme('violet'); updateFont(); updateAudio(); invalidateExport();
  $('search-status').hidden = true; $('search-results').replaceChildren(); $('lyrics-caption').textContent = 'Вставь текст или загрузи файл с таймкодами'; fields.title.focus();
  $('vk-status').hidden = true; $('vk-results').replaceChildren();
  state.automaticResult=null;$('automatic-result').hidden=true;$('automatic-status').hidden=true;$('automatic-progress').hidden=true;
  $('automatic-video').pause();$('automatic-video').removeAttribute('src');$('automatic-video').hidden=true;$('phone-preview').hidden=false;setMode(true);
});
$('help-button').addEventListener('click', () => $('help-dialog').showModal());
document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => { button.closest('details').open = false; $(button.dataset.action).click(); }));
document.querySelectorAll('.close-dialog').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close(); } }));
window.addEventListener('beforeunload', event => { if (state.rendering || state.uploading) { event.preventDefault(); event.returnValue = ''; } });

if(staticMode){
  document.querySelector('.local-badge').lastChild.textContent='Браузерная студия';
  document.querySelector('.export-info span').textContent=`${videoFormat.label} · 1080 × 1920 · до 30 fps · полная длина трека`;
  $('download-link').lastChild.textContent=`Скачать караоке · ${videoFormat.label}`;
  const note=el('p','quiet-note','Аудио остаётся в твоём браузере. Запись видео идёт в реальном времени — не закрывай и не сворачивай вкладку. Формат зависит от браузера.');
  document.querySelector('.export-panel').append(note);
  $('projects-dialog').querySelector('.dialog-note').textContent='Текст, настройки и аудиофайлы сохраняются только в этом браузере.';
  $('help-dialog').querySelector('.help-steps li:last-child').textContent=`Скачай видео. Браузер запишет всю песню в ${videoFormat.label}. Запись занимает столько же времени, сколько длится трек. Не сворачивай вкладку.`;
  $('help-dialog').querySelector('.dialog-note').textContent='На этой странице аудио хранится и обрабатывается в браузере. Для импорта из VK и серверного экспорта MP4 нужна серверная версия приложения.';
}
setMode(true);refreshProjectCount(); updateAudio(); updateFont();
