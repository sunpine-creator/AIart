import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { getFunctions } from 'firebase-admin/functions';
import { getStorage } from 'firebase-admin/storage';
import { setGlobalOptions } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { logger } from 'firebase-functions';
import { randomInt } from 'node:crypto';
import { CONFIG, Kind, MAX_EDITS, OPEN_STAGE_FOR_AI, REGION, specFor } from './config';
import { Builder, buildPromptKo, moderateRules } from './moderation';
import { checkAndTranslate } from './ai/text';
import { SafetyBlockedError, provider } from './ai/video';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pjoin } from 'node:path';
import { Clip, renderAll } from './render';
import { isAiVoice, speak } from './ai/tts';

initializeApp();
setGlobalOptions({ region: REGION, maxInstances: 20 });
const db = getFirestore();

// ───────── 공통 ─────────
const NICKS = ['파랑고래', '초록거북', '노랑병아리', '빨강여우', '하늘다람쥐', '보라문어', '주황호랑이', '분홍돌고래', '하양토끼', '검정고양이', '민트펭귄', '갈색곰', '은빛늑대', '황금사자', '연두개구리', '남색부엉이', '살구판다', '회색코끼리', '하늘고래', '바다수달'];
const nickOf = (no: number) => NICKS[(no * 7) % NICKS.length];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 0·O·1·I 제외
const today = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, ''); // 서울 날짜
const hueOf = (id: string) => [...id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);

async function requireTeacher(req: CallableRequest) {
  const a = req.auth;
  if (!a || a.token.firebase?.sign_in_provider !== 'google.com') throw new HttpsError('unauthenticated', '교사 Google 계정으로 로그인해 주세요.');
  const t = await db.doc(`teachers/${a.uid}`).get();
  if (!t.exists || t.data()?.approved !== true) throw new HttpsError('permission-denied', '아직 승인되지 않은 교사 계정이에요. 운영자에게 승인을 요청하세요.');
  return a.uid;
}
function requireStudent(req: CallableRequest) {
  const t = req.auth?.token;
  if (!t || t.role !== 'student') throw new HttpsError('unauthenticated', '반 코드로 다시 들어와 주세요.');
  return { classId: String(t.classId), no: Number(t.no) };
}
async function ownedClass(uid: string, classId: string) {
  const c = await db.doc(`classes/${classId}`).get();
  if (!c.exists || c.data()!.teacherUid !== uid) throw new HttpsError('permission-denied', '내 반이 아니에요.');
  return c;
}
function log(e: { classId: string; no: number; kind: string; textKo: string; textEn?: string; verdict: 'pass' | 'blocked'; category?: string; action: string; layer?: string }) {
  return db.collection('promptLogs').add({ ...e, at: FieldValue.serverTimestamp() });
}
async function enqueue(genId: string) {
  const q = getFunctions().taskQueue(`locations/${REGION}/functions/runGeneration`);
  await q.enqueue({ genId }, { dispatchDeadlineSeconds: 1800 });
}

