'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

// Stub external packages when node_modules is not installed in offline/restricted environments.
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  try { return origLoad.call(this, request, parent, isMain); }
  catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND') throw err;
    if (request === '@whiskeysockets/baileys') {
      return { proto: { WebMessageInfo: { fromObject: x => x } }, downloadContentFromMessage: async () => [], getContentType: () => 'conversation' };
    }
    if (request === 'axios') return { post: async () => ({}), get: async () => ({}) };
    if (request === 'dotenv') return { config: () => ({}) };
    throw err;
  }
};

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  FAIL ${name}\n       ${err.stack || err.message}`);
    failed += 1;
  }
}

(async () => {
  console.log('security & stabilization regression suite');

  await test('SEC-01: plugins/download.js has no embedded Google/YouTube cookies', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'download.js'), 'utf8');
    assert.strictEqual(src.includes('EMBEDDED_COOKIES_B64'), false, 'EMBEDDED_COOKIES_B64 must not exist');
  });

  await test('SEC-02: lib/msg.js sanitizes traversal and missing extensions', () => {
    const { sanitizeBaseName, safeDocExt } = require('../lib/msg');
    assert.strictEqual(sanitizeBaseName('../../etc/passwd'), 'passwd');
    assert.strictEqual(sanitizeBaseName('..'), 'media');
    assert.strictEqual(safeDocExt('file.txt/../../evil'), 'bin');
    assert.strictEqual(safeDocExt('noext'), 'bin');
    assert.strictEqual(safeDocExt('report.pdf'), 'pdf');
    assert.strictEqual(safeDocExt('photo.jpeg'), 'jpg');
  });

  await test('SEC-03: lib/urlGuard.js blocks private/loopback/metadata hosts and unsafe redirects', async () => {
    const { assertPublicHttpUrlSync, safeFetch } = require('../lib/urlGuard');
    for (const bad of [
      'http://127.0.0.1/admin',
      'http://localhost:8000/health',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/',
      'http://192.168.1.1/',
      'http://[::1]/',
      'file:///etc/passwd',
    ]) {
      assert.throws(() => assertPublicHttpUrlSync(bad), /Private|loopback|http/i, `Expected block for ${bad}`);
    }
    assert.doesNotThrow(() => assertPublicHttpUrlSync('https://www.youtube.com/watch?v=dQw4w9WgXcQ'));

    const mockFetch = async () => ({
      status: 302,
      headers: { get: k => (k.toLowerCase() === 'location' ? 'http://127.0.0.1:8000/health' : null) },
      body: { cancel: async () => {} },
    });
    await assert.rejects(
      () => safeFetch('https://example.com/start', {}, { fetchImpl: mockFetch, resolveDns: false }),
      /Private|loopback/i
    );
  });

  await test('ISS-04: lib/ffmpeg.js respects FFMPEG_PATH env override', () => {
    const prev = process.env.FFMPEG_PATH;
    process.env.FFMPEG_PATH = '/custom/bin/ffmpeg';
    try {
      const { getFfmpegPath } = require('../lib/ffmpeg');
      assert.strictEqual(getFfmpegPath(), '/custom/bin/ffmpeg');
    } finally {
      if (prev === undefined) delete process.env.FFMPEG_PATH;
      else process.env.FFMPEG_PATH = prev;
    }
  });

  await test('ISS-10: lib/gemini.js isolates chat history by accountId', () => {
    const g = require('../lib/gemini');
    g.clearHistory('123@s.whatsapp.net', 'acc1');
    g.clearHistory('123@s.whatsapp.net', 'acc2');
    g.pushHistory('123@s.whatsapp.net', 'user', 'hello acc1', 'acc1');
    assert.strictEqual(g.getHistory('123@s.whatsapp.net', 'acc1').length, 1);
    assert.strictEqual(g.getHistory('123@s.whatsapp.net', 'acc2').length, 0);
    g.clearHistory('123@s.whatsapp.net', 'acc1');
  });

  await test('ISS-11: lib/viewonce.js get() is async and handles missing IDs cleanly', async () => {
    const vo = require('../lib/viewonce');
    assert.strictEqual(await vo.get('nonexistent-id'), null);
  });

  await test('ISS-04: ytupdate command is registered and documented in usage.js', () => {
    require('../plugins/download');
    const { commands } = require('../command');
    const usage = require('../lib/usage');
    assert.ok(commands.some(c => c.pattern === 'ytupdate'), 'ytupdate command missing');
    assert.ok(usage.getUsage('ytupdate'), 'ytupdate usage entry missing');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
