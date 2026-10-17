export function parseLyrics(input, duration, offset = 0) {
  const rows = String(input).trim().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!rows.length) throw new Error('Добавьте текст песни.');
  if (rows.length > 400 || input.length > 30000) throw new Error('Текст слишком длинный.');
  const parsed = [];
  let timed = 0;
  for (const row of rows) {
    if (/^\[(ar|al|ti|by|offset|length):/i.test(row)) continue;
    const tags = [...row.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    const text = row.replace(/\[[^\]]*\]/g, '').trim();
    if (!text && !tags.length) continue;
    if (text.length > 200) throw new Error('Разбейте длинные строки текста: максимум 200 символов в строке.');
    if (tags.length) {
      for (const tag of tags) {
        if (+tag[2] >= 60) throw new Error('Некорректное время в LRC.');
        parsed.push({ start: +tag[1] * 60 + +tag[2] + +(tag[3] || 0) / (10 ** (tag[3]?.length || 0)), text });
        timed++;
      }
    } else parsed.push({ start: null, text });
  }
  if (!parsed.some(row => row.text)) throw new Error('В тексте не найдены строки песни.');
  if (timed && parsed.some(row => row.start === null)) throw new Error('Укажите время для всех строк или удалите все таймкоды.');
  const shift = Number(offset);
  if (!Number.isFinite(shift) || Math.abs(shift) > 60) throw new Error('Сдвиг должен быть от −60 до 60 секунд.');
  if (!timed) parsed.forEach((row, i) => { row.start = i * duration / parsed.length; });
  parsed.sort((a, b) => a.start - b.start);
  return parsed.map((row, i) => ({
    text: row.text,
    start: Math.max(0, row.start + shift),
    end: Math.min(duration, Math.max(0, (parsed[i + 1]?.start ?? duration) + shift)),
  })).filter(row => row.text && row.start < duration && row.end > row.start);
}

