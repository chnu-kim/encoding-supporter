/**
 * webm 변환의 순수 로직. DOM도 mediabunny도 참조하지 않으므로 node에서 그대로 테스트한다.
 */

/** 알파를 담을 수 있는 WebCodecs VideoPixelFormat. */
export const ALPHA_PIXEL_FORMATS = new Set([
  'I420A', 'I420AP10', 'I420AP12',
  'I422A', 'I422AP10', 'I422AP12',
  'I444A', 'I444AP10', 'I444AP12',
  'RGBA', 'BGRA',
]);

/** 브라우저 메모리 안에서 처리할 수 있는 현실적인 상한. */
export const MAX_INPUT_BYTES = 2 * 1024 ** 3;

/**
 * Shoost가 받아들이는 두 출구.
 *
 * VP8 WebM은 알파를 그대로 담을 수 있어 투명 소품(마이크, 책상, 이펙트)에 쓴다.
 * MP4는 알파를 담지 못하므로 투명 영상은 단색 배경 위에 구워서 크로마키로 넘긴다.
 */
export const OUTPUT_FORMATS = {
  'webm-vp8': {
    id: 'webm-vp8',
    label: 'WebM (VP8)',
    extension: 'webm',
    suffix: '-vp8',
    mimeType: 'video/webm',
    videoCodec: 'vp8',
    audioCodec: 'opus',
    supportsAlpha: true,
  },
  'mp4-avc': {
    id: 'mp4-avc',
    label: 'MP4 (H.264)',
    extension: 'mp4',
    suffix: '',
    mimeType: 'video/mp4',
    videoCodec: 'avc',
    audioCodec: 'aac',
    supportsAlpha: false,
  },
};

/** 인코딩 경계에서 생기는 반투명 픽셀을 투명 의도로 오인하지 않기 위한 하한. */
const TRANSPARENCY_THRESHOLD = 0.001;

const DEFAULT_BACKGROUND = '#00ff00';

/**
 * 첫 프레임 조사 결과로 투명 영역이 실제로 있는지 판정한다.
 *
 * 알파 채널이 있다고 해서 투명 영역이 있는 것은 아니고, 반대로 디코더가 format을
 * 공개하지 않는 경우도 있어(`null`) 픽셀 표본을 함께 본다.
 */
export function analyzeAlpha({ format, transparentPixels = 0, partialAlphaPixels = 0, totalPixels = 0 }) {
  const transparentRatio = totalPixels > 0
    ? (transparentPixels + partialAlphaPixels) / totalPixels
    : 0;

  const formatHasAlpha = format != null && ALPHA_PIXEL_FORMATS.has(format);
  const pixelsHaveAlpha = transparentRatio >= TRANSPARENCY_THRESHOLD;

  return {
    hasAlphaChannel: formatHasAlpha || pixelsHaveAlpha,
    transparentRatio,
    needsBackground: pixelsHaveAlpha,
  };
}

export function getOutputFormat(id) {
  const format = OUTPUT_FORMATS[id];
  if (!format) throw new Error(`지원하지 않는 출력 형식입니다: ${id}`);
  return format;
}

/** 투명 영역이 있으면 그것을 지킬 수 있는 포맷을, 아니면 가장 널리 열리는 포맷을 고른다. */
export function recommendOutputFormat({ needsBackground }) {
  return needsBackground ? 'webm-vp8' : 'mp4-avc';
}

/** 출력 파일명. 확장자가 그대로면 원본을 덮어쓸 수 있으므로 접미사를 붙인다. */
export function toOutputFileName(name, formatId) {
  const { extension, suffix } = getOutputFormat(formatId);
  const base = String(name ?? '').trim().split(/[/\\]/).pop() ?? '';
  const stem = base.replace(/\.[^.]*$/, '') || 'converted';
  return `${stem}${suffix}.${extension}`;
}

export function validateInput({ name, size }) {
  if (!(size > 0)) {
    return { ok: false, error: '파일이 비어 있습니다.' };
  }
  if (size > MAX_INPUT_BYTES) {
    return { ok: false, error: `파일이 너무 큽니다. 최대 ${formatBytes(MAX_INPUT_BYTES)}까지 처리합니다.` };
  }
  if (!/\.webm$/i.test(String(name ?? ''))) {
    return { ok: true, warning: 'webm 파일이 아닙니다. 변환을 시도하지만 실패할 수 있습니다.' };
  }
  return { ok: true };
}

/** `#rgb`, `#rrggbb`, 접두사 없는 형태를 받는다. 그 외에는 null. */
export function parseHexColor(value) {
  const hex = String(value ?? '').trim().replace(/^#/, '');
  if (!/^([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) return null;

  const full = hex.length === 3 ? hex.replace(/./g, (c) => c + c) : hex;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

function normalizeHex(value) {
  const rgb = parseHexColor(value);
  if (rgb === null) return DEFAULT_BACKGROUND;
  return `#${[rgb.r, rgb.g, rgb.b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * 알파 판정과 출력 포맷을 합쳐 인코딩 계획을 세운다.
 *
 * `fill`이 있으면 그 색으로 배경을 채운 뒤 프레임을 얹고, 없으면 프레임을 그대로 넘긴다.
 * 투명 영역이 없으면 알파 평면을 인코딩할 이유가 없으므로 VP8이라도 버린다.
 */
export function planConversion({ alpha, formatId, backgroundColor }) {
  const format = getOutputFormat(formatId);
  const keepAlpha = format.supportsAlpha && alpha.needsBackground;
  const mustFlatten = !format.supportsAlpha && alpha.needsBackground;

  return {
    format,
    videoCodec: format.videoCodec,
    audioCodec: format.audioCodec,
    alpha: keepAlpha ? 'keep' : 'discard',
    fill: mustFlatten ? normalizeHex(backgroundColor) : null,
  };
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${Math.round(n)} B`;

  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${UNITS[unit]}`;
}
