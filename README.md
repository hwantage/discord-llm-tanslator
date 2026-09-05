# Discord 한줄 번역

![Discord 한줄 번역 아이콘](icons/icon-128.png)

Discord 웹 메시지 끝의 `[한]` 버튼을 누르면 원문 바로 아래에 한국어 번역을 추가하는 브라우저 확장입니다.

Chrome 138 이상의 내장 `Translator` API에 의존하지 않습니다. OpenAI 호환 `chat/completions` API를 사용하므로 로컬 Ollama, LM Studio, 자체 호스팅 서버, API 키가 필요한 원격 LLM 제공자를 같은 방식으로 연결할 수 있습니다.

## 주요 기능

- 메시지별 `[한]` 버튼으로 필요한 글만 번역
- 클릭 즉시 `KO · 번역 중…` 표시 후 같은 위치에 결과 출력
- 원문을 유지한 채 번역 결과 표시 및 숨김
- 번역문 끝의 재시도 아이콘으로 새 번역 요청
- Advanced 설정에서 번역 버튼 아이콘과 텍스트·배경 색상 조합 선택 및 실시간 미리보기
- 일반 메시지와 답장 메시지의 실제 본문 인식
- 새 메시지, 채널 전환, 무한 스크롤 및 메시지 수정 감지
- URL과 코드 조각을 번역 대상에서 보호
- 페이지 세션 동안 최대 250개 결과 캐시
- 선택적 API 키를 지원하는 OpenAI 호환 LLM 연결
- 요청 ID가 포함된 진단 로그 제공

확장이 브라우저에서 활성화되어 있으면 Discord에 `[한]` 버튼을 항상 표시합니다. 번역 기능 전체를 중지하려면 브라우저의 확장 관리 화면에서 확장을 비활성화합니다.

<img width="1449" height="777" alt="image" src="https://github.com/user-attachments/assets/859ce478-bfaa-4287-bff2-b2535ef884c2" />


## 지원 환경

| 브라우저 | 빌드 | 비고 |
| --- | --- | --- |
| Brave, Chrome, Edge | `dist/chromium` | Manifest V3 |
| Firefox 121 이상 | `dist/firefox` | 임시 또는 서명된 부가 기능으로 로드 |

Discord 웹(`https://discord.com`)에서만 동작합니다. Discord 데스크톱 앱, 이미지·스티커·첨부파일 OCR, 발신 전 자동 번역은 지원하지 않습니다.

## 기본 설정

| 항목 | 기본값 |
| --- | --- |
| API Base URL | `http://localhost:11434/v1` |
| 번역 모델 | `0xIbra/supergemma4-26b-uncensored-gguf-v2:Q4_K_M` |
| API 키 | 없음 |
| 출력 언어 | 한국어(`KO`) |
| 동시 요청 | 1개 |
| 요청 제한 시간 | 3분 |
| 메시지 길이 제한 | 10,000자 |

기본값은 Ollama의 OpenAI 호환 API를 인증 없이 사용합니다. 이전 버전의 `http://localhost:11434` Ollama 설정은 `/v1` 주소로 자동 변환됩니다.

로컬 모델을 설치하지 않으려면 설정 화면에서 원격 OpenAI 호환 API의 Base URL, 모델 ID와 API 키를 입력하면 됩니다.

## 빠른 시작: Brave + Ollama

### 1. Ollama 확인

Ollama가 기본 포트 `11434`에서 실행 중인지 확인합니다.

```sh
ollama list
```

기본 모델이 없다면 설치합니다.

```sh
ollama pull 0xIbra/supergemma4-26b-uncensored-gguf-v2:Q4_K_M
```

Ollama가 브라우저 확장 요청을 차단하는 경우 실행 중인 Ollama를 완전히 종료한 다음 확장 Origin을 허용하여 다시 실행합니다.

```sh
OLLAMA_ORIGINS='chrome-extension://*,moz-extension://*' ollama serve
```

### 2. 확장 빌드

외부 npm 패키지는 필요하지 않으며 Node.js 20 이상을 사용합니다.

```sh
npm run check
```

이 명령은 JavaScript 문법 검사, 자동 테스트, Chromium 및 Firefox 빌드를 차례로 수행합니다.

### 3. Brave에 설치

1. `brave://extensions`를 엽니다.
2. `개발자 모드`를 켭니다.
3. `압축해제된 확장 프로그램을 로드합니다`를 누릅니다.
4. 이 저장소의 `dist/chromium` 디렉터리를 선택합니다.
5. 확장 아이콘을 눌러 설정 화면을 엽니다.
6. `연결 테스트`를 실행합니다.
7. 이미 열려 있던 Discord 탭을 새로고침합니다.

