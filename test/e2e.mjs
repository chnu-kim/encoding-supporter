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
      // 페이지가 파비콘을 인라인으로 들고 있어 지금은 요청이 오지 않는다. 그래도 조용히 받아준다.
      // 이게 404가 되면 브라우저가 콘솔 에러를 찍고, 콘솔 에러는 배포를 막는다.
      if (req.url === '/favicon.ico') return void res.writeHead(204).end();

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
  let swatchColor = null;
  if (background) {
    await page.click(`.swatch[data-color="${background}"]`);
    // 색이 CSP에 막혀 사라지면 사용자는 무엇을 고르는지 볼 수 없다.
    swatchColor = await page.evaluate((c) => {
      const el = document.querySelector(`.swatch[data-color="${c}"]`);
      return getComputedStyle(el).backgroundColor;
    }, background);
  }
  const bgVisibleAfterPick = await page.evaluate(() => !document.getElementById('bgRow').hidden);

  await page.click('#convertBtn');
  await page.waitForSelector('#result:not([hidden])', { timeout: 120_000 });

  const bytes = await page.evaluate(async () => {
    const link = document.getElementById('downloadLink');
    const buf = await (await fetch(link.href)).arrayBuffer();
    return { name: link.download, data: Array.from(new Uint8Array(buf)) };
  });

  const resultWarning = await page.evaluate(() => {
    const node = document.getElementById('resultWarning');
    return node.hidden ? null : node.textContent;
  });

  const path = join(outDir, outName);
  await writeFile(path, Buffer.from(bytes.data));
  return { path, downloadName: bytes.name, state, bgVisibleAfterPick, resultWarning, swatchColor };
}

/**
 * AAC 인코더는 브라우저가 아니라 OS가 쥐고 있다. macOS는 AudioToolbox, Windows는 Media
 * Foundation이 내주지만 리눅스에는 아예 없다. 그래서 같은 Chrome이라도 리눅스에서는 MP4에
 * 소리를 담지 못한다. 검사를 환경에 맞춰 가르고, 리눅스에서는 소리를 빼고 경고하는 경로를 본다.
 */
const support = await (async () => {
  await page.goto(`${base}/public/index.html`);
  await page.waitForFunction(() => globalThis.__app !== undefined);
  return page.evaluate(() => globalThis.__app.state.support);
})();
console.log(`브라우저 지원: ${JSON.stringify(support)}`);

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
  check(`배경색 버튼에 실제로 그 색이 칠해져 있다 (${r.swatchColor})`,
    () => assert.equal(r.swatchColor, 'rgb(255, 0, 255)'));

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

  if (support.aac) {
    check('오디오가 AAC로 재인코딩됐다', () => assert.match(meta, /codec_name=aac/));
    check('소리가 살아 있으면 경고하지 않는다', () => assert.equal(r.resultWarning, null));
  } else {
    // 리눅스 Chrome에는 AAC 인코더가 없다. 소리를 조용히 잃지 않고 반드시 알린다.
    check('AAC를 못 만들면 오디오 트랙을 담지 않는다', () => assert.doesNotMatch(meta, /codec_type=audio/));
    check('소리가 빠졌다는 사실을 사용자에게 알린다', () => {
      assert.ok(r.resultWarning, '경고가 표시되지 않았다');
      assert.match(r.resultWarning, /소리/);
    });
  }

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

// ------------------------------------------------- 5. 변환 도중 취소 (취소는 실패가 아니다)

