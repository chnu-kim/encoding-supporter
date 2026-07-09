import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALPHA_PIXEL_FORMATS,
  OUTPUT_FORMATS,
  MAX_INPUT_BYTES,
  analyzeAlpha,
  getOutputFormat,
  recommendOutputFormat,
  toOutputFileName,
  validateInput,
  parseHexColor,
  planConversion,
  formatBytes,
} from '../public/lib/core.js';

test('ALPHA_PIXEL_FORMATS는 WebCodecs 알파 픽셀 포맷만 담는다', () => {
  for (const f of ['I420A', 'I420AP10', 'I422A', 'I444A', 'RGBA', 'BGRA']) {
    assert.ok(ALPHA_PIXEL_FORMATS.has(f), `${f}가 빠졌다`);
  }
  for (const f of ['I420', 'I422', 'I444', 'NV12', 'RGBX', 'BGRX']) {
    assert.ok(!ALPHA_PIXEL_FORMATS.has(f), `${f}는 알파가 없다`);
  }
});

// ---------------------------------------------------------------- analyzeAlpha

test('analyzeAlpha: 알파 없는 포맷은 배경 합성이 필요 없다', () => {
  const r = analyzeAlpha({ format: 'I420', transparentPixels: 0, partialAlphaPixels: 0, totalPixels: 76800 });
  assert.equal(r.hasAlphaChannel, false);
  assert.equal(r.needsBackground, false);
  assert.equal(r.transparentRatio, 0);
});

test('analyzeAlpha: 투명 영역이 있는 I420A는 배경 합성이 필요하다', () => {
  // 실측한 alpha-vp9.webm 첫 프레임 값
  const r = analyzeAlpha({
    format: 'I420A', transparentPixels: 56301, partialAlphaPixels: 911, totalPixels: 76800,
  });
  assert.equal(r.hasAlphaChannel, true);
  assert.equal(r.needsBackground, true);
  // 완전 투명 56301 + 경계의 반투명 911 = 57212 / 76800
  assert.ok(Math.abs(r.transparentRatio - 0.7449) < 0.001, `실제: ${r.transparentRatio}`);
});

test('analyzeAlpha: 알파 채널이 있어도 실제로 전부 불투명하면 합성이 필요 없다', () => {
  const r = analyzeAlpha({ format: 'I420A', transparentPixels: 0, partialAlphaPixels: 0, totalPixels: 76800 });
  assert.equal(r.hasAlphaChannel, true);
  assert.equal(r.needsBackground, false);
});

test('analyzeAlpha: 인코딩 노이즈 수준의 반투명 픽셀은 무시한다', () => {
  const r = analyzeAlpha({ format: 'I420A', transparentPixels: 0, partialAlphaPixels: 5, totalPixels: 76800 });
  assert.equal(r.needsBackground, false, '0.007%는 노이즈다');
});

test('analyzeAlpha: 손실 인코딩으로 alpha=1이 된 픽셀도 투명으로 센다', () => {
  // out-vp8.webm 왕복 결과: 완전 투명이던 코너가 alpha=1로 재현된다.
  const r = analyzeAlpha({ format: 'I420A', transparentPixels: 0, partialAlphaPixels: 53800, totalPixels: 76800 });
  assert.equal(r.needsBackground, true);
});

test('analyzeAlpha: format이 null이면(디코더가 미공개) 픽셀 결과로 판단한다', () => {
  const opaque = analyzeAlpha({ format: null, transparentPixels: 0, partialAlphaPixels: 0, totalPixels: 100 });
  assert.equal(opaque.needsBackground, false);

  const transparent = analyzeAlpha({ format: null, transparentPixels: 50, partialAlphaPixels: 0, totalPixels: 100 });
  assert.equal(transparent.hasAlphaChannel, true);
  assert.equal(transparent.needsBackground, true);
});

