class MediaError extends Error {
  constructor(code,message,status=400) { super(message);this.code=code;this.status=status; }
}
module.exports={MediaError};
