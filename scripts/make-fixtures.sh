#!/usr/bin/env bash
# 검증용 webm 픽스처를 생성한다. 산출물은 .gitignore 대상이므로 필요할 때 다시 돌린다.
set -euo pipefail

out="$(cd "$(dirname "$0")/.." && pwd)/test/fixtures"
mkdir -p "$out"

# 알파 채널 VP9: 가운데 원만 불투명하고 바깥은 완전 투명하다.
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=s=320x240:r=30:d=2,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(hypot(X-160,Y-120),80),255,0)'" \
  -c:v libvpx-vp9 -pix_fmt yuva420p -auto-alt-ref 0 \
  "$out/alpha-vp9.webm"

# 알파 채널 VP8
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=s=320x240:r=30:d=2,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(hypot(X-160,Y-120),80),255,0)'" \
  -c:v libvpx -pix_fmt yuva420p -auto-alt-ref 0 \
  "$out/alpha-vp8.webm"

# 불투명 VP9 + Opus 오디오
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=s=320x240:r=30:d=2" \
  -f lavfi -i "sine=frequency=440:duration=2" \
  -c:v libvpx-vp9 -pix_fmt yuv420p -c:a libopus \
  "$out/opaque-vp9-opus.webm"

# 알파 채널 VP9 + Opus 오디오: 알파를 지키면서 소리도 함께 옮기는 경로를 검증한다.
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=s=320x240:r=30:d=2,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(hypot(X-160,Y-120),80),255,0)'" \
  -f lavfi -i "sine=frequency=440:duration=2" \
  -c:v libvpx-vp9 -pix_fmt yuva420p -auto-alt-ref 0 -c:a libopus \
  "$out/alpha-vp9-opus.webm"

for f in "$out"/*.webm; do
  printf '%s\n' "--- $f"
  ffprobe -hide_banner -loglevel error -show_entries \
    "stream=codec_name,pix_fmt,width,height:stream_tags=alpha_mode" \
    -of default=noprint_wrappers=1 "$f"
done