// ───────── 교사: 반 만들기 ─────────
export const createClass = onCall(async (req) => {
  const uid = await requireTeacher(req);
  const { title, band, size = 30, budgetUsd, creditsPerStudent } = req.data ?? {};
  if (!title || !['elementary', 'middle'].includes(band)) throw new HttpsError('invalid-argument', '반 이름과 학교급을 정해 주세요.');
  const n = Math.max(1, Math.min(40, Number(size)));
  let code = '';
  for (let i = 0; i < 10 && !code; i++) {
    const c = Array.from({ length: 6 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');
    if (!(await db.doc(`codes/${c}`).get()).exists) code = c;
  }
  if (!code) throw new HttpsError('resource-exhausted', '반 코드를 만들지 못했어요. 다시 해 보세요.');
  const classRef = db.collection('classes').doc();
  const credits = Number(creditsPerStudent) || (band === 'elementary' ? 72 : 30);
  const pins: Record<string, string> = {};
  const batch = db.batch();
  batch.set(classRef, {
    teacherUid: uid, title: String(title).slice(0, 40), band, code, size: n,
    open: 1, paused: false, approval: true, videoInMiddle: false,
    budgetUsd: Number(budgetUsd) || (band === 'elementary' ? 71 : 29),
    createdAt: FieldValue.serverTimestamp(),
  });
  batch.set(db.doc(`codes/${code}`), { classId: classRef.id });
  for (let no = 1; no <= n; no++) {
    pins[no] = String(randomInt(10000)).padStart(4, '0');
    batch.set(classRef.collection('students').doc(String(no)), { no, nick: nickOf(no), credits, stage: 1, status: 'idle', lastSeen: null });
  }
  batch.set(classRef.collection('private').doc('pins'), { pins });
  await batch.commit();
  return { classId: classRef.id, code };
});

// ───────── 학생: 반 코드 + 번호 + PIN 으로 입장 ─────────
export const joinClass = onCall(async (req) => {
  const code = String(req.data?.code ?? '').toUpperCase().trim();
  const no = Number(req.data?.no);
  const pin = String(req.data?.pin ?? '');
  if (!/^[A-Z0-9]{6}$/.test(code) || !Number.isInteger(no) || !/^\d{4}$/.test(pin)) throw new HttpsError('invalid-argument', '반 코드, 번호, 비밀 숫자를 다시 확인해 주세요.');
  const codeDoc = await db.doc(`codes/${code}`).get();
  if (!codeDoc.exists) throw new HttpsError('not-found', '반 코드를 찾을 수 없어요.');
  const classId = codeDoc.data()!.classId as string;
  // 비밀 숫자를 10분에 5번 넘게 틀리면 잠근다
  const attemptRef = db.doc(`classes/${classId}/private/attempts_${no}`);
  const att = (await attemptRef.get()).data();
  const now = Date.now();
  if (att && att.count >= 5 && now - att.since < 10 * 60_000) throw new HttpsError('resource-exhausted', '여러 번 틀렸어요. 10분 뒤에 다시 하거나 선생님께 말씀드려요.');
  const pins = (await db.doc(`classes/${classId}/private/pins`).get()).data()?.pins ?? {};
  if (pins[no] !== pin) {
    const fresh = !att || now - att.since >= 10 * 60_000;
    await attemptRef.set({ count: fresh ? 1 : att!.count + 1, since: fresh ? now : att!.since });
    throw new HttpsError('permission-denied', '번호나 비밀 숫자가 맞지 않아요.');
  }
  await attemptRef.delete().catch(() => {});
  const uid = `s_${classId}_${no}`;
  const token = await getAuth().createCustomToken(uid, { role: 'student', classId, no });
  return { token };
});

// ───────── 학생: 생성 요청 (검사 → 번역 → 기록 → 크레딧 → 승인 대기 또는 대기열) ─────────
export const requestGeneration = onCall({ timeoutSeconds: 60 }, async (req) => {
  const { classId, no } = requireStudent(req);
  const kind = req.data?.kind as Kind;
  const sceneId = String(req.data?.sceneId ?? '').slice(0, 60);
  const builder = (req.data?.builder ?? {}) as Builder;
  const editText = String(req.data?.editText ?? '').trim().slice(0, 120);
  const parentId = req.data?.parentId ? String(req.data.parentId) : undefined;
  if (!['draft', 'edit', 'final'].includes(kind) || !sceneId) throw new HttpsError('invalid-argument', '요청이 올바르지 않아요.');

  const cls = (await db.doc(`classes/${classId}`).get()).data();
  if (!cls) throw new HttpsError('not-found', '반을 찾을 수 없어요.');
  if (cls.paused) throw new HttpsError('failed-precondition', '선생님이 화면을 잠시 멈췄어요.');
  if (cls.open < OPEN_STAGE_FOR_AI) throw new HttpsError('failed-precondition', 'AI로 만들기 단계가 아직 열리지 않았어요.');
  const usage = (await db.doc(`usage/${classId}_${today()}`).get()).data();
  if ((usage?.costUsd ?? 0) >= cls.budgetUsd) throw new HttpsError('resource-exhausted', '오늘 우리 반 예산을 다 썼어요. 선생님께 말씀드려요.');

  const img = cls.band === 'middle' && !cls.videoInMiddle;
  const spec = specFor(kind, img);

  // 부모(수정·완성본의 원본) 확인
  let parent: FirebaseFirestore.DocumentData | undefined;
  if (kind !== 'draft') {
    if (!parentId) throw new HttpsError('invalid-argument', '어떤 결과를 고칠지 알 수 없어요.');
    parent = (await db.doc(`generations/${parentId}`).get()).data();
    if (!parent || parent.classId !== classId || parent.no !== no || parent.status !== 'succeeded') throw new HttpsError('failed-precondition', '고칠 원본을 찾을 수 없어요.');
    if (!parent.judgement) throw new HttpsError('failed-precondition', '먼저 결과가 의도와 맞는지 판단을 저장해 주세요.');
  }
  if (kind === 'edit') {
    const edits = (await db.collection('generations').where('classId', '==', classId).where('no', '==', no).where('sceneId', '==', sceneId).where('kind', '==', 'edit').get()).size;
    if (edits >= MAX_EDITS) throw new HttpsError('failed-precondition', `이 장면은 ${MAX_EDITS}번까지만 고칠 수 있어요.`);
  }

  const promptKo = kind === 'edit' ? `${parent!.promptKo} → 수정: ${editText}` : kind === 'final' ? parent!.promptKo : buildPromptKo(builder);
  const checkText = kind === 'edit' ? editText : promptKo;
  if (!checkText) throw new HttpsError('invalid-argument', '빈칸을 채워 주세요.');
  const kindLabel = (img ? '이미지 ' : '영상 ') + (kind === 'draft' ? '초안' : kind === 'edit' ? '대화형 수정' : '장면 확정');
  const genRef = db.collection('generations').doc();
  const base = { classId, no, sceneId, kind, img, promptKo, editText: kind === 'edit' ? editText : null, res: spec.res, sec: spec.sec, hue: hueOf(genRef.id), parentId: parentId ?? null, createdAt: FieldValue.serverTimestamp() };

  const block = async (category: string, reason: string, suggestion: string, layer: string) => {
    await Promise.all([
      genRef.set({ ...base, status: 'blocked', rejectReason: `${reason}|${suggestion}`, promptEn: null }),
      log({ classId, no, kind: kindLabel, textKo: checkText, verdict: 'blocked', category, action: '차단', layer }),
      db.doc(`classes/${classId}/students/${no}`).update({ status: 'blocked', blockedAt: FieldValue.serverTimestamp() }),
    ]);
    return { genId: genRef.id, blocked: true, category, reason, suggestion };
  };

  // 장면 확정: 학생이 고른 결과를 그대로 장면으로 쓴다. 새로 만들지 않으므로 비용·크레딧이 없다.
  if (kind === 'final') {
    await genRef.set({
      ...base, status: 'succeeded', promptEn: parent!.promptEn ?? '', editEn: null, credits: 0, costUsd: 0,
      storagePath: parent!.storagePath ?? null, mimeType: parent!.mimeType ?? null, interactionId: parent!.interactionId ?? null,
      mock: !!parent!.mock, res: parent!.res, sec: parent!.sec, hue: parent!.hue ?? base.hue, doneAt: FieldValue.serverTimestamp(),
    });
    await log({ classId, no, kind: kindLabel, textKo: promptKo, verdict: 'pass', action: `확정 (판단: ${parent!.judgement?.fit ?? '-'})` });
    return { genId: genRef.id, blocked: false };
  }

  // 1단계: 규칙 검사
  {
    const r = moderateRules(checkText);
    if (!r.pass) return block(r.category!, r.reason!, r.suggestion!, 'rule');
  }
  // 2단계: Gemini 맥락 검사 + 번역 (가짜 모드에서는 TEXT_CHECK=on 일 때만)
  let promptEn = parent?.promptEn ?? '';
  let editEn: string | undefined;
  const useAi = CONFIG.videoProvider() === 'omni' || process.env.TEXT_CHECK === 'on';
  {
    if (useAi) {
      const c = await checkAndTranslate(checkText, kind === 'edit' ? 'edit' : 'prompt');
      if (!c.safe) return block(c.category ?? '기타', c.reasonKo ?? '안전하지 않은 표현이 있어요.', c.suggestionKo ?? '다른 말로 바꿔 써 보세요.', 'ai');
      if (kind === 'edit') { editEn = c.english; promptEn = `${parent!.promptEn} Change: ${c.english}`; } else promptEn = c.english;
    } else {
      if (kind === 'edit') { editEn = `(mock) ${editText}`; promptEn = `${parent!.promptEn} Change: ${editEn}`; } else promptEn = `(mock translation) ${promptKo}`;
    }
  }

  const needApproval = !!cls.approval;
  const status = needApproval ? 'awaiting_approval' : 'queued';
  const studentRef = db.doc(`classes/${classId}/students/${no}`);
  await db.runTransaction(async (tx) => {
    const st = await tx.get(studentRef);
    const credits = st.data()?.credits ?? 0;
    if (credits < spec.credits) throw new HttpsError('resource-exhausted', '크레딧이 부족해요. 선생님께 말씀드려요.');
    tx.update(studentRef, { credits: credits - spec.credits, status: needApproval ? 'waiting' : 'making' });
    tx.set(genRef, { ...base, status, promptEn, editEn: editEn ?? null, credits: spec.credits, costUsd: spec.costUsd, previousInteractionId: kind === 'edit' ? parent!.interactionId ?? null : null });
  });
  await log({ classId, no, kind: kindLabel, textKo: checkText, textEn: editEn ?? promptEn, verdict: 'pass', action: needApproval ? '승인 대기' : '대기열', layer: useAi ? 'ai' : 'rule' });
  if (!needApproval) await enqueue(genRef.id);
  return { genId: genRef.id, blocked: false };
});

// ───────── 교사: 승인 / 돌려보내기 ─────────
export const reviewGeneration = onCall(async (req) => {
  const uid = await requireTeacher(req);
  const genId = String(req.data?.genId ?? '');
  const approve = req.data?.approve === true;
  const reason = String(req.data?.reason ?? '').slice(0, 80);
  const ref = db.doc(`generations/${genId}`);
  const g = (await ref.get()).data();
  if (!g) throw new HttpsError('not-found', '요청을 찾을 수 없어요.');
  await ownedClass(uid, g.classId);
  if (g.status !== 'awaiting_approval') return { ok: true };
  if (approve) {
    await ref.update({ status: 'queued', reviewedBy: uid });
    await db.doc(`classes/${g.classId}/students/${g.no}`).update({ status: 'making' });
    await log({ classId: g.classId, no: g.no, kind: '교사 승인', textKo: g.editText ?? g.promptKo, textEn: g.promptEn, verdict: 'pass', action: '승인' });
    await enqueue(genId);
  } else {
    await ref.update({ status: 'rejected', rejectReason: reason || '선생님이 다시 생각해 보라고 했어요', reviewedBy: uid });
    await db.doc(`classes/${g.classId}/students/${g.no}`).update({ credits: FieldValue.increment(g.credits ?? 0), status: 'idle' });
    await log({ classId: g.classId, no: g.no, kind: '교사 반려', textKo: g.editText ?? g.promptKo, verdict: 'pass', action: `반려: ${reason}` });
  }
  return { ok: true };
});

// ───────── 교사: 비밀 숫자 다시 만들기 (한 학생) ─────────
export const resetPin = onCall(async (req) => {
  const uid = await requireTeacher(req);
  const classId = String(req.data?.classId ?? '');
  const no = Number(req.data?.no);
  await ownedClass(uid, classId);
  const pin = String(randomInt(10000)).padStart(4, '0');
  await db.doc(`classes/${classId}/private/pins`).set({ pins: { [no]: pin } }, { merge: true });
  return { pin };
});

// ───────── 학생: 기록만 남기는 이벤트 (영상 업로드 등) ─────────
export const logEvent = onCall(async (req) => {
  const { classId, no } = requireStudent(req);
  const kind = String(req.data?.kind ?? '').slice(0, 30);
  if (!['영상 업로드'].includes(kind)) throw new HttpsError('invalid-argument', '기록할 수 없는 종류예요.');
  await log({ classId, no, kind, textKo: String(req.data?.textKo ?? '').slice(0, 200), verdict: 'pass', action: String(req.data?.action ?? '').slice(0, 40) });
  return { ok: true };
});

// ───────── 대기열 작업자: 실제 생성 ─────────
export const runGeneration = onTaskDispatched(
  {
    retryConfig: { maxAttempts: 3, minBackoffSeconds: 30 },
    rateLimits: { maxConcurrentDispatches: CONFIG.maxConcurrent() },
    timeoutSeconds: 1800,
    memory: '1GiB',
  },
  async (req) => {
    const genId = String((req.data as any)?.genId ?? '');
    const ref = db.doc(`generations/${genId}`);
    const g = (await ref.get()).data();
    if (!g || !['queued', 'running'].includes(g.status)) return;
    const studentRef = db.doc(`classes/${g.classId}/students/${g.no}`);
    await ref.update({ status: 'running', startedAt: FieldValue.serverTimestamp() });

    const fail = async (status: 'failed' | 'blocked', message: string) => {
      await ref.update({ status, error: message, rejectReason: status === 'blocked' ? `AI가 만들 수 없는 장면이었어요.|다른 말로 바꿔 다시 해 보세요.` : null });
      await studentRef.update({ credits: FieldValue.increment(g.credits ?? 0), status: 'idle' });
      await log({ classId: g.classId, no: g.no, kind: '생성 실패', textKo: g.editText ?? g.promptKo, verdict: status === 'blocked' ? 'blocked' : 'pass', category: status === 'blocked' ? '모델 안전 차단' : undefined, action: `${message.slice(0, 60)} · 크레딧 환불` });
    };

    try {
      const result = await provider().generate({
        promptEn: g.promptEn, editEn: g.editEn ?? undefined, previousInteractionId: g.previousInteractionId ?? undefined,
        res: g.res, sec: g.sec, img: g.img,
      });
      let storagePath: string | null = null;
      if (result.bytes) {
        const ext = result.mimeType.includes('png') ? 'png' : result.mimeType.includes('jpeg') ? 'jpg' : 'mp4';
        storagePath = `classes/${g.classId}/${g.no}/gens/${genId}.${ext}`;
        await getStorage().bucket().file(storagePath).save(result.bytes, {
          contentType: result.mimeType,
          metadata: { metadata: { aiGenerated: 'true', model: CONFIG.videoProvider() === 'omni' ? (g.img ? CONFIG.imageModel() : CONFIG.omniModel()) : 'mock' } },
        });
      }
      await ref.update({ status: 'succeeded', storagePath, mimeType: result.mimeType, interactionId: result.interactionId ?? null, mock: !!result.mock, doneAt: FieldValue.serverTimestamp() });
      await studentRef.update({ status: 'idle' });
      const cost = result.mock ? 0 : g.costUsd ?? 0;
      await db.doc(`usage/${g.classId}_${today()}`).set(
        { classId: g.classId, costUsd: FieldValue.increment(cost), videoSec: FieldValue.increment(g.img ? 0 : g.sec), count: FieldValue.increment(1), updatedAt: Timestamp.now() },
        { merge: true },
      );
    } catch (e: any) {
      logger.error('generation failed', { genId, err: String(e?.message ?? e) });
      if (e instanceof SafetyBlockedError) return fail('blocked', '모델 안전 정책에 걸림');
      const last = (req.retryCount ?? 0) >= 2;
      if (last) return fail('failed', String(e?.message ?? '알 수 없는 오류'));
      await ref.update({ status: 'queued' });
      throw e; // 대기열이 잠시 뒤 다시 시도한다
    }
  },
);

// ───────── 중등: 시나리오 초안 (목적·역할·내용·조건) ─────────
export const draftScenario = onCall({ timeoutSeconds: 60 }, async (req) => {
  const { classId, no } = requireStudent(req);
  const f = req.data ?? {};
  const fields = ['goal', 'role', 'content', 'cond', 'topic'].map((k) => String(f[k] ?? '').slice(0, 200));
  const joined = fields.filter(Boolean).join(' / ');
  if (!joined) throw new HttpsError('invalid-argument', '프롬프트 칸을 채워 주세요.');
  const r = moderateRules(joined);
  if (!r.pass) {
    await log({ classId, no, kind: '시나리오 초안', textKo: joined, verdict: 'blocked', category: r.category, action: '차단', layer: 'rule' });
    return { blocked: true, reason: r.reason, lines: [] };
  }
  const useAi = CONFIG.videoProvider() === 'omni' || process.env.TEXT_CHECK === 'on';
  let lines: string[];
  if (!useAi) {
    lines = ['장면 1. (가짜 모드) 주인공이 등장한다.', '장면 2. (가짜 모드) AI를 사용한다.', '장면 3. (가짜 모드) 일이 해결된다.', '장면 4. (가짜 모드) 주인공이 느낀 점을 말한다.'];
  } else {
    const { genai } = await import('./ai/client');
    const res: any = await genai().models.generateContent({
      model: CONFIG.textModel(),
      contents: [{ role: 'user', parts: [{ text: `목적: ${fields[0]}\n역할: ${fields[1]}\n내용: ${fields[2]}\n조건: ${fields[3]}\n주제: ${fields[4]}` }] }],
      config: {
        systemInstruction: '중학생이 만드는 60초 이내 영상의 시나리오 초안을 쓴다. 장면마다 한 문장, "장면 N. ..." 형식. 폭력·혐오·개인정보·실존 인물은 쓰지 않는다. 학생이 고칠 수 있게 일부러 완벽하지 않아도 된다. JSON 문자열 배열만 출력한다.',
        temperature: 0.7,
        responseMimeType: 'application/json',
        responseSchema: { type: 'ARRAY', items: { type: 'STRING' } },
      } as any,
    });
    try {
      lines = (JSON.parse(res.text ?? '[]') as string[]).map((l) => String(l).slice(0, 200)).slice(0, 8);
    } catch {
      throw new HttpsError('internal', '초안을 만들지 못했어요. 다시 해 보세요.');
    }
  }
  await log({ classId, no, kind: '시나리오 초안', textKo: joined, textEn: lines.join(' | '), verdict: 'pass', action: 'AI 초안 받음', layer: useAi ? 'ai' : 'rule' });
  return { blocked: false, lines };
});

// ───────── 학생: 편집한 장면을 한 편의 MP4 로 합치기 ─────────

export const renderVideo = onCall({ timeoutSeconds: 540, memory: '2GiB', cpu: 2, concurrency: 1, maxInstances: 15 }, async (req) => {
  const { classId, no } = requireStudent(req);
  const pid = `${classId}_${no}`;
  const projRef = db.doc(`projects/${pid}`);
  const p = (await projRef.get()).data();
  const cls = (await db.doc(`classes/${classId}`).get()).data();
  if (!p || !cls) throw new HttpsError('not-found', '작업을 찾을 수 없어요.');
  if (p.rendering && Date.now() - p.rendering < 10 * 60_000) throw new HttpsError('failed-precondition', '이미 영상을 만들고 있어요. 잠시만 기다려 주세요.');
  const limit = cls.band === 'elementary' ? 30 : 60;

  // 타임라인 순서: 저장된 순서 + 새로 생긴 장면·업로드는 뒤에 (화면과 같은 규칙)
  const scenes: any[] = p.scenes ?? [];
  const uploads: any[] = p.uploads ?? [];
  const all = [...scenes.map((s) => s.id), ...uploads.map((u) => u.id)];
  const kept = (p.order ?? []).filter((k: string) => all.includes(k));
  const keys = [...kept, ...all.filter((k) => !kept.includes(k))];
  const total = (p.intro?.dur ?? 3) + (p.outro?.dur ?? 3) + keys.reduce((a, k) => a + ((scenes.find((s) => s.id === k) ?? uploads.find((u) => u.id === k))?.dur ?? 0), 0);
  if (total > limit) throw new HttpsError('failed-precondition', `영상이 ${limit}초를 넘었어요. 길이를 줄여 주세요.`);

  await projRef.update({ rendering: Date.now() });
  const dir = mkdtempSync(pjoin(tmpdir(), 'render-'));
  const bucket = getStorage().bucket();
  const fetchFile = async (path: string, name: string) => {
    const local = pjoin(dir, name);
    await bucket.file(path).download({ destination: local });
    return local;
  };
  const useAi = CONFIG.videoProvider() === 'omni' || process.env.TEXT_CHECK === 'on';
  const gens = (await db.collection('generations').where('classId', '==', classId).where('no', '==', no).get()).docs.map((d) => ({ id: d.id, ...(d.data() as any) }));

  try {
    const voiceFor = async (item: any, i: number) => {
      if (item.voice === '내 목소리' && item.voicePath) return fetchFile(item.voicePath, `voice_${i}`);
      if (isAiVoice(item.voice) && item.caption && useAi) return speak(item.caption, item.voice, pjoin(dir, `tts_${i}.wav`)).catch(() => undefined);
      return undefined;
    };
    const clips: Clip[] = [{ kind: 'title', dur: p.intro?.dur ?? 3, text: p.intro?.caption || p.topic || 'AI로 달라진 나의 일상' }];
    let i = 0;
    for (const k of keys) {
      i++;
      const sc = scenes.find((s) => s.id === k);
      if (sc) {
        const g = gens.find((x) => x.id === sc.selectedGenId) ?? gens.filter((x) => x.sceneId === sc.id && x.status === 'succeeded').pop();
        const voice = await voiceFor(sc, i);
        if (g?.storagePath) {
          const src = await fetchFile(g.storagePath, `gen_${i}`);
          const dur = g.img ? sc.dur : Math.min(sc.dur, g.sec ?? sc.dur);
          clips.push({ kind: g.img ? 'image' : 'video', dur, src, caption: sc.caption, voice, aiBadge: true });
        } else {
          clips.push({ kind: 'placeholder', dur: sc.dur, text: sc.line || `장면 ${i}`, caption: sc.caption, voice });
        }
        continue;
      }
      const u = uploads.find((x) => x.id === k);
      if (u?.path) {
        const src = await fetchFile(u.path, `up_${i}`);
        const voice = await voiceFor(u, i);
        clips.push({ kind: 'video', dur: u.dur, src, caption: u.caption, keepAudio: u.voice === '원래 소리', voice });
      }
    }
    clips.push({ kind: 'outro', dur: p.outro?.dur ?? 3, text: p.outro?.caption || '' });

    // 배경음악: Storage 의 bgm/{이름}.mp3 (라이선스를 확인한 파일만 올려 두기)
    let bgm: string | undefined;
    if (p.bgm && p.bgm !== '없음') {
      // Mac 에서 올린 한글 파일 이름은 자모가 풀어진(NFD) 형태일 수 있어 두 형태를 모두 찾는다
      for (const n of [String(p.bgm).normalize('NFC'), String(p.bgm).normalize('NFD')]) {
        if ((await bucket.file(`bgm/${n}.mp3`).exists())[0]) {
          bgm = await fetchFile(`bgm/${n}.mp3`, 'bgm.mp3');
          break;
        }
      }
    }

    const out = await renderAll(clips, dir, bgm);
    const exportId = `${Date.now()}`;
    const path = `classes/${classId}/${no}/exports/${exportId}.mp4`;
    await bucket.upload(out, { destination: path, contentType: 'video/mp4', metadata: { metadata: { aiGenerated: 'true', notice: 'AI 생성 콘텐츠 포함' } } });
    await projRef.update({ lastExport: { path, at: Date.now(), dur: total, bgmMissing: !!(p.bgm && p.bgm !== '없음' && !bgm) }, rendering: FieldValue.delete() });
    await log({ classId, no, kind: '완성 영상', textKo: `${total}초 · 클립 ${clips.length}개`, verdict: 'pass', action: '영상 저장' });
    return { path, bgmMissing: !!(p.bgm && p.bgm !== '없음' && !bgm) };
  } catch (e: any) {
    logger.error('render failed', { pid, err: String(e?.message ?? e) });
    await projRef.update({ rendering: FieldValue.delete() });
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('internal', '영상을 합치지 못했어요. 잠시 뒤 다시 해 보세요.');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ───────── 연습 모드(에뮬레이터) 전용: 교사 계정 바로 승인 ─────────
// 실제 배포 환경에서는 FUNCTIONS_EMULATOR 가 없으므로 항상 거절된다.
export const devApproveTeacher = onCall(async (req) => {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') throw new HttpsError('permission-denied', '연습 모드에서만 쓸 수 있어요.');
  const a = req.auth;
  if (!a || a.token.firebase?.sign_in_provider !== 'google.com') throw new HttpsError('unauthenticated', 'Google 계정으로 로그인해 주세요.');
  await db.doc(`teachers/${a.uid}`).set({ approved: true, email: a.token.email ?? null, approvedBy: 'emulator', at: FieldValue.serverTimestamp() }, { merge: true });
  return { ok: true };
});
