# encoding-supporter

Shoost가 읽지 못하는 `.webm` 영상을 브라우저 안에서 MP4로 변환해 주는 정적 웹사이트.

파일은 어디에도 업로드되지 않는다. 모든 디코딩·인코딩은 WebCodecs를 통해 사용자의 브라우저에서 처리된다.

## 왜 필요한가

Shoost는 레이어 소스로 `png`, `jpg`, `mp4`를 받는다. VTuber용 소품(마이크, 책상, 이펙트) 영상은
투명 배경을 담기 위해 알파 채널이 있는 VP8/VP9 `.webm`으로 배포되는 경우가 많은데, 이 포맷은
Shoost에서 "지원하지 않는 파일 형식"으로 거부된다.

MP4(H.264)는 알파 채널을 담을 수 없다. 따라서 투명 영상은 단색 배경 위에 합성한 뒤
Shoost의 크로마키 기능으로 다시 배경을 빼내는 방식으로 우회한다. 이 사이트는 알파 채널을
자동으로 감지해 두 경로를 나눈다.

## 개발

```sh
npm install
npm test        # 순수 로직 단위 테스트
npm run serve   # 로컬 정적 서버
```

## 라이선스

MIT. 번들된 [mediabunny](https://mediabunny.dev)는 MPL-2.0.
