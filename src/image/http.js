const fs=require('node:fs');
const path=require('node:path');
const {pipeline}=require('node:stream');
const {MediaError}=require('../media/errors');
async function imageHTTP(service,req,res,key,body,json) {
  const pathname=new URL(req.url,'http://proxy.invalid').pathname;
  if(pathname==='/v1/image-jobs' && req.method==='POST') {
    const job=service.create(body,key,req.socket.remoteAddress,req.headers['idempotency-key']);
    res.setHeader('location',`/v1/image-jobs/${job.id}`);json(res,202,job);return;
  }
  const match=/^\/v1\/image-jobs\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(\/content)?$/.exec(pathname);
  if(!match)throw new MediaError('not_found','Unknown image endpoint',404);
  const [,id,asset]=match,row=service.get(id,key);
  if(!asset && req.method==='GET'){json(res,200,service.public(row));return;}
  if(!asset && req.method==='DELETE'){json(res,202,service.cancel(id,key));return;}
  if(asset && ['GET','HEAD'].includes(req.method)) {
    if(row.status!=='completed')throw new MediaError('not_ready','Image is not completed',409);
    const file=path.join(service.directory,id,'image.png');let stat;
    try {stat=fs.statSync(file);}catch(_){throw new MediaError('asset_missing','Image is no longer available',410);}
    res.writeHead(200,{'content-type':'image/png','content-length':stat.size,'cache-control':'private, no-store',
      'x-content-type-options':'nosniff','content-disposition':'inline; filename="image.png"'});
    if(req.method==='HEAD')res.end();else pipeline(fs.createReadStream(file),res,()=>{});
    return;
  }
  req.resume();throw new MediaError('method_not_allowed','Method not allowed',405);
}
module.exports={imageHTTP};