코드를 변경한 뒤에는 `npm run build:chromium`을 실행하고 `brave://extensions`에서 확장을 다시 로드한 다음, 이미 열려 있는 Discord 탭도 새로고침해야 합니다.

## 설정 화면

| 설정 | 설명 |
| --- | --- |
| API Base URL | OpenAI 호환 API의 기준 주소입니다. 예: `http://localhost:11434/v1`, `https://api.openai.com/v1` |
| 번역 모델 | 연결한 제공자가 인식하는 정확한 모델 ID입니다. |
| API 키 | 인증이 필요한 제공자에서만 입력합니다. 비어 있으면 인증 헤더를 보내지 않습니다. |
| 번역 언어 | 현재 한국어(`KO`)로 고정되어 있습니다. |
| Advanced → 번역 버튼 아이콘 | 한글, 가/A, 지구본, 말풍선 중에서 선택합니다. |
| Advanced → 번역 결과 색상 | 기본(배경 없음), 민트, 블루, 라벤더, 앰버 중 텍스트·배경 조합을 선택합니다. |

`Advanced`는 기본적으로 접혀 있습니다. 펼친 뒤 아이콘과 색상을 선택하면 예시 메시지에 즉시 반영됩니다. `설정 저장`을 누르면 선택한 모양이 저장되고, 열려 있는 Discord 탭의 기존 메시지와 이후 메시지에도 적용됩니다.

`설정 저장`은 입력값과 해당 API 호스트의 접근 권한을 저장합니다. `연결 테스트`는 먼저 현재 입력값을 저장한 뒤 `Hello, nice to meet you.` 문장의 시험 번역을 실제로 요청하고, 성공한 모델과 번역 결과를 화면에 바로 표시합니다.

API 키는 브라우저의 확장 전용 로컬 저장소에 보관됩니다. 별도 암호화는 하지 않으므로 공용 브라우저 프로필에는 저장하지 않는 것이 좋습니다.

## OpenAI 호환 API 요구사항

확장은 다음 요청과 응답 형식을 사용하는 서버를 지원합니다.

- 요청: `POST /chat/completions`
- 본문: `model`, `messages`, `stream: false`
- 응답: `choices[0].message.content`
- 인증: API 키가 있을 때만 `Authorization: Bearer <API_KEY>`

Base URL이 이미 `/chat/completions`로 끝나면 그대로 사용합니다. 그렇지 않으면 해당 경로를 자동으로 추가합니다.

API 키가 있는 원격 엔드포인트는 HTTPS만 허용합니다. `localhost`와 `127.0.0.1`은 API 키 유무와 관계없이 HTTP를 사용할 수 있습니다.

## Discord에서 사용

1. Discord 웹을 열거나 새로고침합니다.
2. 번역할 메시지 끝의 `[한]` 버튼을 누릅니다.
3. 원문 아래에 `KO · 번역 중…`이 즉시 나타납니다.
4. 번역이 끝나면 같은 영역에 한국어 결과가 표시됩니다.
5. 완료된 메시지의 `[한]` 버튼을 다시 누르면 번역 결과를 숨기거나 다시 표시할 수 있습니다.
6. 번역이 어색하면 번역문 끝의 작은 재시도 아이콘을 누릅니다. 기존 캐시를 사용하지 않고 원문을 다시 번역하며, 완료된 결과로 갱신합니다. 요청 중에는 중복 클릭을 막습니다.

`[한]` 버튼의 모양은 설정의 `Advanced`에서 변경할 수 있습니다. 선택한 아이콘에 관계없이 번역 및 숨기기 동작은 같습니다.

번역 요청에는 클릭한 메시지 본문만 포함됩니다. 답장 메시지의 인용 미리보기, Discord 토큰, 쿠키, 사용자 ID, 채널 ID와 메시지 ID는 LLM 엔드포인트로 보내지 않습니다.

## 권한과 개인정보

- `discord.com`: 메시지 끝에 버튼을 붙이고 번역 결과를 표시합니다.
- `storage`: Base URL, 모델 ID와 선택적 API 키를 저장합니다.
- `localhost`, `127.0.0.1`: 기본 로컬 LLM 연결에 사용하는 필수 호스트 권한입니다.
- 사용자가 입력한 원격 호스트: 설정 저장 시 해당 호스트만 런타임 권한을 요청합니다.

매니페스트의 선택적 원격 호스트 패턴은 권한을 요청할 수 있는 범위만 선언합니다. 설치와 동시에 모든 웹사이트 접근 권한을 얻지 않으며, 사용자가 설정 저장 과정에서 승인한 API 호스트에만 접근합니다.

