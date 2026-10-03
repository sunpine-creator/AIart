# 설치·배포 안내

Mac 기준입니다. 처음 한 번만 하면 되는 일과, 실제 AI를 켜는 일을 나눠 두었어요.

## 0. 필요한 프로그램

```bash
# Node.js 22 (https://nodejs.org 에서 LTS 설치) 확인
node -v
# Firebase 도구
npm install -g firebase-tools
firebase login
# 에뮬레이터는 Java가 필요합니다 (없으면 https://adoptium.net 에서 설치)
java -version
```

## 1. 내 Firebase 프로젝트와 연결

1. `.firebaserc` 의 `YOUR-FIREBASE-PROJECT-ID` 를 내 프로젝트 ID로 바꿉니다.
2. Firebase 콘솔 > 프로젝트 설정 > 내 앱 > 웹 앱 추가 → 나오는 값을 `web/.env.local` 에 넣습니다.

```bash
cp web/.env.example web/.env.local   # 값 채우기
cp functions/.env.example functions/.env
```

3. Firebase 콘솔 > Authentication > 로그인 방법에서 **Google** 을 켭니다.

## 2. 내 컴퓨터에서 돌려 보기 (비용 없음)

```bash
npm --prefix functions install
npm --prefix web install
npm --prefix functions run build
firebase emulators:start          # 창 하나
npm --prefix web run dev           # 다른 창. http://localhost:5173
```

에뮬레이터에서 처음 교사로 쓰려면 승인 문서가 필요합니다.

1. http://localhost:5173/teacher 에서 Google로 로그인 (에뮬레이터는 가짜 계정 창이 뜹니다)
2. 화면에 나온 UID를 복사
3. 에뮬레이터 화면 http://localhost:4000 > Firestore 에서 `teachers` 컬렉션에 문서 ID = UID, 필드 `approved: true` (boolean) 추가
4. "승인됐는지 다시 확인" → 반 만들기 → 학생 입장 카드 확인
5. 다른 브라우저(또는 시크릿 창)에서 http://localhost:5173/?code=반코드 로 학생 입장

`VIDEO_PROVIDER=mock` 이라 생성은 몇 초 뒤 그림판 결과로 끝납니다. 검사·승인·대기열·기록·크레딧은 실제와 똑같이 동작해요.

## 3. 실제 AI 켜기 (비용 발생)

1. Firebase 요금제를 **Blaze** 로 올리고, Google Cloud 콘솔 > 결제 > **예산 알림**을 만듭니다.
2. Google Cloud 콘솔에서 같은 프로젝트의 다음 API를 켭니다.
   - Vertex AI API (Gemini Enterprise Agent Platform)
   - Cloud Tasks API
3. Model Garden에서 Gemini Omni 를 찾아 사용 신청(미리보기 허용 목록)을 합니다. 실제 모델 ID를 확인해 `functions/.env` 의 `OMNI_MODEL` 에 넣습니다. `TEXT_MODEL`, `IMAGE_MODEL` 도 현재 쓸 수 있는 이름인지 확인합니다.
4. Cloud Functions 서비스 계정(보통 `PROJECT_NUMBER-compute@developer.gserviceaccount.com`)에 **Vertex AI 사용자** 역할을 줍니다.
5. `functions/.env` 에서 `VIDEO_PROVIDER=omni` 로 바꿉니다.
6. **약관 확인**: 초중등 학생 대상 서비스에서 Vertex AI 생성형 모델을 써도 되는지 Google Cloud 에 서면으로 확인합니다. (AI Studio API 키 방식은 18세 미만 대상 서비스에 쓸 수 없어 이 앱은 쓰지 않습니다.)

## 4. 배포

```bash
npm --prefix web run build
firebase deploy
```

- 학생 주소: `https://프로젝트ID.web.app/?code=반코드`
- 교사 주소: `https://프로젝트ID.web.app/teacher`
- 운영 환경에서 교사 승인: Firebase 콘솔 > Firestore > `teachers/{UID}` 에 `approved: true`

## 5. 처음 실제로 돌릴 때 꼭 볼 것

Gemini Omni 는 미리보기라 요청·응답 형식이 바뀔 수 있습니다. 호출 코드는 `functions/src/ai/video.ts` 한 파일에 모아 두었습니다.

1. 교사 한 명, 학생 한 명으로 초안 1개만 만들어 봅니다.
2. Firebase 콘솔 > Functions > 로그에서 `runGeneration` 오류를 봅니다.
3. 필드 이름 오류가 나면 `video.ts` 의 `interactions.create` 부분만 공식 문서에 맞게 고칩니다.

## 단위 테스트

```bash
npm --prefix functions run build && npm --prefix functions test
```
