# encoding-supporter

Shoost가 읽지 못하는 `.webm` 영상을 브라우저 안에서 다시 써주는 정적 웹사이트.

파일은 어디에도 업로드되지 않는다. 디코딩과 인코딩 모두 WebCodecs로 사용자의 브라우저에서 처리된다.

## 왜 필요한가

Shoost는 VTuber 소품(마이크, 책상, 이펙트) 영상을 레이어에 올려 합성한다. 이런 소품은 배경이
비어 있어야 하므로 알파 채널을 담을 수 있는 `.webm`으로 배포되는데, Shoost가 이 파일을
"지원하지 않는 파일 형식"으로 거부하는 일이 있다.

같은 `.webm`이라도 안에 든 코덱이 다르다. 요즘 배포되는 소품은 대개 **VP9**인데, VP9를 읽지
못하고 **VP8**만 읽는 프로그램이 있다. Shoost가 webm을 거부한다면 먼저 VP8로 다시 써보는 편이
좋다. 알파 채널을 그대로 들고 갈 수 있는 유일한 길이기 때문이다.

| 출력 | 투명 배경 | 언제 쓰나 |
| --- | --- | --- |
| **WebM (VP8)** | 유지된다 | 투명 소품. 먼저 이걸로 시도한다. |
| **MP4 (H.264)** | 담을 수 없다 | VP8도 거부당하거나, 애초에 불투명한 영상일 때. 투명 영상이면 배경을 단색으로 칠해 크로마키로 지운다. |

MP4는 알파 채널을 담지 못하므로, 투명 영상을 MP4로 뽑으면 배경이 검게 눌어붙는다. 이 사이트는
알파를 **자동으로 감지해서** 투명 영상에는 VP8을 추천하고, 굳이 MP4를 골랐다면 배경색을 물어본
뒤 그 색으로 칠해 내보낸다.

## 어떻게 판정하나

알파 채널이 있다고 해서 투명 영역이 있는 것은 아니다. 그래서 두 단계로 본다.

1. 컨테이너의 `alpha_mode` 태그(`InputVideoTrack.canBeTransparent()`)로 알파 가능성을 거른다.
2. 실제 프레임을 재생 구간 세 지점에서 디코드해 투명 픽셀 비율을 센다. 페이드인처럼 첫 프레임만
   불투명한 영상을 놓치지 않기 위해서다.

투명 픽셀이 0.1% 미만이면 알파 평면이 있어도 버린다. 인코딩 경계에서 생기는 반투명 픽셀을
투명 의도로 오해하지 않기 위한 하한이다.

## 개발

```sh
npm install
npm test            # 순수 로직 단위 테스트 (node:test)
npm run fixtures    # ffmpeg으로 알파/불투명 webm 픽스처 생성
npm run test:e2e    # 헤드리스 Chrome에서 실제 변환 후 ffmpeg으로 산출물 검증
npm run serve       # http://localhost:8080
```

`test:e2e`는 시스템에 설치된 Chrome과 `ffmpeg`/`ffprobe`를 쓴다. 변환한 파일을 실제로 뜯어서
VP8 산출물에 `alpha_mode=1`이 붙었는지, MP4 산출물의 배경 픽셀이 고른 색인지까지 확인한다.
페이지에서 난 콘솔 에러도 실패로 센다. 둘 다 CI에서 매 PR마다 돌린다.

MP4 경로는 Chromium이 아니라 **Google Chrome**을 요구한다. AAC와 H.264 인코더가 공식 빌드에만
들어 있기 때문이다.

빌드 단계는 없다. `public/`이 그대로 배포된다. `public/vendor/`의 mediabunny는 손으로 복사한
사본이라 `npm test`가 설치본과 바이트 단위로 대조한다. 의존성을 올렸다면 함께 갱신한다.

```sh
cp node_modules/mediabunny/dist/bundles/mediabunny.min.mjs public/vendor/
```

## 라이선스

MIT. 번들된 [mediabunny](https://mediabunny.dev)는 MPL-2.0(`public/vendor/mediabunny.LICENSE`).
