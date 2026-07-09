import {
  OUTPUT_FORMATS, formatBytes, getOutputFormat, planConversion,
  recommendOutputFormat, toOutputFileName, validateInput,
} from './lib/core.js';
import { checkBrowserSupport, convertFile, inspect } from './lib/convert.js';

const $ = (id) => document.getElementById(id);

const el = {
  unsupported: $('unsupported'),
  dropzone: $('dropzone'),
  fileInput: $('fileInput'),
  loadError: $('loadError'),
  panel: $('panel'),
  preview: $('preview'),
  metaName: $('metaName'),
  metaSize: $('metaSize'),
  metaResolution: $('metaResolution'),
  metaDuration: $('metaDuration'),
  metaCodec: $('metaCodec'),
  metaAlpha: $('metaAlpha'),
  inputWarning: $('inputWarning'),
  fmtWebm: $('fmtWebm'),
  fmtMp4: $('fmtMp4'),
  badgeWebm: $('badgeWebm'),
  badgeMp4: $('badgeMp4'),
  descWebm: $('descWebm'),
  bgRow: $('bgRow'),
  bgColor: $('bgColor'),
  convertBtn: $('convertBtn'),
  cancelBtn: $('cancelBtn'),
  resetBtn: $('resetBtn'),
  progressRow: $('progressRow'),
  progressFill: $('progressFill'),
  progressText: $('progressText'),
  error: $('error'),
  result: $('result'),
  resultVideo: $('resultVideo'),
  resultMeta: $('resultMeta'),
  resultWarning: $('resultWarning'),
  resultHint: $('resultHint'),
  downloadLink: $('downloadLink'),
};

const state = {
  file: null,
  info: null,
  backgroundColor: '#00ff00',
  abort: null,
  objectUrl: null,
  support: null,
};

// ------------------------------------------------------------------ helpers

const show = (node, on = true) => { node.hidden = !on; };

function setNotice(node, message) {
  if (message) {
    node.textContent = message;
    show(node, true);
  } else {
    node.textContent = '';
    show(node, false);
  }
}

function formatDuration(seconds) {
  if (!(seconds > 0)) return '—';
  const total = Math.round(seconds * 10) / 10;
  if (total < 60) return `${total.toFixed(1)}초`;
  const m = Math.floor(total / 60);
  const s = Math.round(total % 60);
  return `${m}분 ${s}초`;
}

function revokeObjectUrl() {
  if (state.objectUrl) {
    URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = null;
  }
}

const selectedFormatId = () => (el.fmtWebm.checked ? 'webm-vp8' : 'mp4-avc');

// ----------------------------------------------------------------- rendering

function drawPreview(bitmap) {
  const canvas = el.preview;
  const max = 160;
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));

  const ctx = canvas.getContext('2d', { alpha: true });
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
}

/** 투명 여부에 따라 추천 배지와 배경색 UI를 갱신한다. */
function syncFormatUi() {
  const { alpha } = state.info;
  const recommended = recommendOutputFormat(alpha);

  show(el.badgeWebm, recommended === 'webm-vp8');
  show(el.badgeMp4, recommended === 'mp4-avc');

  el.descWebm.textContent = alpha.needsBackground
    ? '투명 배경을 그대로 유지합니다. VP9를 거부하는 프로그램도 VP8은 읽는 경우가 많습니다.'
    : '이 영상에는 투명 영역이 없어 MP4와 화면이 같습니다.';

  // 투명 영상을 MP4로 뽑을 때만 배경색을 물어본다.
  show(el.bgRow, alpha.needsBackground && selectedFormatId() === 'mp4-avc');
}

function renderInfo(file, info, warning) {
  drawPreview(info.preview);

  el.metaName.textContent = file.name;
  el.metaSize.textContent = formatBytes(file.size);
  el.metaResolution.textContent = `${info.width} × ${info.height}`;
  el.metaDuration.textContent = formatDuration(info.duration);
  el.metaCodec.textContent = [info.videoCodec, info.audioCodec].filter(Boolean).join(' + ');
  el.metaAlpha.textContent = info.alpha.needsBackground
    ? `있음 (${Math.round(info.alpha.transparentRatio * 100)}% 투명)`
    : info.alpha.hasAlphaChannel ? '알파 채널은 있으나 전부 불투명' : '없음';

  setNotice(el.inputWarning, warning ?? '');

  const recommended = recommendOutputFormat(info.alpha);
  el.fmtWebm.checked = recommended === 'webm-vp8';
  el.fmtMp4.checked = recommended === 'mp4-avc';

  // 브라우저가 못 쓰는 인코더는 고르지 못하게 막는다.
  el.fmtWebm.disabled = !state.support.vp8Alpha;
  el.fmtMp4.disabled = !state.support.avc;
  if (el.fmtWebm.disabled) el.fmtMp4.checked = true;
  if (el.fmtMp4.disabled) el.fmtWebm.checked = true;

  syncFormatUi();
  show(el.panel, true);
}

function setProgress(value) {
  const pct = Math.round(value * 100);
  el.progressFill.style.width = `${pct}%`;
  el.progressText.textContent = `${pct}%`;
}

function setBusy(busy) {
  el.convertBtn.disabled = busy;
  el.resetBtn.disabled = busy;
  el.fmtWebm.disabled = busy || !state.support.vp8Alpha;
  el.fmtMp4.disabled = busy || !state.support.avc;
  show(el.cancelBtn, busy);
  show(el.progressRow, busy);
}

