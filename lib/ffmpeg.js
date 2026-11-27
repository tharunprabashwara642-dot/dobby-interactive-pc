'use strict';
/**
 * Single source of truth for FFmpeg binary resolution.
 * Priority: FFMPEG_PATH env -> ffmpeg-static package -> system 'ffmpeg' on PATH.
 */
const fs = require('fs');

let staticPath = null;
try {
  const candidate = require('ffmpeg-static');
  if (candidate && fs.existsSync(candidate)) staticPath = candidate;
} catch {
  staticPath = null;
}

function getFfmpegPath() {
  const envPath = String(process.env.FFMPEG_PATH || '').trim();
  if (envPath) return envPath;
  if (staticPath) return staticPath;
  return 'ffmpeg';
}

module.exports = {
  getFfmpegPath,
  ffmpegStaticPath: staticPath,
};
