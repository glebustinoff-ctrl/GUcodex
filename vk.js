// VK audio methods require an application/token explicitly permitted to use them.
// Never log API responses: VK error payloads may echo request credentials.
export class VKError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}
const defaultMediaHost = host => host.endsWith('.vkuseraudio.net') || host.endsWith('.userapi.com');

export class VKMusic {
  constructor({ token = process.env.VK_AUDIO_ACCESS_TOKEN, fetchImpl = fetch, mediaHostAllowed = defaultMediaHost } = {}) {
    this.token = token;
    this.fetch = fetchImpl;
    this.mediaHostAllowed = mediaHostAllowed;
  }
  get configured() { return !!this.token; }
  async method(method, params) {
    if (!this.configured) throw new VKError('VK Музыка ещё не подключена. Нужен VK_AUDIO_ACCESS_TOKEN приложения с доступом к аудиометодам. Добавьте его в секреты среды; пароль от VK не нужен. Обычный пользовательский токен может не иметь нужного доступа.', 424);
    const form = new URLSearchParams({ ...params, access_token:this.token, v:'5.199' });
    let response;
    try { response = await this.fetch(`https://api.vk.com/method/${method}`, { method:'POST', body:form, redirect:'error', signal:AbortSignal.timeout(20000) }); }
    catch { throw new VKError('Нет соединения с API VK. Проверьте разрешение api.vk.com в сетевых настройках среды.'); }
    if (!response.ok) throw new VKError(`API VK вернул HTTP ${response.status}.`);
    let data;
    try { data = await response.json(); } catch { throw new VKError('API VK вернул некорректный ответ.'); }
    if (data.error) {
      const code = +data.error.error_code;
      if ([5,27,28].includes(code)) throw new VKError('VK отклонил авторизацию. Проверьте срок действия и тип VK_AUDIO_ACCESS_TOKEN в секретах среды.', 424);
      if ([7,15,20,21,23,24].includes(code)) throw new VKError('VK не разрешил этому приложению использовать аудио API. Нужен официальный доступ VK к аудиометодам; одной подписки на VK Музыку недостаточно.', 424);
      if (code === 6) throw new VKError('Лимит запросов VK. Попробуйте немного позже.', 429);
      throw new VKError(`VK не выполнил аудиозапрос (код ${code || 'неизвестен'}).`);
    }
    if (data.response === undefined) throw new VKError('В ответе VK нет результатов.');
    return data.response;
  }
  async search(title, artist) {
    const query = `${artist} ${title}`.trim();
    const normalize = data => (Array.isArray(data.items) ? data.items : []).filter(item => Number.isInteger(item.id) && Number.isInteger(item.owner_id)).slice(0,6).map(item => ({
      id:`${item.owner_id}_${item.id}`,title:item.title || 'Без названия',artist:item.artist || '',duration:Number(item.duration) || 0,
    }));
    // Sequential requests avoid immediately exhausting VK's per-token request limit.
    const plus = normalize(await this.method('audio.search',{q:query,count:'6',auto_complete:'0'}));
    const minus = normalize(await this.method('audio.search',{q:`${query} минус`,count:'6',auto_complete:'0'}));
    return { plus, minus };
  }
  validateMediaURL(value) {
    let url;
    try { url = new URL(value); } catch { throw new VKError('VK не предоставил адрес аудиофайла.'); }
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !this.mediaHostAllowed(url.hostname)) throw new VKError('VK вернул адрес вне поддерживаемых аудиосерверов. Нужна отдельная проверка источника.');
    if (/\.m3u8(?:$|\?)/i.test(url.pathname)) throw new VKError('VK вернул поток HLS вместо доступного файла. Этот тип выдачи пока не поддерживается.');
    return url;
  }
  async getFile(id) {
    if (!/^-?\d+_\d+$/.test(id || '')) throw new VKError('Некорректный идентификатор трека VK.',400);
    const items = await this.method('audio.getById',{audios:id});
    const track = Array.isArray(items) ? items[0] : items.items?.[0];
    if (!track?.url) throw new VKError('VK не выдал полный аудиофайл. Проверьте права приложения и доступность этой записи.',424);
    let url = this.validateMediaURL(track.url);
    for (let redirect = 0; redirect < 4; redirect++) {
      let response;
      try { response = await this.fetch(url, { redirect:'manual', signal:AbortSignal.timeout(120000) }); }
      catch { throw new VKError('Не удалось получить аудио с сервера VK. Проверьте сетевой доступ к аудиодоменам VK.'); }
      if ([301,302,303,307,308].includes(response.status)) {
        await response.body?.cancel();
        url = this.validateMediaURL(new URL(response.headers.get('location'),url).href);
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new VKError(`Аудиосервер VK вернул HTTP ${response.status}.`); }
      if (/mpegurl|text\/html|application\/json/i.test(response.headers.get('content-type') || '')) { await response.body?.cancel(); throw new VKError('VK вернул поток или страницу вместо аудиофайла.'); }
      return { response, name:`${String(track.artist || '').slice(0,100)} — ${String(track.title || 'VK audio').slice(0,100)}.mp3` };
    }
    throw new VKError('Слишком много перенаправлений аудиофайла VK.');
  }
}
