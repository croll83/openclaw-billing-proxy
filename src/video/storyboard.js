// Model output is data, never executable HTML, JavaScript, SVG or FFmpeg filters.
const FORMATS = { landscape: [1280,720], portrait: [720,1280], square: [720,720] };
class VideoError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
function invalid(message) { throw new VideoError('invalid_input',message); }
function object(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k=>!allowed.includes(k))) invalid('Unexpected object fields');
}
function number(value,min,max) {
  if (!Number.isFinite(value) || value < min || value > max) invalid(`Expected a number between ${min} and ${max}`);
  return value;
}
function color(value) { if (typeof value !== 'string' || !/^#[a-f0-9]{6}$/i.test(value)) invalid('Use a six-digit hex color'); return value.toLowerCase(); }
function text(value,max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x08\x0b-\x1f\x7f]/.test(value)) invalid(`Text must contain 1–${max} characters without control characters`);
  return value.trim();
}
function request(input,model='claude-opus-5-5') {
  object(input,['prompt','format','duration_seconds']);
  const format=input.format ?? 'landscape', duration=input.duration_seconds ?? 20;
  if (typeof format!=='string' || !Object.hasOwn(FORMATS,format)) invalid('format must be landscape, portrait or square');
  if (!Number.isInteger(duration)) invalid('duration_seconds must be an integer');
  number(duration,1,60);
  return {prompt:text(input.prompt,12000),format,duration_seconds:duration,model};
}
function storyboard(input,duration) {
  object(input,['scenes']);
  if (!Array.isArray(input.scenes) || !input.scenes.length || input.scenes.length > 12) invalid('Use 1–12 scenes');
  let total=0;
  const scenes=input.scenes.map(scene=>{
    object(scene,['duration_seconds','background','elements']);
    const seconds=number(scene.duration_seconds,1,60);
    if (!Number.isInteger(seconds)) invalid('Scene durations must be whole seconds');
    total+=seconds;
    if (!Array.isArray(scene.elements) || scene.elements.length > 24) invalid('Use at most 24 elements per scene');
    const elements=scene.elements.map(el=>{
      object(el,['type','text','x','y','width','height','color','font_size','align','bold','animation','delay']);
      if (!['text','rect','circle','bar'].includes(el.type)) invalid('Unsupported element type');
      const out={type:el.type,x:number(el.x,0,1),y:number(el.y,0,1),color:color(el.color),animation:el.animation ?? 'fade_in',delay:number(el.delay ?? 0,0,seconds-.5)};
      if (!['none','fade_in','slide_up','grow'].includes(out.animation)) invalid('Unsupported animation');
      if (el.type==='text') {
        if (el.width!==undefined || el.height!==undefined) invalid('Text does not accept dimensions');
        out.text=text(el.text,240); out.font_size=number(el.font_size ?? .06,.02,.18);
        out.align=el.align ?? 'left';out.bold=el.bold ?? false;
        if (!['left','center','right'].includes(out.align) || typeof out.bold!=='boolean') invalid('Invalid text style');
        if (out.animation==='grow') invalid('grow is only supported on shapes');
        if (out.text.split('\n').length>5) invalid('Use at most five lines per text element');
      } else {
        if (['text','font_size','align','bold'].some(k=>el[k]!==undefined)) invalid('Shape does not accept text style');
        out.width=number(el.width,.005,1-out.x);out.height=number(el.height,.005,1-out.y);
      }
      return out;
    });
    return {duration_seconds:seconds,background:color(scene.background),elements};
  });
  if (total!==duration) invalid('Scene durations must sum to duration_seconds');
  return {scenes};
}
function instructions(job) {
  return `Create an animated marketing video storyboard. Return only a JSON object, no markdown, code, tools or commentary.
Canvas format: ${job.format}. Total duration: EXACTLY ${job.duration_seconds} seconds.
Schema: {"scenes":[{"duration_seconds":5,"background":"#071827","elements":[{"type":"text","text":"Title","x":0.08,"y":0.25,"color":"#ffffff","font_size":0.08,"align":"left","bold":true,"animation":"slide_up","delay":0}]}]}.
Use 1–12 scenes. Scene durations are positive WHOLE seconds summing to the requested total. Each scene has up to 24 elements.
Coordinates x,y,width,height are fractions of the canvas (0–1). All colors are six-digit hex. Text font_size is a fraction of canvas height, between .02 and .18. Text y is the top, not the baseline. Text is at most 240 characters and five explicit lines; wrap it manually to fit and keep generous margins. Available font: DejaVu Sans. Avoid emoji and unsupported scripts.
Elements: text (text,font_size,align:left|center|right,bold:boolean), rect, circle (ellipse), bar. Shapes require width,height and must fit on canvas. Shapes do not accept text fields. Every element has type,x,y,color,animation and delay. Allowed animations: none, fade_in, slide_up; grow also supported for shapes. Delay is seconds, <= scene duration minus .5. Layer order is back to front. Use charts, diagrams and geometric illustrations where useful.
No images, URLs, HTML, SVG, JavaScript, filters, audio or other fields. Respect the user's language, supplied facts and intent. Do not invent business claims or numbers. This is a motion graphic, not realistic footage.`;
}
module.exports={FORMATS,VideoError,request,storyboard,instructions};
