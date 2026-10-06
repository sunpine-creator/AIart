import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';
import { connectStorageEmulator, getStorage } from 'firebase/storage';

const app = initializeApp({
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
});

export const auth = getAuth(app);
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
const call = <I, O>(name: string, timeout = 70_000) => async (data: I) => (await httpsCallable<I, O>(functions, name, { timeout })(data)).data;
export const api = {
  createClass: call<{ title?: string; grade?: string; klass?: string; school?: string; band: 'elementary' | 'middle'; size: number; budgetUsd?: number }, { classId: string; code: string }>('createClass'),
  joinClass: call<{ code: string; no: number; name: string }, { token: string }>('joinClass'),
  requestGeneration: call<
    { kind: 'draft' | 'edit' | 'final'; sceneId: string; builder?: { who: string; what: string; where: string; how: string }; editText?: string; parentId?: string },
    { genId: string; blocked: boolean; category?: string; reason?: string; suggestion?: string }
  >('requestGeneration'),
  reviewGeneration: call<{ genId: string; approve: boolean; reason?: string }, { ok: boolean }>('reviewGeneration'),
  deleteClass: call<{ classId: string }, { ok: boolean }>('deleteClass', 300_000),
  resetPin: call<{ classId: string; no: number; name?: string }, { ok: boolean }>('resetPin'),
  draftScenario: call<{ goal: string; role: string; content: string; cond: string; topic?: string }, { blocked: boolean; reason?: string; lines: string[] }>('draftScenario'),
  startUpload: call<{ kind: 'upload' | 'voice'; id: string; contentType: string; size: number; ext: string }, { path: string; sessionUrl: string; url: string }>('startUpload'),
  teacherWorks: call<{ classId: string }, { list: StudentWork[] }>('teacherWorks', 120_000),
  renderVideo: call<{ overlays: Record<string, { fixed?: string; cap?: string[]; anim?: string }> }, { path: string; missing?: number }>('renderVideo', 540_000),
  claimTeacher: call<Record<string, never>, { approved: boolean; admin: boolean; requested: boolean }>('claimTeacher'),
  requestTeacher: call<{ org: string; realName: string }, { ok: boolean }>('requestTeacher'),
  adminTeachers: call<Record<string, never>, { list: TeacherRow[] }>('adminTeachers'),
  setTeacherApproval: call<{ uid: string; approved: boolean }, { ok: boolean }>('setTeacherApproval'),
  devApproveTeacher: call<Record<string, never>, { ok: boolean }>('devApproveTeacher'),
  logEvent: call<{ kind: string; textKo: string; action: string }, { ok: boolean }>('logEvent'),
};

// 함수 오류 메시지를 학생이 읽을 수 있는 말로
export const errText = (e: any) => (e?.message && !/internal/i.test(e.message) ? String(e.message) : '잠시 문제가 생겼어요. 다시 해 보세요.');
