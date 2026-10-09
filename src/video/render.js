const fs = require('node:fs');
const path = require('node:path');
const { spawn,execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const { Resvg } = require('@resvg/resvg-js');
const { FORMATS,VideoError } = require('./storyboard');
const FPS=24;
async function preflight(options) {
  if(!fs.statSync(options.fontFile).isFile())throw new Error('Video font file is missing');
  await new Promise((resolve,reject)=>execFile(options.ffmpegPath,['-hide_banner','-encoders'],
    {timeout:15000,maxBuffer:512*1024,env:{PATH:process.env.PATH || '/usr/bin:/bin',LANG:'C'}},(error,out)=>{
      if(error || !/\blibx264\b/.test(out))reject(new Error('FFmpeg with libx264 is required for video jobs'));else resolve();
    }));
}
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
function frame(scene,time,width,height) {
  const elements=scene.elements.map(el=>{
    if(time<el.delay)return '';
    const p=Math.min(1,(time-el.delay)/.65),ease=1-(1-p)**3;
    const opacity=el.animation==='none'?1:ease;
    const y=el.y*height+(el.animation==='slide_up'?(1-ease)*height*.04:0),x=el.x*width;
    let shape;
    if(el.type==='text') {
      const size=el.font_size*height,anchor={left:'start',center:'middle',right:'end'}[el.align];
      shape=`<text x="${x}" y="${y+size}" fill="${el.color}" font-family="DejaVu Sans" font-size="${size}" font-weight="${el.bold?700:400}" text-anchor="${anchor}">`+
        el.text.split('\n').map((line,i)=>`<tspan x="${x}" dy="${i?size*1.2:0}">${escape(line)}</tspan>`).join('')+'</text>';
    } else {
      const w=el.width*width*(el.animation==='grow'?ease:1),h=el.height*height;
      shape=el.type==='circle'?`<ellipse cx="${x+w/2}" cy="${y+h/2}" rx="${w/2}" ry="${h/2}" fill="${el.color}"/>`:
        `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${el.type==='bar'?Math.min(h/2,8):0}" fill="${el.color}"/>`;
    }
    return `<g opacity="${opacity}">${shape}</g>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="${scene.background}"/>${elements}</svg>`;
}
function png(svg,fontFile) {
  return new Resvg(svg,{font:{loadSystemFonts:false,fontFiles:[fontFile],defaultFontFamily:'DejaVu Sans'}}).render().asPng();
}
function write(child,buffer) {
  return new Promise((resolve,reject)=>{
    if(child.stdin.destroyed)return reject(new VideoError('render_failed','Encoder input closed',502));
    child.stdin.write(buffer,error=>error?reject(error):resolve());
  });
}
async function render(plan,job,directory,options,signal) {
  const [width,height]=FORMATS[job.format],output=path.join(directory,'video.mp4'),poster=path.join(directory,'poster.png');
  const child=spawn(options.ffmpegPath,[
    '-hide_banner','-loglevel','error','-nostdin','-y','-f','image2pipe','-framerate',String(FPS),'-vcodec','png','-i','pipe:0',
    '-an','-c:v','libx264','-preset','veryfast','-crf','23','-maxrate','3M','-bufsize','6M','-pix_fmt','yuv420p',
    '-threads','2','-movflags','+faststart',output,
  ],{shell:false,stdio:['pipe','ignore','ignore'],env:{PATH:process.env.PATH || '/usr/bin:/bin',LANG:'C'}});
  // Never pass account credentials, proxy keys or the model prompt to the encoder.
  child.stdin.on('error',()=>{});
  const exit=new Promise((resolve,reject)=>{
    child.once('error',()=>reject(new VideoError('renderer_unavailable','Video encoder could not start',503)));
    child.once('close',code=>code===0?resolve():reject(new VideoError('render_failed','Video encoding failed',502)));
  });
  // Register rejection immediately while frames are still being produced.
  exit.catch(()=>{});
  const abort=()=>child.kill('SIGKILL');signal.addEventListener('abort',abort,{once:true});
  try {
    if(signal.aborted)throw new VideoError('cancelled','Video rendering cancelled',409);
    fs.writeFileSync(poster,png(frame(plan.scenes[0],.75,width,height),options.fontFile),{mode:0o600});
    for(const scene of plan.scenes)for(let n=0;n<scene.duration_seconds*FPS;n++) {
      if(signal.aborted)throw new VideoError('cancelled','Video rendering cancelled',409);
      await write(child,png(frame(scene,n/FPS,width,height),options.fontFile));
      await new Promise(resolve=>setImmediate(resolve));
    }
    child.stdin.end();await exit;
    fs.chmodSync(output,0o600);
    const bytes=fs.statSync(output).size;
    if(bytes<32 || bytes+fs.statSync(poster).size>options.maxOutputBytes)throw new VideoError('output_size_limit','Encoded media exceeds output limits',502);
    const data=fs.readFileSync(output);
    if(data.subarray(4,8).toString()!=='ftyp')throw new VideoError('render_failed','Encoder did not produce an MP4',502);
    return {bytes,sha256:createHash('sha256').update(data).digest('hex'),width,height,fps:FPS,duration_seconds:job.duration_seconds};
  } finally {
    signal.removeEventListener('abort',abort);
    if(child.exitCode===null)child.kill('SIGKILL');
    await exit.catch(()=>{});
  }
}
module.exports={render,frame,png,preflight,FPS};