확장 개발자가 운영하는 중계 서버, 분석 서버, 광고 또는 추적 기능은 없습니다. 자세한 내용은 [PRIVACY.md](PRIVACY.md)를 참고하세요.

## 문제 해결

### `[한]` 버튼이 보이지 않음

- `brave://extensions`에서 확장이 활성화되어 있는지 확인합니다.
- 확장을 다시 로드한 후 Discord 탭도 새로고침합니다.
- Discord가 `https://discord.com`에서 열려 있는지 확인합니다.
- 답장 메시지 또는 채널 전환 후 발생한다면 Discord 탭의 콘솔에서 `[DiscordTranslator]` 로그를 확인합니다.

### 연결 테스트 또는 번역 실패

| 오류 코드 | 확인할 내용 |
| --- | --- |
| `PROVIDER_PERMISSION_MISSING` | 설정 저장 시 표시되는 API 호스트 권한 요청을 승인합니다. |
| `API_UNREACHABLE` | Base URL, 서버 실행 상태, 네트워크와 서버의 Origin/CORS 설정을 확인합니다. |
| `API_AUTH_ERROR` | API 키와 서버의 확장 Origin 허용 설정을 확인합니다. |
| `API_ENDPOINT_NOT_FOUND` | Base URL 및 OpenAI 호환 `/chat/completions` 경로를 확인합니다. |
| `MODEL_NOT_FOUND` | 제공자가 인식하는 정확한 모델 ID인지 확인합니다. |
| `OPTIONS_PAGE_OPEN_FAILED` | 확장 아이콘을 눌러 설정 화면을 직접 열고 확장을 다시 로드합니다. |
| `INSECURE_API_KEY_ENDPOINT` | API 키를 사용하는 원격 서버를 HTTPS로 연결합니다. |
| `INVALID_RESPONSE` | 응답에 `choices[0].message.content` 문자열이 포함되는지 확인합니다. |
| `TIMEOUT` | 모델 로딩 상태와 서버 응답 시간을 확인합니다. 제한 시간은 3분입니다. |
| `RATE_LIMITED` | 제공자의 요청 한도와 계정 사용량을 확인한 뒤 다시 시도합니다. |
| `API_ERROR` | 연결한 제공자의 응답 메시지와 서비스 상태를 확인합니다. |
| `EXTENSION_RELOADED` | 확장 재로드로 기존 탭의 연결이 해제되었습니다. 번역 영역의 `Discord 새로고침`을 누르거나 Discord 탭을 새로고침합니다. |
| `BACKGROUND_DISCONNECTED` | 번역 응답을 기다리던 연결이 끊겼습니다. `다시 시도`로 새 번역을 요청합니다. |
| `EXTENSION_ERROR` | 번역을 다시 시도하거나 Discord 탭을 새로고침합니다. |

번역 중 확장을 다시 로드하면 진행 중인 요청이 중단됩니다. 기존 Discord 탭에 표시되는 `Discord 새로고침` 버튼으로 연결을 복구할 수 있습니다. 이때 확장을 반복해서 다시 로드할 필요는 없습니다.

### 로그 확인

모든 로그는 `[DiscordTranslator]` 접두사와 요청 ID를 사용하며 API 키 값은 기록하지 않습니다.

- Discord 처리 로그: Discord 탭의 개발자 도구 콘솔
- API 요청 로그: `brave://extensions` → 확장 세부정보 → 서비스 워커 검사
- 설정 로그: 설정 탭의 개발자 도구 콘솔

정상 번역의 주요 이벤트 순서는 다음과 같습니다.

```text
content.button.click
content.request.start
background.message.received
background.permission.checked
provider.fetch.start
provider.fetch.response
provider.translation.parsed
background.message.success
content.request.success
```

## 개발 명령

```sh
npm test
npm run build
npm run build:chromium
npm run build:firefox
npm run check
```

- `npm test`: 자동 테스트 실행
- `npm run build`: Chromium과 Firefox 배포 디렉터리 생성
- `npm run build:chromium`: `dist/chromium`만 생성
- `npm run build:firefox`: `dist/firefox`만 생성
- `npm run check`: 문법 검사, 테스트 및 전체 빌드 수행

아이콘 원본과 크기별 PNG는 `icons/`에 있습니다. Discord DOM 탐색과 번역 상태 처리는 `content.js`, 메시지와 설정 미리보기가 공유하는 UI는 `inline-ui.js`, OpenAI 호환 API 요청은 `background.js`, 설정 화면은 `options/`에 구현되어 있습니다.
