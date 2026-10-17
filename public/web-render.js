import {parseLyrics} from './timing.js';

export function browserFormat() {
  if(typeof MediaRecorder==='undefined')return {extension:'webm',label:'WebM',supported:false};
  const formats=[['video/mp4;codecs=avc1.42E01E,mp4a.40.2','mp4','MP4'],['video/mp4','mp4','MP4'],['video/webm;codecs=vp8,opus','webm','WebM'],['video/webm','webm','WebM']];
  const format=formats.find(([mime])=>MediaRecorder.isTypeSupported(mime));
  return format?{mime:format[0],extension:format[1],label:format[2],supported:true}:{extension:'webm',label:'WebM',supported:false};
}
const themes={violet:{base:'#100d26',glow:'#63378e',accent:'#dfb7f6'},ocean:{base:'#051722',glow:'#126e7d',accent:'#a1e5da'},sunset:{base:'#24101d',glow:'#a7404a',accent:'#ffb68d'}};

function wrapped(ctx,text,size,max=880) {
  ctx.font=`600 ${size}px sans-serif`;
  const rows=[[]];
  for(const word of text.split(/\s+/)) {
    const row=rows.at(-1);
    if(row.length&&ctx.measureText([...row,word].join(' ')).width>max)rows.push([word]);else row.push(word);
  }
  return rows;
}
function draw(ctx,background,settings,lines,now) {
  const palette=themes[settings.theme]||themes.violet;
  ctx.drawImage(background,0,0,1080,1920);
  ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillStyle='#c5b0d7';ctx.font='25px sans-serif';ctx.fillText('K A R A O K E  S T U D I O',540,155);
  ctx.fillStyle='#fff';ctx.font='600 48px sans-serif';ctx.fillText(settings.title||'Без названия',540,335,900);
  ctx.fillStyle='#b1a0bd';ctx.font='36px sans-serif';ctx.fillText(settings.artist||'',540,420,900);
  const index=lines.findIndex(line=>now>=line.start&&now<line.end),line=lines[index];
  if(line) {
    let size=+settings.fontSize||64,rows=wrapped(ctx,line.text,size);
    if(rows.length>3){size=Math.max(32,Math.floor(size*3/rows.length));rows=wrapped(ctx,line.text,size);}
    const words=line.text.split(/\s+/),total=words.reduce((n,w)=>n+w.length,0),p=Math.max(0,Math.min(1,(now-line.start)/(line.end-line.start)));
    let consumed=0;
    rows.forEach((row,ri)=>{
      const y=940+(ri-(rows.length-1)/2)*size*1.5;
      ctx.font=`600 ${size}px sans-serif`;
      let x=(1080-ctx.measureText(row.join(' ')).width)/2;
      ctx.textAlign='left';
      for(const word of row){
        const width=ctx.measureText(word).width,highlight=Math.max(0,Math.min(1,(p-consumed/total)/(word.length/total)));
        ctx.fillStyle='#fff';ctx.fillText(word,x,y);
        if(highlight>0){ctx.save();ctx.beginPath();ctx.rect(x-1,y-size,width*highlight+1,size*2);ctx.clip();ctx.fillStyle=palette.accent;ctx.fillText(word,x,y);ctx.restore();}
        consumed+=word.length;x+=width+ctx.measureText(' ').width;
      }
      ctx.textAlign='center';
    });
  }
  const next=index>=0?lines[index+1]:lines.find(line=>line.start>now);
  if(next){const rows=wrapped(ctx,next.text,42);ctx.font='42px sans-serif';ctx.fillStyle='#ad97ba';rows.forEach((r,i)=>ctx.fillText(r.join(' '),540,1150+i*57,890));}
  ctx.fillStyle='#ac94bf';ctx.font='24px sans-serif';ctx.fillText('П О Й  В  С В О Ё М  Р И Т М Е',540,1745,880);
}

export async function renderInBrowser(settings,getBlob,onProgress) {
  const format=browserFormat();
  if(!format.supported||!HTMLCanvasElement.prototype.captureStream)throw new Error('Запись видео не поддерживается этим браузером. Открой сайт в актуальном Chrome, Edge или Safari.');
  const Context=window.AudioContext||window.webkitAudioContext;
  if(!Context)throw new Error('В этом браузере недоступна обработка аудио.');
  const context=new Context();
  // Resume before the first async file read to preserve the click's user activation.
  const resumed=context.resume();
  let stream,source,frame,recorder;
  try {
    await resumed;
    const blob=await getBlob();
    const buffer=await context.decodeAudioData(await blob.arrayBuffer());
    const lines=parseLyrics(settings.lyrics||'',buffer.duration,settings.offset||0);
    if(!lines.length)throw new Error('Таймкоды находятся за пределами аудио.');
    let playback=buffer;
    if(settings.vocalMode==='reduce') {
      if(buffer.numberOfChannels<2)throw new Error('Приглушение вокала работает только со стереофайлами.');
      playback=context.createBuffer(2,buffer.length,buffer.sampleRate);
      const left=buffer.getChannelData(0),right=buffer.getChannelData(1),outL=playback.getChannelData(0),outR=playback.getChannelData(1);
      for(let i=0;i<buffer.length;i++){outL[i]=Math.max(-1,Math.min(1,left[i]-right[i]));outR[i]=-outL[i];}
    }
    const background=new Image();background.src=`./assets/background-${themes[settings.theme]?settings.theme:'violet'}.png`;await background.decode();
    const canvas=document.createElement('canvas');canvas.width=1080;canvas.height=1920;
    const ctx=canvas.getContext('2d',{alpha:false});
    draw(ctx,background,settings,lines,0);
    const destination=context.createMediaStreamDestination();
    source=context.createBufferSource();source.buffer=playback;source.connect(destination);
    stream=canvas.captureStream(30);destination.stream.getAudioTracks().forEach(track=>stream.addTrack(track));
    recorder=new MediaRecorder(stream,{mimeType:format.mime,videoBitsPerSecond:5000000,audioBitsPerSecond:192000});
    const chunks=[];
    recorder.ondataavailable=event=>{if(event.data.size)chunks.push(event.data);};
    const finished=new Promise((resolve,reject)=>{
      recorder.onstop=()=>chunks.length?resolve(new Blob(chunks,{type:recorder.mimeType})):reject(new Error('Браузер создал пустой файл.'));
      recorder.onerror=()=>reject(new Error('Браузер прервал запись видео. Попробуй более короткий трек.'));
    });
    const start=context.currentTime+.1;
    const paint=()=>{
      const now=Math.max(0,context.currentTime-start);
      draw(ctx,background,settings,lines,now);onProgress(Math.min(99,Math.round(now/buffer.duration*100)));
      frame=requestAnimationFrame(paint);
    };
    source.onended=()=>{cancelAnimationFrame(frame);if(recorder.state!=='inactive')recorder.stop();};
    recorder.start(1000);source.start(start);paint();
    const output=await finished;
    return {blob:output,extension:format.extension,label:format.label};
  } finally {
    cancelAnimationFrame(frame);
    if(recorder&&recorder.state!=='inactive')recorder.stop();
    try{source?.stop();}catch{}
    source?.disconnect();stream?.getTracks().forEach(track=>track.stop());
    await context.close();
  }
}