console.log('\n[5] 변환 도중 취소: 내부 사정이 아니라 취소했다고 알린다');
{
  await page.goto(`${base}/public/index.html`);
  await page.waitForFunction(() => globalThis.__app !== undefined);
  await page.setInputFiles('#fileInput', join(fixtures, 'alpha-vp9-long.webm'));
  await page.waitForSelector('#panel:not([hidden])', { timeout: 30_000 });

  await page.click('#convertBtn');
  // 인코더가 실제로 돌고 있는 동안 눌러야 이 회귀를 지나간다. 진행률이 처음 오르는 바로 그
  // 자리에서 누른다. 밖에서 폴링하면 그 사이에 변환이 끝나 취소 버튼이 사라질 수 있다.
  await page.evaluate(() => new Promise((resolve, reject) => {
    const text = document.getElementById('progressText');
    const observer = new MutationObserver(() => {
      if (Number.parseInt(text.textContent, 10) <= 0) return;
      observer.disconnect();
      clearTimeout(timer);
      document.getElementById('cancelBtn').click();
      resolve();
    });
    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error('진행률이 오르지 않아 취소를 눌러 볼 수 없었다'));
    }, 60_000);
    observer.observe(text, { childList: true, characterData: true, subtree: true });
  }));
  await page.waitForSelector('#error:not([hidden])', { timeout: 30_000 });

  const s = await page.evaluate(() => ({
    error: document.getElementById('error').textContent,
    resultShown: !document.getElementById('result').hidden,
    convertDisabled: document.getElementById('convertBtn').disabled,
    cancelHidden: document.getElementById('cancelBtn').hidden,
    progressHidden: document.getElementById('progressRow').hidden,
    busy: document.getElementById('panel').getAttribute('aria-busy'),
  }));

  check('취소하면 취소했다고 알린다', () => assert.match(s.error, /취소/));
  check('실패했다고 말하지 않는다', () => assert.doesNotMatch(s.error, /실패/));
  check('인코더 내부 사정을 노출하지 않는다', () => assert.doesNotMatch(s.error, /splitter|closed|Error/i));
  check('취소했으면 결과를 내놓지 않는다', () => assert.equal(s.resultShown, false));
  check('취소 후 진행률을 감춘다', () => assert.equal(s.progressHidden, true));
  check('취소 후 취소 버튼을 감춘다', () => assert.equal(s.cancelHidden, true));
  check('취소 후 다시 변환할 수 있다', () => assert.equal(s.convertDisabled, false));
  check('취소하면 aria-busy를 내린다', () => assert.equal(s.busy, 'false'));

  // 취소가 앱 상태를 오염시키지 않았는지, 짧은 파일로 끝까지 변환해 확인한다.
  await page.setInputFiles('#fileInput', join(fixtures, 'alpha-vp9.webm'));
  await page.waitForSelector('#panel:not([hidden])', { timeout: 30_000 });
  await page.click('#convertBtn');
  const recovered = await page.waitForSelector('#result:not([hidden])', { timeout: 120_000 })
    .then(() => true).catch(() => false);
  check('취소한 뒤에도 다음 변환이 정상 완료된다', () => assert.equal(recovered, true));
}

// -------------------------------------------- 6. 변환할 수 없는 브라우저는 파일을 받지 않는다

