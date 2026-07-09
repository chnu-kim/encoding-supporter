/**
 * 실제 UI를 통과하는 종단 검증. 헤드리스 Chrome에서 변환을 돌리고, 산출물을 ffmpeg으로 뜯어본다.
 *
 *   npm run test:e2e
 *
 * 시스템 Chrome과 ffmpeg이 필요하므로 `npm test`(순수 로직)와 분리해 둔다.
 */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';

const run = promisify(execFile);
const root = new URL('..', import.meta.url).pathname;
const fixtures = join(root, 'test', 'fixtures');
const outDir = join(root, 'tmp', 'e2e');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.webm': 'video/webm', '.mp4': 'video/mp4',
};

function serve() {
  const server = createServer(async (req, res) => {
    try {
      const path = join(root, normalize(decodeURIComponent(req.url.split('?')[0])));
      // `..`가 섞인 경로로 저장소 밖을 읽지 못하게 한다.
      if (!path.startsWith(root)) throw new Error('out of root');
      const body = await readFile(path);
      res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

/** 첫 프레임을 raw RGBA로 뽑아 지정한 좌표의 픽셀을 읽는다. */
async function pixels(file, width, height, points, decoder) {
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (decoder) args.push('-vcodec', decoder);
  args.push('-i', file, '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', '-');

  const { stdout } = await run('ffmpeg', args, { encoding: 'buffer', maxBuffer: 1 << 28 });
  assert.equal(stdout.length, width * height * 4, `${file}: 프레임 크기가 다르다`);

  return points.map(([x, y]) => {
    const i = (y * width + x) * 4;
    return [stdout[i], stdout[i + 1], stdout[i + 2], stdout[i + 3]];
  });
}

async function probe(file, entries) {
  const { stdout } = await run('ffprobe', [
    '-hide_banner', '-loglevel', 'error',
    '-show_entries', entries, '-of', 'default=noprint_wrappers=1', file,
  ]);
  return stdout;
}

const near = (actual, expected, tolerance = 12) =>
  actual.slice(0, 3).every((c, i) => Math.abs(c - expected[i]) <= tolerance);

// ---------------------------------------------------------------------------

await mkdir(outDir, { recursive: true });
const { server, base } = await serve();
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage();

const failures = [];
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ✔ ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.log(`  ✖ ${name}\n      ${error.message}`);
  }
};

// 콘솔 에러는 화면이 멀쩡해 보여도 뭔가 깨졌다는 뜻이다. 눈으로 흘려보내지 않고 실패로 센다.
page.on('pageerror', (e) => failures.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  console.error('  [console]', m.text());
  failures.push(`console error: ${m.text()}`);
});

/** UI를 통해 파일을 올리고 변환한 뒤, 다운로드 blob을 디스크에 쓴다. */
async function convertThroughUi({ fixture, formatId, background, outName }) {
  await page.goto(`${base}/public/index.html`);
  await page.waitForFunction(() => globalThis.__app !== undefined);

  await page.setInputFiles('#fileInput', join(fixtures, fixture));
  await page.waitForSelector('#panel:not([hidden])', { timeout: 30_000 });

  const state = await page.evaluate(() => ({
    recommended: document.getElementById('fmtWebm').checked ? 'webm-vp8' : 'mp4-avc',
    alphaText: document.getElementById('metaAlpha').textContent,
    codecText: document.getElementById('metaCodec').textContent,
    bgVisible: !document.getElementById('bgRow').hidden,
  }));

  await page.check(formatId === 'webm-vp8' ? '#fmtWebm' : '#fmtMp4');
  if (background) {
    await page.click(`.swatch[data-color="${background}"]`);
  }
  const bgVisibleAfterPick = await page.evaluate(() => !document.getElementById('bgRow').hidden);

  await page.click('#convertBtn');
  await page.waitForSelector('#result:not([hidden])', { timeout: 120_000 });

  const bytes = await page.evaluate(async () => {
    const link = document.getElementById('downloadLink');
    const buf = await (await fetch(link.href)).arrayBuffer();
    return { name: link.download, data: Array.from(new Uint8Array(buf)) };
  });

  const path = join(outDir, outName);
  await writeFile(path, Buffer.from(bytes.data));
  return { path, downloadName: bytes.name, state, bgVisibleAfterPick };
}

// --------------------------------------------- 1. 투명 VP9 → VP8 WebM (알파 유지)

console.log('\n[1] 투명 webm → VP8 WebM: 알파를 그대로 유지한다');
{
  const r = await convertThroughUi({
    fixture: 'alpha-vp9.webm', formatId: 'webm-vp8', outName: 'alpha-to-vp8.webm',
  });

  check('투명 영상은 VP8 WebM을 추천한다', () => assert.equal(r.state.recommended, 'webm-vp8'));
  check('투명 배경을 감지해 표시한다', () => assert.match(r.state.alphaText, /있음/));
  check('VP8 선택 시 배경색을 묻지 않는다', () => assert.equal(r.bgVisibleAfterPick, false));
  check('다운로드 파일명에 -vp8 접미사가 붙는다', () => assert.equal(r.downloadName, 'alpha-vp9-vp8.webm'));

  const meta = await probe(r.path, 'stream=codec_name:stream_tags=alpha_mode');
  check('산출물이 VP8이다', () => assert.match(meta, /codec_name=vp8/));
  check('알파 채널이 기록됐다 (alpha_mode=1)', () => assert.match(meta, /alpha_mode=1/));

  const [corner, center] = await pixels(r.path, 320, 240, [[0, 0], [160, 120]], 'libvpx');
  check(`코너가 투명하다 (a=${corner[3]})`, () => assert.ok(corner[3] <= 2, `alpha=${corner[3]}`));
  check(`중앙이 불투명하다 (a=${center[3]})`, () => assert.equal(center[3], 255));
  check(`중앙 색이 원본 파랑에 가깝다 (${center.slice(0, 3)})`, () => assert.ok(near(center, [0, 0, 255], 20)));
}

// ------------------------------------- 2. 투명 VP9 → MP4 (마젠타 배경으로 크로마키)

console.log('\n[2] 투명 webm → MP4: 고른 배경색으로 알파를 평탄화한다');
{
  const r = await convertThroughUi({
    fixture: 'alpha-vp9.webm', formatId: 'mp4-avc', background: '#ff00ff', outName: 'alpha-to-magenta.mp4',
  });

  check('MP4 선택 시 배경색을 묻는다', () => assert.equal(r.bgVisibleAfterPick, true));
  check('다운로드 파일명이 .mp4다', () => assert.equal(r.downloadName, 'alpha-vp9.mp4'));

  const meta = await probe(r.path, 'stream=codec_name,pix_fmt');
  check('산출물이 H.264다', () => assert.match(meta, /codec_name=h264/));

  const [corner, edge, center] = await pixels(r.path, 320, 240, [[0, 0], [10, 10], [160, 120]]);
  check(`코너가 마젠타다 (${corner.slice(0, 3)})`, () => assert.ok(near(corner, [255, 0, 255])));
  check(`가장자리도 마젠타다 (${edge.slice(0, 3)})`, () => assert.ok(near(edge, [255, 0, 255])));
  check(`중앙은 원본 파랑을 유지한다 (${center.slice(0, 3)})`, () => assert.ok(near(center, [0, 0, 255], 20)));
  check('MP4는 알파가 없다', () => assert.equal(center[3], 255));
}

// ------------------------------------------ 3. 불투명 VP9 + Opus → MP4 (오디오 포함)

console.log('\n[3] 불투명 webm + 오디오 → MP4: 소리를 살리고 배경을 묻지 않는다');
{
  const r = await convertThroughUi({
    fixture: 'opaque-vp9-opus.webm', formatId: 'mp4-avc', outName: 'opaque-to-mp4.mp4',
  });

  check('불투명 영상은 MP4를 추천한다', () => assert.equal(r.state.recommended, 'mp4-avc'));
  check('투명 없음으로 표시한다', () => assert.match(r.state.alphaText, /없음/));
  check('오디오 트랙을 인식한다', () => assert.match(r.state.codecText, /opus/));
  check('불투명이면 배경색을 묻지 않는다', () => assert.equal(r.bgVisibleAfterPick, false));

  const meta = await probe(r.path, 'stream=codec_type,codec_name');
  check('영상이 H.264다', () => assert.match(meta, /codec_name=h264/));
  check('오디오가 AAC로 재인코딩됐다', () => assert.match(meta, /codec_name=aac/));

  const [corner] = await pixels(r.path, 320, 240, [[0, 0]]);
  check('불투명 영상은 배경이 덧칠되지 않았다', () => assert.ok(!near(corner, [0, 255, 0], 30)));
}

// ------------------------------------ 4. 투명 VP9 + Opus → VP8 WebM (알파와 소리 동시)

console.log('\n[4] 투명 webm + 오디오 → VP8 WebM: 알파와 소리를 모두 옮긴다');
{
  const r = await convertThroughUi({
    fixture: 'alpha-vp9-opus.webm', formatId: 'webm-vp8', outName: 'alpha-audio-to-vp8.webm',
  });

  check('투명 + 오디오 영상도 VP8을 추천한다', () => assert.equal(r.state.recommended, 'webm-vp8'));

  const meta = await probe(r.path, 'stream=codec_type,codec_name:stream_tags=alpha_mode');
  check('영상이 VP8이다', () => assert.match(meta, /codec_name=vp8/));
  check('알파 채널이 살아 있다', () => assert.match(meta, /alpha_mode=1/));
  check('오디오가 Opus로 남았다', () => assert.match(meta, /codec_name=opus/));

  const [corner, center] = await pixels(r.path, 320, 240, [[0, 0], [160, 120]], 'libvpx');
  check(`오디오가 있어도 코너는 투명하다 (a=${corner[3]})`, () => assert.ok(corner[3] <= 2, `alpha=${corner[3]}`));
  check('중앙은 불투명하다', () => assert.equal(center[3], 255));
}

// ---------------------------------------------------------------------------

await browser.close();
server.close();

console.log('');
if (failures.length > 0) {
  console.error(`실패 ${failures.length}건:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('E2E 통과');
