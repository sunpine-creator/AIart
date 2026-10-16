import { initializeApp } from 'firebase/app';
import {
  browserLocalPersistence,
  browserPopupRedirectResolver,
  browserSessionPersistence,
  connectAuthEmulator,
  indexedDBLocalPersistence,
  initializeAuth,
} from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions';
import { connectStorageEmulator, getStorage } from 'firebase/storage';

const app = initializeApp({
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
});

// 교사 화면(/teacher)과 학생 화면의 로그인을 따로 보관한다.
// - 교사: 브라우저에 오래 남는 저장소(다른 탭과 공유)
// - 학생: 이 탭에만 남는 저장소(탭을 닫으면 로그아웃, 새로고침은 유지)
// 그래서 한 브라우저에서 교사 탭과 학생 탭을 함께 열어도 서로 로그인을 덮어쓰지 않는다.
const isTeacherPage = location.pathname.startsWith('/teacher');
export const auth = initializeAuth(app, {
  persistence: isTeacherPage ? [indexedDBLocalPersistence, browserLocalPersistence] : [browserSessionPersistence],
  popupRedirectResolver: browserPopupRedirectResolver,
});
export const db = getFirestore(app);
export const storage = getStorage(app);
export const functions = getFunctions(app, 'asia-northeast3');

if (import.meta.env.VITE_USE_EMULATORS === '1') {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  connectStorageEmulator(storage, '127.0.0.1', 9199);
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);
}

export type StudentWork = {
  no: number; name: string; topic: string; submitted: boolean;
  exportUrl: string | null; exportAt: number | null; exportDur: number | null;
  uploads: { id: string; name: string; dur: number; url: string }[];
  ai: { n: number; line: string; img: boolean; url: string | null }[];
};
export type TeacherRow = { uid: string; email: string; name: string; approved: boolean; admin: boolean; requestedAt: number | null; org: string; realName: string; requested: boolean };

// 기본 기다림은 70초. 오래 걸리는 기능(반 삭제·영상 합치기·작품 모으기)은 더 오래 기다린다
// 서버 기능 부르기. 로그인 토큰을 직접 붙여 보낸다(로그인 저장 방식을 바꿔도 토큰이 빠지지 않게).
const FN_BASE =
  import.meta.env.VITE_USE_EMULATORS === '1'
    ? `http://127.0.0.1:5001/${import.meta.env.VITE_FIREBASE_PROJECT_ID}/asia-northeast3`
    : `https://asia-northeast3-${import.meta.env.VITE_FIREBASE_PROJECT_ID}.cloudfunctions.net`;
const call =
  <I, O>(name: string, timeout = 70_000) =>
  async (data: I): Promise<O> => {
    await auth.authStateReady();
    const token = await auth.currentUser?.getIdToken().catch(() => undefined);
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), timeout);
    try {
      const r = await fetch(`${FN_BASE}/${name}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ data: data ?? {} }),
        signal: ctrl.signal,
      });
      const j: any = await r.json().catch(() => ({}));
      if (!r.ok || j.error) {
        const err: any = new Error(j.error?.message || `서버에 연결하지 못했어요 (${r.status})`);
        err.code = String(j.error?.status ?? r.status).toLowerCase();
        throw err;
      }
      return (j.result ?? j.data) as O;
    } catch (e: any) {
      if (e?.name === 'AbortError') throw new Error('시간이 너무 오래 걸려요. 잠시 뒤 다시 해 보세요.');
      if (e instanceof TypeError) throw new Error('인터넷 연결을 확인하고 다시 해 보세요.');
      throw e;
    } finally {
      window.clearTimeout(timer);
    }
  };
export const api = {
  createClass: call<{ title?: string; grade?: string; klass?: string; school?: string; band: 'elementary' | 'middle'; size: number; budgetUsd?: number }, { classId: string; code: string }>('createClass'),
  joinClass: call<{ code: string; no: number; name: string }, { token: string }>('joinClass'),
  requestGeneration: call<
    { kind: 'draft' | 'edit' | 'final'; sceneId: string; builder?: Record<string, any>; editText?: string; parentId?: string; sec?: number },
    { genId: string; blocked: boolean; flagged?: boolean; category?: string; reason?: string; suggestion?: string }
  >('requestGeneration'),
  reviewGeneration: call<{ genId: string; approve: boolean; reason?: string }, { ok: boolean }>('reviewGeneration'),
  deleteClass: call<{ classId: string }, { ok: boolean }>('deleteClass', 300_000),
  resetPin: call<{ classId: string; no: number; name?: string }, { ok: boolean }>('resetPin'),
  draftScenario: call<{ goal: string; role: string; content: string; cond: string; topic?: string }, { blocked: boolean; reason?: string; lines: string[] }>('draftScenario'),
  startUpload: call<{ kind: 'upload' | 'voice'; id: string; contentType: string; size: number; ext: string }, { path: string; sessionUrl: string; url: string }>('startUpload'),
  teacherWorks: call<{ classId: string }, { list: StudentWork[] }>('teacherWorks', 120_000),
  previewVoice: call<{ voice: string; text?: string }, { url: string }>('previewVoice', 60_000),
  draftScenes: call<
    Record<string, string>,
    { blocked: boolean; reason?: string; cast?: { look: string }; scenes: { line: string; who: string; when: string; where: string; what: string; how: string; why: string }[] }
  >('draftScenes', 60_000),
  makeCharacter: call<{ look: string; style: string }, { blocked: boolean; reason?: string; suggestion?: string; url?: string; tries?: number }>('makeCharacter', 120_000),
  renderVideo: call<{ overlays: { intro?: string; outro?: string; clips: Record<string, string>; caps: Record<string, string[]> } }, { path: string; missing?: number }>('renderVideo', 540_000),
  claimTeacher: call<Record<string, never>, { approved: boolean; admin: boolean; requested: boolean }>('claimTeacher'),
  requestTeacher: call<{ org: string; realName: string }, { ok: boolean }>('requestTeacher'),
  adminTeachers: call<Record<string, never>, { list: TeacherRow[] }>('adminTeachers'),
  setTeacherApproval: call<{ uid: string; approved: boolean }, { ok: boolean }>('setTeacherApproval'),
  devApproveTeacher: call<Record<string, never>, { ok: boolean }>('devApproveTeacher'),
  logEvent: call<{ kind: string; textKo: string; action: string }, { ok: boolean }>('logEvent'),
};

// 함수 오류 메시지를 학생이 읽을 수 있는 말로
export const errText = (e: any) => (e?.message && !/internal/i.test(e.message) ? String(e.message) : '잠시 문제가 생겼어요. 다시 해 보세요.');
