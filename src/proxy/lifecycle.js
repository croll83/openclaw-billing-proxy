// Gemini handlers convert wire formats, but upstream lifetime must still follow the caller.
function lifecycle(req,res,config) {
  let upstream, response, stopped = false;
  const cancel = () => { stopped = true; response?.destroy(); upstream?.destroy(); };
  const originalWrite = res.write;
  let awaitingDrain = false;
  const drain = () => { awaitingDrain = false; if (!stopped) response?.resume(); };
  res.write = function(...args) {
    const ready = originalWrite.apply(this,args);
    if (!ready && response && !awaitingDrain) { awaitingDrain = true; response.pause(); res.once('drain',drain); }
    return ready;
  };
  const cleanup = () => { req.removeListener('aborted',cancel); res.removeListener('close',onClose); res.removeListener('drain',drain); res.write = originalWrite; };
  const onClose = () => { if (!res.writableFinished) cancel(); cleanup(); };
  req.once('aborted',cancel); res.once('close',onClose);
  const fail = (status,message) => {
    if (stopped || res.destroyed || res.writableEnded) return;
    if (res.headersSent) res.destroy();
    else { res.writeHead(status,{'content-type':'application/json'}); res.end(JSON.stringify({error:{message}})); }
    cancel();
  };
  return {
    get stopped() { return stopped || req.aborted || res.destroyed || res.writableEnded; },
    request(value) {
      upstream = value;
      if (this.stopped) { cancel(); return; }
      upstream.setTimeout(config.anthropicTimeoutMs ?? 3600000,() => fail(504,'Gemini upstream idle timeout'));
      upstream.once('error',() => fail(502,'Gemini upstream connection failed'));
    },
    response(value) {
      response = value;
      if (this.stopped) { cancel(); return; }
      response.once('error',() => fail(502,'Gemini upstream response interrupted'));
      response.once('aborted',() => fail(502,'Gemini upstream response aborted'));
      config.onUpstreamResponse?.(response.statusCode,response.headers);
    },
  };
}
module.exports = { lifecycle };