test('analyzeAlpha: totalPixels가 0이면 0으로 나누지 않는다', () => {
  const r = analyzeAlpha({ format: 'I420A', transparentPixels: 0, partialAlphaPixels: 0, totalPixels: 0 });
  assert.equal(r.transparentRatio, 0);
  assert.equal(r.needsBackground, false);
});

// -------------------------------------------------------------- output formats

test('OUTPUT_FORMATS: VP8 WebM만 알파를 담을 수 있다', () => {
  assert.equal(OUTPUT_FORMATS['webm-vp8'].supportsAlpha, true);
  assert.equal(OUTPUT_FORMATS['webm-vp8'].videoCodec, 'vp8');
  assert.equal(OUTPUT_FORMATS['mp4-avc'].supportsAlpha, false);
  assert.equal(OUTPUT_FORMATS['mp4-avc'].videoCodec, 'avc');
});

test('getOutputFormat: 모르는 id는 거부한다', () => {
  assert.equal(getOutputFormat('webm-vp8').extension, 'webm');
  assert.throws(() => getOutputFormat('webm-vp9'), /지원하지 않는/);
});

test('recommendOutputFormat: 투명 영역이 있으면 알파를 지킬 수 있는 VP8을 고른다', () => {
  const id = recommendOutputFormat({ hasAlphaChannel: true, needsBackground: true });
  assert.equal(id, 'webm-vp8');
});

test('recommendOutputFormat: 불투명하면 호환성이 가장 넓은 MP4를 고른다', () => {
  assert.equal(recommendOutputFormat({ hasAlphaChannel: false, needsBackground: false }), 'mp4-avc');
  assert.equal(recommendOutputFormat({ hasAlphaChannel: true, needsBackground: false }), 'mp4-avc');
});

// ------------------------------------------------------------------- filenames

test('toOutputFileName: mp4는 확장자만 바꾼다', () => {
  assert.equal(toOutputFileName('overlay.webm', 'mp4-avc'), 'overlay.mp4');
  assert.equal(toOutputFileName('OVERLAY.WEBM', 'mp4-avc'), 'OVERLAY.mp4');
  assert.equal(toOutputFileName('my.desk.anim.webm', 'mp4-avc'), 'my.desk.anim.mp4');
  assert.equal(toOutputFileName('noext', 'mp4-avc'), 'noext.mp4');
});

test('toOutputFileName: webm→webm은 원본을 덮어쓰지 않도록 접미사를 붙인다', () => {
  assert.equal(toOutputFileName('overlay.webm', 'webm-vp8'), 'overlay-vp8.webm');
  assert.equal(toOutputFileName('clip.mkv', 'webm-vp8'), 'clip-vp8.webm');
});

test('toOutputFileName: 경로 구분자와 앞뒤 공백을 제거한다', () => {
  assert.equal(toOutputFileName('a/b/c.webm', 'mp4-avc'), 'c.mp4');
  assert.equal(toOutputFileName('a\\b\\c.webm', 'mp4-avc'), 'c.mp4');
  assert.equal(toOutputFileName('  spaced.webm  ', 'mp4-avc'), 'spaced.mp4');
});

test('toOutputFileName: 이름이 비면 기본값을 쓴다', () => {
  assert.equal(toOutputFileName('', 'mp4-avc'), 'converted.mp4');
  assert.equal(toOutputFileName('   ', 'mp4-avc'), 'converted.mp4');
  assert.equal(toOutputFileName('.webm', 'webm-vp8'), 'converted-vp8.webm');
});

// ------------------------------------------------------------------ validation

test('validateInput: 정상 webm을 통과시킨다', () => {
  const r = validateInput({ name: 'a.webm', size: 1024 });
  assert.equal(r.ok, true);
  assert.equal(r.warning, undefined);
});

test('validateInput: 빈 파일을 거부한다', () => {
  const r = validateInput({ name: 'a.webm', size: 0 });
  assert.equal(r.ok, false);
  assert.match(r.error, /비어/);
});

