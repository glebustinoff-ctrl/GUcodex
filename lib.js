import { deflateSync } from 'node:zlib';

export const THEMES = {
  violet: { name: 'Полночь', base: [14, 12, 35], glow: [106, 49, 161], accent: '&H00F6B7DF' },
  ocean: { name: 'Океан', base: [5, 23, 34], glow: [18, 110, 125], accent: '&H00DAE5A1' },
  sunset: { name: 'Закат', base: [36, 16, 29], glow: [167, 64, 74], accent: '&H008DB6FF' },
};

export { parseLyrics } from './public/timing.js';

const assTime = t => {
  const cs = Math.max(0, Math.round(t * 100));
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};
export const assEscape = text => String(text).replace(/[{}\\]/g, '').replace(/\r?\n/g, ' ').slice(0, 200);

export function createASS({ title, artist, lines, duration, theme = 'violet', fontSize = 64 }) {
  const size = [52, 64, 76].includes(+fontSize) ? +fontSize : 64;
  const accent = THEMES[theme]?.accent ?? THEMES.violet.accent;
  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Lyric,DejaVu Sans,${size},${accent},&H00FFFFFF,&H001C1028,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,5,100,100,0,1\nStyle: Next,DejaVu Sans,${Math.round(size * .7)},&H009E91A8,&H009E91A8,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,110,110,0,1\nStyle: Small,DejaVu Sans,25,&H00B7A2C9,&H00B7A2C9,&H00000000,&H00000000,0,0,0,0,100,100,4,0,1,0,0,8,70,70,0,1\nStyle: Title,DejaVu Sans,48,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,8,70,70,0,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const event = (start, end, style, text) => `Dialogue: 0,${assTime(start)},${assTime(end)},${style},,0,0,0,,${text}\n`;
  let output = header;
  output += event(0, duration, 'Small', '{\\pos(540,140)}K A R A O K E  S T U D I O');
  output += event(0, duration, 'Title', `{\\pos(540,305)}${assEscape(title || 'Без названия')}`);
  output += event(0, duration, 'Next', `{\\pos(540,410)}${assEscape(artist || 'Неизвестный исполнитель')}`);
  output += event(0, duration, 'Small', '{\\pos(540,1725)}ПОЙ В СВОЁМ РИТМЕ');
  lines.forEach((line, index) => {
    const words = assEscape(line.text).split(/\s+/);
    const total = words.reduce((n, word) => n + word.length, 0);
    const length = Math.max(1, Math.round((line.end - line.start) * 100));
    let used = 0;
    const karaoke = words.map((word, i) => {
      const cs = i === words.length - 1 ? length - used : Math.floor(length * word.length / total);
      used += cs;
      return `{\\kf${cs}}${word}`;
    }).join(' ');
    output += event(line.start, line.end, 'Lyric', `{\\pos(540,940)\\fad(100,100)}${karaoke}`);
    if (lines[index + 1]) output += event(line.start, line.end, 'Next', `{\\pos(540,1140)}${assEscape(lines[index + 1].text)}`);
  });
  return output;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type);
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  name.copy(result, 4); data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
  return result;
}
const backgrounds = new Map();
export function background(theme = 'violet') {
  if (backgrounds.has(theme)) return backgrounds.get(theme);
  const { base, glow } = THEMES[theme] || THEMES.violet;
  const w = 1080, h = 1920;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = Math.exp(-(((x / w - .85) ** 2) / .2 + ((y / h - .46) ** 2) / .12));
    const d2 = Math.exp(-(((x / w - .1) ** 2) / .4 + ((y / h - .9) ** 2) / .07)) * .25;
    for (let c = 0; c < 3; c++) raw[y * (w * 3 + 1) + 1 + x * 3 + c] = Math.min(255, Math.round(base[c] + glow[c] * (d * .6 + d2)));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const result = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  backgrounds.set(theme, result);
  return result;
}
