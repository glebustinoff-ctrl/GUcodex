export const REQUEST_MARKER='KARAOKE_REQUEST_V1';
export const RESULT_MARKER='KARAOKE_RESULT_V1';
export function validateRequest(value){
  if(!value||!/^[a-f0-9-]{36}$/i.test(value.id||''))throw new Error('Некорректный номер запроса.');
  const result={id:value.id};
  for(const key of ['title','artist']){
    if(typeof value[key]!=='string'||!value[key].trim()||value[key].length>120||/[\x00-\x1f]/.test(value[key]))throw new Error('Укажи название и исполнителя: до 120 символов в каждом поле.');
    result[key]=value[key].trim();
  }
  result.theme=['violet','ocean','sunset'].includes(value.theme)?value.theme:'violet';
  result.fontSize=[52,64,76].includes(value.fontSize)?value.fontSize:64;
  return result;
}
export function encodeMessage(marker,value){return `${marker}\n\n\`\`\`json\n${JSON.stringify(value,null,2).replace(/`/g,'\\u0060')}\n\`\`\``;}
export function decodeMessage(body,marker){
  if(typeof body!=='string'||body.length>30000||!body.startsWith(marker+'\n'))throw new Error('Не найден запрос караоке.');
  const match=body.match(/```json\s*\n([\s\S]*?)\n```/);
  if(!match)throw new Error('Некорректный формат запроса.');
  return JSON.parse(match[1]);
}
