const fs = require('fs');

const DUMP_DIR = '/tmp/proxy-dumps';
let _dumpDirReady = false;

function ensureDumpDir() {
  if (!_dumpDirReady) {
    fs.mkdirSync(DUMP_DIR, { recursive: true });
    _dumpDirReady = true;
  }
}

function debugDump(filename, content) {
  if (process.env.DEBUG_DUMP === '1') {
    try {
      ensureDumpDir();
      fs.writeFileSync(`${DUMP_DIR}/${filename}`, content);
    } catch (e) {
      console.error(`[DEBUG DUMP ERROR] Failed to dump ${filename}: ${e.message}`);
    }
  }
}

// Alias — both call sites use the same dir now
const debugDumpProxy = debugDump;

function findThinkingBlockEnd(text, start) {
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (inStr) {
      if (ch === '\\') { escape = true; }
      else if (ch === '"') { inStr = false; }
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function maskThinkingBlocks(text) {
  const masks = [];
  const patterns = ['{"type":"thinking"', '{"type":"redacted_thinking"'];
  let result = '';
  let cursor = 0;
  while (cursor < text.length) {
    let nextStart = -1;
    for (const pat of patterns) {
      const idx = text.indexOf(pat, cursor);
      if (idx !== -1 && (nextStart === -1 || idx < nextStart)) nextStart = idx;
    }
    if (nextStart === -1) {
      result += text.slice(cursor);
      break;
    }
    const end = findThinkingBlockEnd(text, nextStart);
    if (end === -1) {
      result += text.slice(cursor);
      break;
    }
    result += text.slice(cursor, nextStart);
    const placeholder = `__OBP_THINK_MASK_${masks.length}__`;
    masks.push(text.slice(nextStart, end));
    result += placeholder;
    cursor = end;
  }
  return { masked: result, masks };
}

function unmaskThinkingBlocks(text, masks) {
  let result = text;
  for (let i = 0; i < masks.length; i++) {
    result = result.replaceAll(`__OBP_THINK_MASK_${i}__`, masks[i]);
  }
  return result;
}

function applyReplacements(text, replacements) {
  let r = text;
  for (const [find, rep] of replacements) {
    r = r.replaceAll(find, rep);
  }
  return r;
}

function reverseMap(text, config) {
  const { masked, masks } = maskThinkingBlocks(text);
  let r = masked;
  for (const [sanitized, original] of config.reverseMap) {
    r = r.replaceAll(sanitized, original);
  }
  return unmaskThinkingBlocks(r, masks);
}

module.exports = {
  debugDump,
  debugDumpProxy,
  findThinkingBlockEnd,
  maskThinkingBlocks,
  unmaskThinkingBlocks,
  applyReplacements,
  reverseMap
};