// -------------------------------------------------------------------- flows

async function loadFile(file) {
  revokeObjectUrl();
  show(el.result, false);
  show(el.panel, false);
  setNotice(el.error, '');
  setNotice(el.loadError, '');
  setNotice(el.inputWarning, '');

  const check = validateInput({ name: file.name, size: file.size });
  if (!check.ok) {
    setNotice(el.loadError, check.error);
    return;
  }

  state.file = file;
  try {
    state.info = await inspect(file);
  } catch (error) {
    setNotice(el.loadError, `파일을 읽지 못했습니다. ${error.message}`);
    return;
  }
  renderInfo(file, state.info, check.warning);
}

async function runConversion() {
  const formatId = selectedFormatId();
  const plan = planConversion({
    alpha: state.info.alpha,
    formatId,
    backgroundColor: state.backgroundColor,
  });

  if (formatId === 'mp4-avc' && state.info.audioCodec && !state.support.aac) {
    setNotice(el.inputWarning, '이 브라우저는 AAC를 인코딩하지 못해 MP4에서 소리가 빠질 수 있습니다.');
  }

  setNotice(el.error, '');
  show(el.result, false);
  setProgress(0);
  setBusy(true);

  state.abort = new AbortController();
  const started = performance.now();

  try {
    const { blob, droppedAudio } = await convertFile(state.file, plan, {
      onProgress: setProgress,
      signal: state.abort.signal,
    });
    setProgress(1);
    showResult(blob, plan, droppedAudio, performance.now() - started);
  } catch (error) {
    if (error.name === 'AbortError') {
      setNotice(el.error, '변환을 취소했습니다.');
    } else {
      setNotice(el.error, `변환에 실패했습니다. ${error.message}`);
    }
  } finally {
    setBusy(false);
    state.abort = null;
  }
}

function showResult(blob, plan, droppedAudio, elapsedMs) {
  revokeObjectUrl();
  state.objectUrl = URL.createObjectURL(blob);

  const name = toOutputFileName(state.file.name, plan.format.id);
  el.downloadLink.href = state.objectUrl;
  el.downloadLink.download = name;
  el.downloadLink.textContent = `${name} 다운로드`;

  el.resultVideo.src = state.objectUrl;
  el.resultMeta.textContent =
    `${plan.format.label} · ${formatBytes(blob.size)} · ${(elapsedMs / 1000).toFixed(1)}초 걸림`;

  el.resultHint.textContent = plan.alpha === 'keep'
    ? '투명 배경이 그대로 남아 있습니다. 그대로 Shoost 레이어에 올리세요.'
    : plan.fill
      ? `배경을 ${plan.fill}로 칠했습니다. Shoost에서 크로마키로 이 색을 지우세요.`
      : '';

  setNotice(el.resultWarning, droppedAudio ? '이 브라우저에서 오디오를 인코딩하지 못해 소리가 빠졌습니다.' : '');
  show(el.result, true);
  el.result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function reset() {
  revokeObjectUrl();
  state.file = null;
  state.info = null;
  el.fileInput.value = '';
  show(el.panel, false);
  show(el.result, false);
  setNotice(el.error, '');
  setNotice(el.loadError, '');
}

// ------------------------------------------------------------------- events

el.dropzone.addEventListener('click', () => el.fileInput.click());
el.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    el.fileInput.click();
  }
});

for (const type of ['dragenter', 'dragover']) {
  el.dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    el.dropzone.classList.add('is-over');
  });
}
for (const type of ['dragleave', 'drop']) {
  el.dropzone.addEventListener(type, () => el.dropzone.classList.remove('is-over'));
}
el.dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (file) void loadFile(file);
});

el.fileInput.addEventListener('change', () => {
  const file = el.fileInput.files?.[0];
  if (file) void loadFile(file);
});

for (const radio of [el.fmtWebm, el.fmtMp4]) {
  radio.addEventListener('change', () => {
    if (state.info) syncFormatUi();
  });
}

for (const swatch of document.querySelectorAll('.swatch')) {
  swatch.addEventListener('click', () => {
    state.backgroundColor = swatch.dataset.color;
    el.bgColor.value = swatch.dataset.color;
    for (const s of document.querySelectorAll('.swatch')) s.classList.toggle('is-selected', s === swatch);
  });
}

el.bgColor.addEventListener('input', () => {
  state.backgroundColor = el.bgColor.value;
  for (const s of document.querySelectorAll('.swatch')) {
    s.classList.toggle('is-selected', s.dataset.color === el.bgColor.value);
  }
});

el.convertBtn.addEventListener('click', () => void runConversion());
el.cancelBtn.addEventListener('click', () => state.abort?.abort());
el.resetBtn.addEventListener('click', reset);

// --------------------------------------------------------------------- boot

state.support = await checkBrowserSupport();
if (!state.support.ok) {
  setNotice(el.unsupported, state.support.reason);
  el.dropzone.setAttribute('aria-disabled', 'true');
  el.dropzone.style.pointerEvents = 'none';
  el.dropzone.style.opacity = '.5';
}

// E2E 검증용 훅. 브라우저에서 직접 쓰는 API는 아니다.
globalThis.__app = { state, loadFile, runConversion, OUTPUT_FORMATS, getOutputFormat };
