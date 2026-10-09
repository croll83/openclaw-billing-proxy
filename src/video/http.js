const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream');
const { VideoError } = require('./storyboard');
async function videoHTTP(service,req,res,key,body,json) {
  const pathname=new URL(req.url,'http://proxy.invalid').pathname;
  if(pathname==='/v1/video-jobs' && req.method==='POST') {
    const job=service.create(body,key,req.socket.remoteAddress,req.headers['idempotency-key']);
    res.setHeader('location',`/v1/video-jobs/${job.id}`);json(res,202,job);return;
  }
  const match=/^\/v1\/video-jobs\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:\/(content|poster|storyboard))?$/.exec(pathname);
  if(!match)throw new VideoError('not_found','Unknown video endpoint',404);
  const [,id,asset]=match,row=service.get(id,key);
  if(!asset && req.method==='GET') {json(res,200,service.public(row));return;}
  if(!asset && req.method==='DELETE') {json(res,202,service.cancel(id,key));return;}
  if(asset==='storyboard' && req.method==='GET') {
    if(!row.storyboard)throw new VideoError('not_ready','Storyboard is not available',409);
    json(res,200,JSON.parse(row.storyboard));return;
  }
  if(['content','poster'].includes(asset) && ['GET','HEAD'].includes(req.method)) {
    if(row.status!=='completed')throw new VideoError('not_ready','Video is not completed',409);
    const file=path.join(service.directory,id,asset==='content'?'video.mp4':'poster.png');
    let stat;try {stat=fs.statSync(file);}catch(_){throw new VideoError('asset_missing','Video asset is no longer available',410);}
    if(!stat.isFile())throw new VideoError('asset_missing','Video asset is no longer available',410);
    let start=0,end=stat.size-1,status=200;
    const headers={'content-type':asset==='content'?'video/mp4':'image/png','cache-control':'private, no-store',
      'x-content-type-options':'nosniff','accept-ranges':'bytes','content-disposition':`inline; filename="${asset==='content'?'video.mp4':'poster.png'}"`};
    if(req.headers.range) {
      const range=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if(range && (range[1] || range[2])) {
        if(range[1]) {start=Number(range[1]);end=range[2]?Math.min(Number(range[2]),end):end;}
        else start=Math.max(0,stat.size-Number(range[2]));
      }
      if(!range || !(range[1] || range[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start<0 || start>end || start>=stat.size) {
        res.writeHead(416,{...headers,'content-range':`bytes */${stat.size}`});res.end();return;
      }
      status=206;headers['content-range']=`bytes ${start}-${end}/${stat.size}`;
    }
    headers['content-length']=end-start+1;
    res.writeHead(status,headers);
    if(req.method==='HEAD')res.end();else pipeline(fs.createReadStream(file,{start,end}),res,()=>{});
    return;
  }
  req.resume();throw new VideoError('method_not_allowed','Method not allowed',405);
}
module.exports={videoHTTP};