/** 브라우저 기능을 지워 놓고 페이지를 연다. */
async function openWith(disable) {
  const p = await browser.newPage();
  p.on('pageerror', (e) => failures.push(`pageerror: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') failures.push(`console error: ${m.text()}`); });
  await p.addInitScript(disable);
  await p.goto(`${base}/public/index.html`);
  await p.waitForFunction(() => globalThis.__app !== undefined);
  return p;
}

console.log('\n[6] WebCodecs가 없는 브라우저: 파일을 받지 않고 진짜 이유를 말한다');
{
  const p = await openWith(() => {
    delete globalThis.VideoEncoder;
    delete globalThis.VideoDecoder;
  });

  const before = await p.evaluate(() => ({
    bannerShown: !document.getElementById('unsupported').hidden,
    bannerRole: document.getElementById('unsupported').getAttribute('role'),
    focusable: document.getElementById('dropzone').hasAttribute('tabindex'),
    ariaDisabled: document.getElementById('dropzone').getAttribute('aria-disabled'),
  }));
  check('변환할 수 없는 브라우저임을 알린다', () => assert.equal(before.bannerShown, true));
  check('그 알림이 보조기술에 즉시 전달된다', () => assert.equal(before.bannerRole, 'alert'));
  check('드롭존에 탭이 멈추지 않는다', () => assert.equal(before.focusable, false));
  check('드롭존이 비활성으로 표시된다', () => assert.equal(before.ariaDisabled, 'true'));

  // 파일을 강제로 밀어 넣어도 변환 패널이 열려선 안 된다.
  await p.setInputFiles('#fileInput', join(fixtures, 'alpha-vp9.webm'));
  await p.waitForTimeout(1500);
  const after = await p.evaluate(() => ({
    panelShown: !document.getElementById('panel').hidden,
    loadError: document.getElementById('loadError').hidden ? null : document.getElementById('loadError').textContent,
  }));
  check('파일을 밀어 넣어도 변환 패널을 열지 않는다', () => assert.equal(after.panelShown, false));
  check('코덱이 아니라 브라우저를 탓한다', () => {
    assert.ok(after.loadError, '이유를 말하지 않았다');
    assert.match(after.loadError, /WebCodecs/);
    assert.doesNotMatch(after.loadError, /코덱입니다/);
  });
  await p.close();
}

// ------------------------------- 7. 인코더가 하나도 없는 브라우저 (WebCodecs는 있다)

console.log('\n[7] 인코더가 하나도 없는 브라우저: 누를 수 없는 변환 버튼을 남기지 않는다');
{
  const p = await openWith(() => {
    globalThis.VideoEncoder.isConfigSupported = async (config) => ({ supported: false, config });
  });

  const s = await p.evaluate(() => ({
    support: globalThis.__app.state.support,
    bannerShown: !document.getElementById('unsupported').hidden,
  }));
  check('어떤 인코더도 없으면 지원하지 않는다고 판정한다', () => assert.equal(s.support.ok, false));
  check('그 사실을 알린다', () => assert.equal(s.bannerShown, true));

  await p.setInputFiles('#fileInput', join(fixtures, 'alpha-vp9.webm'));
  await p.waitForTimeout(1500);
  const after = await p.evaluate(() => ({
    panelShown: !document.getElementById('panel').hidden,
    loadError: document.getElementById('loadError').hidden ? null : document.getElementById('loadError').textContent,
  }));
  check('변환 패널을 열지 않는다', () => assert.equal(after.panelShown, false));
  check('인코딩할 수 없다는 이유를 밝힌다', () => assert.match(after.loadError ?? '', /인코딩/));
  await p.close();
}

// ------------------------------------------- 8. 진행 상태를 보조기술에도 알린다

console.log('\n[8] 진행 상태를 눈이 아니라 보조기술에도 알린다');
{
  await page.goto(`${base}/public/index.html`);
  await page.waitForFunction(() => globalThis.__app !== undefined);
  await page.setInputFiles('#fileInput', join(fixtures, 'alpha-vp9.webm'));
  await page.waitForSelector('#panel:not([hidden])', { timeout: 30_000 });

  const idle = await page.evaluate(() => ({
    role: document.getElementById('progressBar').getAttribute('role'),
    min: document.getElementById('progressBar').getAttribute('aria-valuemin'),
    max: document.getElementById('progressBar').getAttribute('aria-valuemax'),
  }));
  check('진행률 막대가 progressbar로 노출된다', () => assert.equal(idle.role, 'progressbar'));
  check('진행률 범위를 0~100으로 선언한다', () => {
    assert.equal(idle.min, '0');
    assert.equal(idle.max, '100');
  });

  // 진행률이 처음 오르는 자리에서 상태를 훔쳐본다. 변환은 그대로 끝까지 간다.
  await page.click('#convertBtn');
  const busy = await page.evaluate(() => new Promise((resolve, reject) => {
    const text = document.getElementById('progressText');
    const observer = new MutationObserver(() => {
      if (Number.parseInt(text.textContent, 10) <= 0) return;
      observer.disconnect();
      clearTimeout(timer);
      resolve({
        valueNow: document.getElementById('progressBar').getAttribute('aria-valuenow'),
        busy: document.getElementById('panel').getAttribute('aria-busy'),
      });
    });
    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error('진행률이 오르지 않았다'));
    }, 60_000);
    observer.observe(text, { childList: true, characterData: true, subtree: true });
  }));

  check('변환 중에는 진행률을 aria-valuenow로 읽어 준다', () => {
    assert.ok(Number.parseInt(busy.valueNow, 10) > 0, `aria-valuenow=${busy.valueNow}`);
  });
  check('변환 중에는 패널을 aria-busy로 표시한다', () => assert.equal(busy.busy, 'true'));

  await page.waitForSelector('#result:not([hidden])', { timeout: 120_000 });
  const done = await page.evaluate(() => ({
    busy: document.getElementById('panel').getAttribute('aria-busy'),
    valueNow: document.getElementById('progressBar').getAttribute('aria-valuenow'),
  }));
  check('변환이 끝나면 aria-busy를 내린다', () => assert.equal(done.busy, 'false'));
  check('변환이 끝나면 진행률이 100이다', () => assert.equal(done.valueNow, '100'));
}

// ----------------------------------------------- 9. CSP가 실제로 강제되고 있는가

console.log('\n[9] 콘텐츠 보안 정책이 켜져 있다');
{
  // 일부러 정책을 어겨 본다. 위반은 콘솔 에러를 남기므로 이 페이지의 콘솔은 듣지 않는다.
  const p = await browser.newPage();
  await p.goto(`${base}/public/index.html`);
  await p.waitForFunction(() => globalThis.__app !== undefined);

  const probe = await p.evaluate(() => new Promise((resolve) => {
    let violated = null;
    document.addEventListener('securitypolicyviolation', (e) => { violated = e.violatedDirective; });

    const node = document.createElement('div');
    node.setAttribute('style', 'color: rgb(1, 2, 3)');
    document.body.append(node);
    const applied = node.style.color;
    node.remove();

    setTimeout(() => resolve({ violated, applied }), 100);
  }));

  // 정책이 꺼져 있으면(오타로 meta가 무시되면) 이 인라인 style이 그대로 먹는다.
  check('인라인 style 속성이 차단된다', () => assert.equal(probe.applied, ''));
  check('위반이 style-src로 보고된다', () => assert.match(probe.violated ?? '', /style-src/));
  await p.close();
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
