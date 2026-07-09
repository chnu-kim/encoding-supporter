/**
 * mediabunny를 감싸는 브라우저 전용 계층. 판정과 계획은 core.js가 맡는다.
 */
import {
  Input, Output, Conversion, ALL_FORMATS, BlobSource, BufferTarget,
  WebMOutputFormat, Mp4OutputFormat, VideoSampleSink,
  QUALITY_HIGH, canEncodeVideo, canEncodeAudio,
} from '../vendor/mediabunny.min.mjs';

import { analyzeAlpha } from './core.js';

/** 알파 측정은 축소본으로 한다. 4K 프레임을 통째로 훑을 이유가 없다. */
const MEASURE_WIDTH = 256;

/** 투명도를 확인할 재생 위치(전체 길이 대비 비율). */
const SAMPLE_POINTS = [0, 0.35, 0.7];

export async function checkBrowserSupport() {
  if (typeof VideoDecoder === 'undefined' || typeof VideoEncoder === 'undefined') {
    return { ok: false, reason: '이 브라우저는 WebCodecs를 지원하지 않습니다. Chrome, Edge 또는 Safari 17 이상을 사용해 주세요.' };
  }

  const [vp8Alpha, avc, aac] = await Promise.all([
    canEncodeVideo('vp8', { width: 640, height: 480, alpha: 'keep' }),
    canEncodeVideo('avc', { width: 640, height: 480 }),
    canEncodeAudio('aac'),
  ]);

  if (!vp8Alpha && !avc) {
    return { ok: false, reason: '이 브라우저는 VP8도 H.264도 인코딩할 수 없습니다.' };
  }
  return { ok: true, vp8Alpha, avc, aac };
}

function measureAlpha(sample) {
  const scale = Math.min(1, MEASURE_WIDTH / sample.displayWidth);
  const w = Math.max(1, Math.round(sample.displayWidth * scale));
  const h = Math.max(1, Math.round(sample.displayHeight * scale));

  const ctx = new OffscreenCanvas(w, h).getContext('2d', { alpha: true, willReadFrequently: true });
  ctx.clearRect(0, 0, w, h);

  const frame = sample.toVideoFrame();
  ctx.drawImage(frame, 0, 0, w, h);
  frame.close();

  const { data } = ctx.getImageData(0, 0, w, h);
  let transparent = 0;
  let partial = 0;
  for (let i = 3; i < data.length; i += 4) {
    // 손실 인코딩을 거치면 완전 투명이던 픽셀이 alpha=1~2로 돌아온다.
    if (data[i] <= 2) transparent += 1;
    else if (data[i] < 255) partial += 1;
  }

  return { format: sample.format, transparentPixels: transparent, partialAlphaPixels: partial, totalPixels: w * h };
}

async function toPreview(sample) {
  const canvas = new OffscreenCanvas(sample.displayWidth, sample.displayHeight);
  const ctx = canvas.getContext('2d', { alpha: true });
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  sample.draw(ctx, 0, 0);
  return canvas.transferToImageBitmap();
}

/**
 * 입력을 열어 해상도, 길이, 투명도를 조사한다. 가장 투명한 표본을 기준으로 판정한다.
 */
export async function inspect(file) {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('영상 트랙이 없습니다.');
    if (!(await track.canDecode())) {
      throw new Error(`이 브라우저가 디코드할 수 없는 코덱입니다: ${await track.getCodec()}`);
    }

    const duration = await track.computeDuration();
    const audioTrack = await input.getPrimaryAudioTrack();

    // 컨테이너가 알파를 담을 수 없다고 하면 여러 프레임을 훑을 이유가 없다.
    // 담을 수 있다면 페이드인처럼 첫 프레임만 불투명한 영상을 놓치지 않도록 여러 지점을 본다.
    const canBeTransparent = await track.canBeTransparent();
    const timestamps = canBeTransparent && duration > 0.1
      ? SAMPLE_POINTS.map((p) => duration * p)
      : [0];

    const sink = new VideoSampleSink(track);
    let best = null;
    let preview = null;

    for await (const sample of sink.samplesAtTimestamps(timestamps)) {
      if (!sample) continue;
      const stat = measureAlpha(sample);
      const alpha = analyzeAlpha(stat);
      if (best === null || alpha.transparentRatio > best.alpha.transparentRatio) {
        best = { stat, alpha };
      }
      if (preview === null) preview = await toPreview(sample);
      sample.close();
    }

    if (best === null) throw new Error('프레임을 읽지 못했습니다.');

    return {
      alpha: best.alpha,
      preview,
      width: await track.getDisplayWidth(),
      height: await track.getDisplayHeight(),
      duration,
      videoCodec: await track.getCodec(),
      audioCodec: audioTrack ? await audioTrack.getCodec() : null,
    };
  } finally {
    input.dispose();
  }
}

function buildOutputFormat(formatId) {
  return formatId === 'webm-vp8'
    ? new WebMOutputFormat()
    // moov를 앞으로 보내 다른 프로그램이 파일을 끝까지 읽지 않아도 열 수 있게 한다.
    : new Mp4OutputFormat({ fastStart: 'in-memory' });
}

/** `plan.fill`이 있으면 프레임 밑에 단색을 깔아 알파를 평탄화한다. */
function backgroundCompositor(fill) {
  let ctx = null;
  return (sample) => {
    if (ctx === null) {
      const canvas = new OffscreenCanvas(sample.displayWidth, sample.displayHeight);
      ctx = canvas.getContext('2d', { alpha: false });
    }
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    sample.draw(ctx, 0, 0);
    return ctx.canvas;
  };
}

export async function convertFile(file, plan, { onProgress, signal } = {}) {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  const output = new Output({ format: buildOutputFormat(plan.format.id), target: new BufferTarget() });

  const video = {
    codec: plan.videoCodec,
    alpha: plan.alpha,
    bitrate: QUALITY_HIGH,
    forceTranscode: true,
  };
  if (plan.fill !== null) video.process = backgroundCompositor(plan.fill);

  const conversion = await Conversion.init({
    input,
    output,
    video,
    audio: { codec: plan.audioCodec },
  });

  if (!conversion.isValid) {
    const reasons = conversion.discardedTracks.map((t) => t.reason).join(', ');
    input.dispose();
    throw new Error(`변환할 수 없는 파일입니다${reasons ? `: ${reasons}` : '.'}`);
  }

  const droppedAudio = conversion.discardedTracks.some((t) => t.track.isAudioTrack());

  if (onProgress) conversion.onProgress = onProgress;

  const abort = () => { void conversion.cancel(); };
  signal?.addEventListener('abort', abort, { once: true });

  try {
    await conversion.execute();
    if (signal?.aborted) throw new DOMException('취소되었습니다.', 'AbortError');
    return { blob: new Blob([output.target.buffer], { type: plan.format.mimeType }), droppedAudio };
  } finally {
    signal?.removeEventListener('abort', abort);
    conversion.onProgress = null;
    input.dispose();
  }
}
