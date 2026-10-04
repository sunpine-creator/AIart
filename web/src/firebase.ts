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

export type TeacherRow = { uid: string; email: string; name: string; approved: boolean; admin: boolean; requestedAt: number | null };

const call = <I, O>(name: string) => async (data: I) => (await httpsCallable<I, O>(functions, name)(data)).data;
export const api = {
  createClass: call<{ title: string; band: 'elementary' | 'middle'; size: number; budgetUsd?: number }, { classId: string; code: string }>('createClass'),
  joinClass: call<{ code: string; no: number; name: string }, { token: string }>('joinClass'),
  requestGeneration: call<
    { kind: 'draft' | 'edit' | 'final'; sceneId: string; builder?: { who: string; what: string; where: string; how: string }; editText?: string; parentId?: string },
    { genId: string; blocked: boolean; category?: string; reason?: string; suggestion?: string }
  >('requestGeneration'),
  reviewGeneration: call<{ genId: string; approve: boolean; reason?: string }, { ok: boolean }>('reviewGeneration'),
  resetPin: call<{ classId: string; no: number; name?: string }, { ok: boolean }>('resetPin'),
  draftScenario: call<{ goal: string; role: string; content: string; cond: string; topic?: string }, { blocked: boolean; reason?: string; lines: string[] }>('draftScenario'),
  renderVideo: call<Record<string, never>, { path: string }>('renderVideo'),
  claimTeacher: call<Record<string, never>, { approved: boolean; admin: boolean }>('claimTeacher'),
  adminTeachers: call<Record<string, never>, { list: TeacherRow[] }>('adminTeachers'),
  setTeacherApproval: call<{ uid: string; approved: boolean }, { ok: boolean }>('setTeacherApproval'),
  devApproveTeacher: call<Record<string, never>, { ok: boolean }>('devApproveTeacher'),
  logEvent: call<{ kind: string; textKo: string; action: string }, { ok: boolean }>('logEvent'),
};

// 함수 오류 메시지를 학생이 읽을 수 있는 말로
export const errText = (e: any) => (e?.message && !/internal/i.test(e.message) ? String(e.message) : '잠시 문제가 생겼어요. 다시 해 보세요.');
