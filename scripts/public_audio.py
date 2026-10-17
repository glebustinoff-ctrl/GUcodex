"""Search public YouTube audio with yt-dlp. No API keys, cookies or login."""
import argparse
import json
from pathlib import Path
import re
import shutil
import sys
import unicodedata


def clean(value):
    value = unicodedata.normalize('NFKC', str(value or '')).lower().replace('ё', 'е')
    return ' '.join(re.sub(r'[^\w]+', ' ', value, flags=re.UNICODE).split())


def rank_candidate(item, title, artist):
    """Reject covers and unrelated results; prefer music metadata and official audio."""
    title_key, artist_key = clean(title), clean(artist)
    video_title = clean(item.get('title'))
    context = clean(' '.join(str(item.get(k) or '') for k in ('title', 'uploader', 'channel', 'artist')))
    artists = item.get('artists') or []
    if isinstance(artists, list):
        context += ' ' + clean(' '.join(str(a) for a in artists))
    if not title_key or not artist_key or f' {title_key} ' not in f' {video_title} ':
        return -1
    if f' {artist_key} ' not in f' {context} ':
        return -1
    requested = clean(title + ' ' + artist)
    for word in ('cover', 'кавер', 'karaoke', 'караоке', 'instrumental', 'минус', 'remix', 'ремикс', 'live', 'концерт', 'sped', 'slowed', 'reaction', 'реакция'):
        if word in context.split() and word not in requested.split():
            return -1
    if item.get('is_live') or item.get('live_status') in ('is_live', 'is_upcoming', 'post_live'):
        return -1
    duration = item.get('duration')
    if duration is not None and not 45 <= float(duration) <= 1200:
        return -1
    if item.get('availability') in ('private', 'premium_only', 'subscriber_only', 'needs_auth'):
        return -1
    score = 10
    if video_title == title_key:
        score += 6
    if clean(item.get('track')) == title_key:
        score += 10
    if 'topic' in context.split() or 'official' in context.split() or 'официальное' in context.split():
        score += 4
    if 'audio' in context.split():
        score += 2
    return score


class QuietLogger:
    def debug(self, message):
        pass
    def warning(self, message):
        pass
    def error(self, message):
        pass


def acquire(title, artist, directory):
    import yt_dlp
    from yt_dlp.utils import DownloadError
    folder = Path(directory).resolve() / 'public-source'
    folder.mkdir(parents=True, exist_ok=True)
    max_bytes = 100 * 1024 * 1024

    def limit(data):
        if data.get('downloaded_bytes', 0) > max_bytes:
            raise DownloadError('File size limit exceeded')

    options = {
        'quiet': True, 'no_warnings': True, 'logger': QuietLogger(),
        'cachedir': False, 'noplaylist': True, 'socket_timeout': 20,
        'retries': 1, 'extractor_retries': 1, 'geo_bypass': False,
        'usenetrc': False, 'nocheckcertificate': False,
        'js_runtimes': {'node': {'path': shutil.which('node')}},
    }
    with yt_dlp.YoutubeDL({**options, 'extract_flat': 'in_playlist', 'skip_download': True}) as ydl:
        results = ydl.extract_info(f'ytsearch10:{artist} {title} official audio', download=False)
    candidates = list((results or {}).get('entries') or [])
    ranked = sorted(((rank_candidate(item, title, artist), item) for item in candidates if item), key=lambda pair: pair[0], reverse=True)
    failures = 0
    for score, candidate in ranked[:5]:
        if score < 0:
            continue
        video_id = candidate.get('id') or ''
        if not re.fullmatch(r'[A-Za-z0-9_-]{11}', video_id):
            continue
        try:
            with yt_dlp.YoutubeDL({**options, 'format': 'bestaudio/best', 'skip_download': True}) as ydl:
                info = ydl.extract_info(f'https://www.youtube.com/watch?v={video_id}', download=False)
            if rank_candidate(info, title, artist) < 0 or info.get('duration') is None:
                continue
            with yt_dlp.YoutubeDL({**options, 'format': 'bestaudio/best', 'outtmpl': str(folder / '%(id)s.%(ext)s'),
                                  'max_filesize': max_bytes, 'progress_hooks': [limit], 'continuedl': False,
                                  'overwrites': False}) as ydl:
                downloaded = ydl.extract_info(f'https://www.youtube.com/watch?v={video_id}', download=True)
                file = Path(ydl.prepare_filename(downloaded)).resolve()
            if not file.is_file() or not 0 < file.stat().st_size <= max_bytes:
                continue
            return {'ok': True, 'id': video_id, 'path': str(file), 'webpage_url': f'https://www.youtube.com/watch?v={video_id}'}
        except DownloadError:
            failures += 1
    return {'ok': False, 'error': 'Не найдена доступная полная запись с совпадающими названием и исполнителем.' if not failures else 'Источник не выдал доступный аудиофайл без входа. Попробуй другую песню.'}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['probe', 'acquire'])
    parser.add_argument('--title')
    parser.add_argument('--artist')
    parser.add_argument('--directory')
    args = parser.parse_args()
    if args.action == 'probe':
        import yt_dlp.version
        import yt_dlp_ejs
        print(json.dumps({'ready': bool(shutil.which('node')), 'version': yt_dlp.version.__version__}))
        return
    if not args.title or not args.artist or not args.directory:
        parser.error('title, artist and directory are required')
    try:
        result = acquire(args.title, args.artist, args.directory)
    except Exception:
        # Do not expose signed media URLs or large extractor traces to the browser.
        result = {'ok': False, 'error': 'Публичный источник недоступен. Проверь сетевой доступ к YouTube; ключ API не требуется.'}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