test('validateInput: 용량 상한을 넘으면 거부한다', () => {
  const r = validateInput({ name: 'a.webm', size: MAX_INPUT_BYTES + 1 });
  assert.equal(r.ok, false);
  assert.match(r.error, /너무 큽니다/);
});

test('validateInput: webm이 아니어도 통과시키되 경고한다', () => {
  const r = validateInput({ name: 'a.mkv', size: 1024 });
  assert.equal(r.ok, true);
  assert.match(r.warning, /webm/i);
});

// ---------------------------------------------------------------------- colors

test('parseHexColor: 3자리와 6자리 hex를 파싱한다', () => {
  assert.deepEqual(parseHexColor('#00FF00'), { r: 0, g: 255, b: 0 });
  assert.deepEqual(parseHexColor('#0f0'), { r: 0, g: 255, b: 0 });
  assert.deepEqual(parseHexColor('ffffff'), { r: 255, g: 255, b: 255 });
});

test('parseHexColor: 잘못된 값은 null이다', () => {
  for (const bad of ['', '#', '#12', '#12345', 'zzzzzz', null, undefined]) {
    assert.equal(parseHexColor(bad), null, `${bad}는 거부해야 한다`);
  }
});

// -------------------------------------------------------------- planConversion

const TRANSPARENT = { hasAlphaChannel: true, needsBackground: true, transparentRatio: 0.73 };
const OPAQUE = { hasAlphaChannel: false, needsBackground: false, transparentRatio: 0 };

test('planConversion: 투명 영상 → VP8 WebM은 알파를 그대로 지킨다', () => {
  const p = planConversion({ alpha: TRANSPARENT, formatId: 'webm-vp8', backgroundColor: '#00ff00' });
  assert.equal(p.alpha, 'keep');
  assert.equal(p.fill, null, '알파를 지키므로 배경을 깔지 않는다');
  assert.equal(p.videoCodec, 'vp8');
  assert.equal(p.audioCodec, 'opus');
});

test('planConversion: 투명 영상 → MP4는 배경색을 깔아 크로마키용으로 만든다', () => {
  const p = planConversion({ alpha: TRANSPARENT, formatId: 'mp4-avc', backgroundColor: '#00FF00' });
  assert.equal(p.alpha, 'discard');
  assert.equal(p.fill, '#00ff00');
  assert.equal(p.videoCodec, 'avc');
  assert.equal(p.audioCodec, 'aac');
});

test('planConversion: 투명 영상 → MP4에서 잘못된 색은 기본 그린으로 대체한다', () => {
  const p = planConversion({ alpha: TRANSPARENT, formatId: 'mp4-avc', backgroundColor: 'nope' });
  assert.equal(p.fill, '#00ff00');
});

test('planConversion: 불투명 영상은 어떤 포맷이든 배경을 깔지 않는다', () => {
  for (const formatId of ['webm-vp8', 'mp4-avc']) {
    const p = planConversion({ alpha: OPAQUE, formatId, backgroundColor: '#00ff00' });
    assert.equal(p.fill, null, `${formatId}에서 불필요한 합성이 일어났다`);
    assert.equal(p.alpha, 'discard');
  }
});

test('planConversion: 알파 채널은 있으나 투명 영역이 없으면 VP8도 알파를 버린다', () => {
  const p = planConversion({
    alpha: { hasAlphaChannel: true, needsBackground: false, transparentRatio: 0 },
    formatId: 'webm-vp8',
    backgroundColor: '#00ff00',
  });
  assert.equal(p.alpha, 'discard', '쓸데없이 알파 평면을 인코딩하지 않는다');
  assert.equal(p.fill, null);
});

// ----------------------------------------------------------------- formatBytes

test('formatBytes: 사람이 읽는 단위로 만든다', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1024 * 1024 * 3.5), '3.5 MB');
  assert.equal(formatBytes(1024 ** 3), '1.0 GB');
});
