# AI 스튜디오

초중등 프로젝트 수업 「AI로 달라진 나의 일상」을 위한 AI 영상 창작 웹앱입니다.
한 반 30명이 동시에 접속해 활동지 → AI로 장면 만들기 → 이야기 엮기 → 편집 → 검토까지 진행하고,
모든 프롬프트는 지울 수 없는 기록으로 남습니다.

## 구성

| 폴더 | 내용 |
| --- | --- |
| `web/` | 학생·교사 화면 (React + Vite + Firebase SDK) |
| `functions/` | 서버 (Cloud Functions 2세대, 서울 리전) |
| `firestore.rules`, `storage.rules` | 권한 규칙: 학생은 자기 것만, 교사는 자기 반만, 기록·크레딧은 서버만 |
| `prototype/index.html` | 백엔드 없이 눌러 보는 화면 시안 |

## 흐름

1. 교사가 Google로 로그인 → 반 만들기 → 학생 입장 카드(반 코드·번호·비밀 숫자) 출력
2. 학생은 이름 없이 반 코드·번호·비밀 숫자로 입장 (`joinClass` → 커스텀 토큰)
3. 생성 요청(`requestGeneration`): 규칙 검사 → Gemini 맥락 검사·번역 → 기록 → 크레딧 차감 → 교사 승인 대기 또는 대기열
4. 대기열(`runGeneration`, Cloud Tasks): 동시 실행 수를 제한해 Gemini Omni 호출 → Storage 저장 → 학생 화면에 실시간 반영
5. 교사 현황판: 단계 열기, 멈춤, 승인·반려, 차단 알림, 학생별 프롬프트 기록, CSV 복사, 오늘 비용

## 영상 생성 방식

`functions/.env` 의 `VIDEO_PROVIDER` 로 고릅니다.

- `mock` (기본): 비용 없이 흐름만 확인. 결과는 그림판으로 보입니다.
- `omni`: 실제 Gemini Omni 호출 (Vertex AI, 비용 발생)

설치와 배포는 [SETUP.md](SETUP.md)를 따라 하세요.

## 아직 연결되지 않은 것 (다음 단계)

- 편집한 장면을 한 편의 MP4로 합치기 (Cloud Run + ffmpeg)
- 학생 목소리 녹음
- BigQuery로 기록 내보내기
