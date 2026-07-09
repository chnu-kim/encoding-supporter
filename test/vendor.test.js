/**
 * `public/vendor/`는 손으로 복사해 둔 사본이다. 의존성만 올리면 브라우저가 받는 코드는
 * 그대로 남아, lockfile이 말하는 버전과 실제 배포본이 조용히 어긋난다.
 * 사람이 알아차릴 방법이 없으므로 테스트가 대신 지킨다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root));

test('vendor의 mediabunny 번들이 설치된 패키지와 바이트 단위로 같다', async () => {
  const [vendored, installed] = await Promise.all([
    read('public/vendor/mediabunny.min.mjs'),
    read('node_modules/mediabunny/dist/bundles/mediabunny.min.mjs'),
  ]);

  assert.ok(
    vendored.equals(installed),
    'public/vendor/mediabunny.min.mjs가 낡았다. '
    + 'cp node_modules/mediabunny/dist/bundles/mediabunny.min.mjs public/vendor/ 로 갱신한다.',
  );
});

test('vendor의 라이선스 사본이 설치된 패키지와 같다', async () => {
  const [vendored, installed] = await Promise.all([
    read('public/vendor/mediabunny.LICENSE'),
    read('node_modules/mediabunny/LICENSE'),
  ]);

  assert.ok(vendored.equals(installed), 'public/vendor/mediabunny.LICENSE가 낡았다.');
});

test('mediabunny는 정확한 버전으로 고정돼 있다', async () => {
  // 캐럿 범위는 lockfile 없이 설치할 때 vendor 사본과 다른 버전을 끌어온다.
  const pkg = JSON.parse(await read('package.json'));
  const range = pkg.devDependencies.mediabunny;

  assert.match(range, /^\d+\.\d+\.\d+$/, `mediabunny를 정확한 버전으로 고정한다 (현재: ${range})`);
});
