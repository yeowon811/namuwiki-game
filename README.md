# 나무위키 레이스 🏁

친구들과 **같은 시작 문서 → 목표 문서**를 받아 나무위키 링크만 타고 누가 먼저(또는 적은 클릭으로) 도착하는지 겨루는 게임입니다.

- 화면: GitHub Pages(정적 사이트)
- 실시간 방/순위 동기화: Firebase Realtime Database

## 게임 방식
- 방장이 방을 만들고 4자리 방 코드나 초대 링크를 공유합니다.
- 모드
  - **⏱️ 타임어택**: 가장 빨리 도착한 사람이 1등입니다.
  - **👆 최소 클릭**: 가장 적은 클릭으로 도착한 사람이 1등이고, 클릭 수가 같으면 더 빨리 도착한 사람이 이깁니다.
- 제한 시간을 정할 수 있습니다. 제한 없음, 3분, 5분, 10분, 15분, 20분, 30분 중에서 고릅니다.
- 시작하면 3초 카운트다운 뒤에 모두에게 같은 키워드가 공개됩니다.
- 실제 나무위키(namu.wiki)에서 플레이하고, 도착하면 **도착했어요!** 버튼을 누릅니다. 기록 시간은 버튼을 누른 순간 기준입니다.
- 거쳐간 문서를 입력하면 클릭 수가 계산되고, 결과 화면에서 모든 사람의 경로가 공개됩니다.
- 새로고침해도 같은 방으로 자동 복귀합니다. 방장이 30초 넘게 나가 있으면 다음 사람이 방장을 이어받습니다.

랜덤 키워드 목록은 `keywords.js`에서 자유롭게 추가하거나 삭제할 수 있습니다. 나무위키 문서 제목과 똑같이 적어야 합니다.

## 파일 구성
| 파일 | 역할 |
| --- | --- |
| `index.html`, `style.css`, `app.js` | 게임 화면과 로직 |
| `keywords.js` | 랜덤 키워드 목록 |
| `firebase-config.js` | Firebase 프로젝트 설정 |
| `database.rules.json` | Realtime Database 보안 규칙 (콘솔에 붙여넣기용) |
| `dev-server.js` | 내 PC에서 테스트할 때만 쓰는 간단한 서버 |

## 1. Firebase 설정
1. `firebase-config.js`의 `apiKey: 'YOUR_API_KEY'`를 Firebase 콘솔의 실제 apiKey 값으로 바꿉니다. 콘솔의 프로젝트 설정 → 일반 → 내 앱에서 볼 수 있습니다.
2. Firebase 콘솔 → **Realtime Database → 규칙** 탭에 `database.rules.json` 내용을 붙여넣고 **게시**를 누릅니다.
   - 이 규칙은 `rooms/방코드` 아래만 읽고 쓸 수 있게 합니다. 전체 방 목록은 볼 수 없습니다.

## 2. 내 PC에서 테스트
```bash
npm run dev
```
http://localhost:5500 을 엽니다. ES 모듈을 쓰기 때문에 `index.html`을 더블클릭해서 열면 동작하지 않습니다.

## 3. GitHub Pages로 배포
```bash
git init
git add .
git commit -m "나무위키 레이스"
git branch -M main
git remote add origin https://github.com/yeowon811/namuwiki-game.git
git push -u origin main
```
1. GitHub 저장소 → **Settings → Pages**로 갑니다.
2. Source를 **Deploy from a branch**로, Branch를 **main / (root)**로 정하고 Save를 누릅니다.
3. 1~2분 뒤 **https://yeowon811.github.io/namuwiki-game/** 에서 게임이 열립니다.

## 참고
- 웹용 Firebase apiKey는 비밀번호가 아니라 공개되어도 되는 값입니다. 다만 다른 사이트에서 쓰지 못하게 하려면, Google Cloud 콘솔 → API 및 서비스 → 사용자 인증 정보에서 해당 키의 **HTTP 리퍼러 제한**에 `yeowon811.github.io/*`와 `localhost:5500/*`를 추가하세요.
- 다 끝난 방은 데이터베이스에 남아 있습니다. 가끔 Firebase 콘솔에서 `rooms`를 지워주세요. 무료 플랜 용량으로 충분합니다.
- 실제 나무위키에서 플레이하는 방식이라 검색 사용이나 경로 조작은 막을 수 없습니다. 결과 화면에 공개되는 경로로 서로 확인하세요.
