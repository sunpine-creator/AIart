import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldPath, FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { getFunctions } from 'firebase-admin/functions';
import { getStorage } from 'firebase-admin/storage';
import { setGlobalOptions } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { logger } from 'firebase-functions';
import { randomInt, randomUUID } from 'node:crypto';
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
// 학생 이름: 한글·영어·공백만, 1~12자. 비교할 때는 공백과 대소문자를 무시한다
const cleanName = (v: unknown) => String(v ?? '').normalize('NFC').trim().replace(/\s+/g, ' ');
const nameKey = (v: string) => v.replace(/\s/g, '').toLowerCase();
const validName = (v: string) => v.length >= 1 && v.length <= 12 && /^[가-힣ㄱ-ㅎa-zA-Z ]+$/.test(v);
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 0·O·1·I 제외
const today = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, ''); // 서울 날짜
// 다운로드 토큰이 붙은 파일 주소. 이 주소는 생성 기록(학생 본인·교사만 읽을 수 있음)에만 저장한다.
const mediaUrl = (path: string, token: string) => {
  const bucket = getStorage().bucket().name;
  return process.env.FUNCTIONS_EMULATOR === 'true'
    ? `http://${process.env.FIREBASE_STORAGE_EMULATOR_HOST ?? '127.0.0.1:9199'}/v0/b/${bucket}/o/${encodeURIComponent(path)}?alt=media&token=${token}`
    : `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
};
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
  const batch = db.batch();
  batch.set(classRef, {
    teacherUid: uid, title: String(title).slice(0, 40), band, code, size: n,
    open: 1, paused: false, approval: true, videoInMiddle: false,
    budgetUsd: Number(budgetUsd) || (band === 'elementary' ? 71 : 29),
    createdAt: FieldValue.serverTimestamp(),
  });
  batch.set(db.doc(`codes/${code}`), { classId: classRef.id });
  for (let no = 1; no <= n; no++) {
    batch.set(classRef.collection('students').doc(String(no)), { no, nick: '', name: null, credits, stage: 1, status: 'idle', lastSeen: null });
  }
  await batch.commit();
  return { classId: classRef.id, code };
});

// ───────── 학생: 반 코드 + 번호 + 이름으로 입장 ─────────
// 그 번호로 처음 들어올 때 쓴 이름이 저장되고, 다음부터는 같은 이름이어야 들어올 수 있다.
export const joinClass = onCall(async (req) => {
  const code = String(req.data?.code ?? '').toUpperCase().trim();
  const no = Number(req.data?.no);
  const name = cleanName(req.data?.name);
  if (!/^[A-Z0-9]{6}$/.test(code) || !Number.isInteger(no) || no < 1 || no > 40) throw new HttpsError('invalid-argument', '반 코드와 번호를 다시 확인해 주세요.');
  if (!validName(name)) throw new HttpsError('invalid-argument', '이름은 한글이나 영어로 12자까지 써 주세요.');
  const codeDoc = await db.doc(`codes/${code}`).get();
  if (!codeDoc.exists) throw new HttpsError('not-found', '반 코드를 찾을 수 없어요.');
  const classId = codeDoc.data()!.classId as string;
  // 이름을 10분에 5번 넘게 틀리면 잠근다
  const attemptRef = db.doc(`classes/${classId}/private/attempts_${no}`);
  const att = (await attemptRef.get()).data();
  const now = Date.now();
  if (att && att.count >= 5 && now - att.since < 10 * 60_000) throw new HttpsError('resource-exhausted', '여러 번 틀렸어요. 10분 뒤에 다시 하거나 선생님께 말씀드려요.');
  const stRef = db.doc(`classes/${classId}/students/${no}`);
  const result = await db.runTransaction(async (tx) => {
    const st = await tx.get(stRef);
    if (!st.exists) return 'noseat' as const;
    const saved = st.data()?.name as string | null | undefined;
    if (!saved) {
      tx.update(stRef, { name, nick: name, registeredAt: FieldValue.serverTimestamp() });
      return 'new' as const;
    }
    return nameKey(saved) === nameKey(name) ? ('ok' as const) : ('mismatch' as const);
  });
  if (result === 'noseat') throw new HttpsError('not-found', '이 반에 없는 번호예요. 번호를 확인해 주세요.');
  if (result === 'mismatch') {
    const fresh = !att || now - att.since >= 10 * 60_000;
    await attemptRef.set({ count: fresh ? 1 : att!.count + 1, since: fresh ? now : att!.since });
    throw new HttpsError('permission-denied', '이 번호는 다른 이름으로 이미 들어왔어요. 번호를 확인하고, 맞다면 선생님께 말씀드려요.');
  }
  await attemptRef.delete().catch(() => {});
  if (result === 'new') await log({ classId, no, kind: '입장', textKo: `처음 입장 · 이름 등록`, verdict: 'pass', action: '입장' });
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
    // 차단·반려·실패한 수정은 횟수에 넣지 않는다
    const edits = (await db.collection('generations').where('classId', '==', classId).where('no', '==', no).where('sceneId', '==', sceneId).where('kind', '==', 'edit').get()).docs.filter((d) => !['blocked', 'rejected', 'failed'].includes(d.data().status)).length;
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
      storagePath: parent!.storagePath ?? null, url: parent!.url ?? null, mimeType: parent!.mimeType ?? null, interactionId: parent!.interactionId ?? null,
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

  // 승인 모드: 선생님이 승인할 때 크레딧이 줄어든다(반려하면 줄지 않음). 승인 없이 바로 만들 때는 지금 줄어든다.
  const needApproval = !!cls.approval;
  const status = needApproval ? 'awaiting_approval' : 'queued';
  const studentRef = db.doc(`classes/${classId}/students/${no}`);
  const sceneGens = db.collection('generations').where('classId', '==', classId).where('no', '==', no).where('sceneId', '==', sceneId);
  await db.runTransaction(async (tx) => {
    const [st, prev] = await Promise.all([tx.get(studentRef), tx.get(sceneGens)]);
    const live = prev.docs.map((d) => d.data()).filter((x) => ['awaiting_approval', 'queued', 'running', 'succeeded'].includes(x.status));
    if (live.some((x) => ['awaiting_approval', 'queued', 'running'].includes(x.status))) throw new HttpsError('already-exists', '이 장면은 이미 만드는 중이에요. 결과가 나올 때까지 기다려 주세요.');
    if (kind === 'draft' && live.some((x) => x.kind === 'draft')) throw new HttpsError('already-exists', '초안은 장면마다 한 번만 만들 수 있어요. 결과를 판단한 뒤 "고쳐서 다시 만들기"를 써 주세요.');
    const credits = st.data()?.credits ?? 0;
    if (credits < spec.credits) throw new HttpsError('resource-exhausted', '크레딧이 부족해요. 선생님께 말씀드려요.');
    tx.update(studentRef, { ...(needApproval ? {} : { credits: credits - spec.credits }), status: needApproval ? 'waiting' : 'making' });
    tx.set(genRef, { ...base, status, promptEn, editEn: editEn ?? null, credits: spec.credits, charged: !needApproval, costUsd: spec.costUsd, previousInteractionId: kind === 'edit' ? parent!.interactionId ?? null : null });
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
  const studentRef = db.doc(`classes/${g.classId}/students/${g.no}`);
  if (approve) {
    await db.runTransaction(async (tx) => {
      const [cur, st] = await Promise.all([tx.get(ref), tx.get(studentRef)]);
      if (cur.data()?.status !== 'awaiting_approval') throw new HttpsError('failed-precondition', '이미 처리된 요청이에요.');
      const need = cur.data()?.charged === false ? Number(cur.data()?.credits ?? 0) : 0;
      const credits = st.data()?.credits ?? 0;
      if (credits < need) throw new HttpsError('resource-exhausted', `${g.no}번 학생의 크레딧이 부족해요. 크레딧을 늘려 주거나 돌려보내 주세요.`);
      tx.update(studentRef, { ...(need ? { credits: credits - need } : {}), status: 'making' });
      tx.update(ref, { status: 'queued', reviewedBy: uid, charged: true });
    });
    await log({ classId: g.classId, no: g.no, kind: '교사 승인', textKo: g.editText ?? g.promptKo, textEn: g.promptEn, verdict: 'pass', action: '승인' });
    await enqueue(genId);
  } else {
    await ref.update({ status: 'rejected', rejectReason: reason || '선생님이 다시 생각해 보라고 했어요', reviewedBy: uid });
    await studentRef.update({ ...(g.charged === false ? {} : { credits: FieldValue.increment(g.credits ?? 0) }), status: 'idle' });
    await log({ classId: g.classId, no: g.no, kind: '교사 반려', textKo: g.editText ?? g.promptKo, verdict: 'pass', action: `반려: ${reason}` });
  }
  return { ok: true };
});

// ───────── 교사: 학생 이름 고치기·지우기 (함수 이름은 예전 그대로 resetPin) ─────────
// name 을 주면 그 이름으로 바꾸고, 비우면 지워서 학생이 다음에 들어올 때 새로 등록하게 한다.
export const resetPin = onCall(async (req) => {
  const uid = await requireTeacher(req);
  const classId = String(req.data?.classId ?? '');
  const no = Number(req.data?.no);
  await ownedClass(uid, classId);
  const name = cleanName(req.data?.name);
  if (name && !validName(name)) throw new HttpsError('invalid-argument', '이름은 한글이나 영어로 12자까지 써 주세요.');
  await db.doc(`classes/${classId}/students/${no}`).update({ name: name || null, nick: name || '' });
  await db.doc(`classes/${classId}/private/attempts_${no}`).delete().catch(() => {});
  return { ok: true };
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
      await studentRef.update({ ...(g.charged === false ? {} : { credits: FieldValue.increment(g.credits ?? 0) }), status: 'idle' });
      await log({ classId: g.classId, no: g.no, kind: '생성 실패', textKo: g.editText ?? g.promptKo, verdict: status === 'blocked' ? 'blocked' : 'pass', category: status === 'blocked' ? '모델 안전 차단' : undefined, action: `${message.slice(0, 60)} · 크레딧 환불` });
    };

    try {
      const result = await provider().generate({
        promptEn: g.promptEn, editEn: g.editEn ?? undefined, previousInteractionId: g.previousInteractionId ?? undefined,
        res: g.res, sec: g.sec, img: g.img,
      });
      let storagePath: string | null = null;
      let url: string | null = null;
      if (result.bytes) {
        const token = randomUUID();
        const ext = result.mimeType.includes('png') ? 'png' : result.mimeType.includes('jpeg') ? 'jpg' : 'mp4';
        storagePath = `classes/${g.classId}/${g.no}/gens/${genId}.${ext}`;
        await getStorage().bucket().file(storagePath).save(result.bytes, {
          contentType: result.mimeType,
          metadata: { metadata: { firebaseStorageDownloadTokens: token, aiGenerated: 'true', model: CONFIG.videoProvider() === 'omni' ? (g.img ? CONFIG.imageModel() : CONFIG.omniModel()) : 'mock' } },
        });
        url = mediaUrl(storagePath, token);
      }
      if (!result.mock && !url) throw new Error('AI가 영상 파일을 돌려주지 않았어요');
      await ref.update({ status: 'succeeded', storagePath, url, mimeType: result.mimeType, interactionId: result.interactionId ?? null, mock: !!result.mock, doneAt: FieldValue.serverTimestamp() });
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
      await ref.update({ status: 'queued', attempt: (req.retryCount ?? 0) + 1, lastError: String(e?.message ?? e).slice(0, 300) });
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
  const all = [...scenes.filter((s) => !s.skip).map((s) => s.id), ...uploads.map((u) => u.id)];
  const kept = (p.order ?? []).filter((k: string) => all.includes(k));
  const keys = [...kept, ...all.filter((k) => !kept.includes(k))];
  const total = (p.intro?.dur ?? 3) + (p.outro?.dur ?? 3) + keys.reduce((a, k) => a + ((scenes.find((s) => s.id === k) ?? uploads.find((u) => u.id === k))?.dur ?? 0), 0);
  if (total > limit) throw new HttpsError('failed-precondition', `영상이 ${limit}초를 넘었어요. 길이를 줄여 주세요.`);

  await projRef.update({ rendering: Date.now() });
  const dir = mkdtempSync(pjoin(tmpdir(), 'render-'));
  const bucket = getStorage().bucket();
  const missingFiles: string[] = [];
  // 파일이 없거나 못 받으면 전체를 멈추지 않고 그 조각만 건너뛴다
  const fetchFile = async (path: string, name: string): Promise<string | undefined> => {
    const local = pjoin(dir, name);
    try {
      await bucket.file(path).download({ destination: local });
      return local;
    } catch (e: any) {
      logger.warn('render: 파일을 받지 못함', { path, err: String(e?.message ?? e) });
      missingFiles.push(path);
      return undefined;
    }
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
        const src = g?.storagePath ? await fetchFile(g.storagePath, `gen_${i}`) : undefined;
        if (g && src) {
          const start = g.img ? 0 : Math.max(0, Math.min(Number(sc.start) || 0, (g.sec ?? 3) - 1));
          const dur = g.img ? sc.dur : Math.min(sc.dur, (g.sec ?? sc.dur) - start);
          clips.push({ kind: g.img ? 'image' : 'video', dur, start, src, caption: sc.caption, capStyle: sc.capStyle, voice, aiBadge: true });
        } else {
          clips.push({ kind: 'placeholder', dur: sc.dur, text: sc.line || `장면 ${i}`, caption: sc.caption, capStyle: sc.capStyle, voice });
        }
        continue;
      }
      const u = uploads.find((x) => x.id === k);
      const usrc = u?.path ? await fetchFile(u.path, `up_${i}`) : undefined;
      if (u && usrc) {
        const src = usrc;
        const voice = await voiceFor(u, i);
        clips.push({ kind: 'video', dur: u.dur, start: Math.max(0, Number(u.start) || 0), src, caption: u.caption, capStyle: u.capStyle, keepAudio: u.voice === '원래 소리', voice });
      }
    }
    clips.push({ kind: 'outro', dur: p.outro?.dur ?? 3, text: p.outro?.caption || '' });

    const out = await renderAll(clips, dir);
    const exportId = `${Date.now()}`;
    const path = `classes/${classId}/${no}/exports/${exportId}.mp4`;
    const token = randomUUID();
    await bucket.upload(out, { destination: path, contentType: 'video/mp4', metadata: { metadata: { firebaseStorageDownloadTokens: token, aiGenerated: 'true', notice: 'AI 생성 콘텐츠 포함' } } });
    await projRef.update({ lastExport: { path, url: mediaUrl(path, token), at: Date.now(), dur: total }, rendering: FieldValue.delete() });
    await log({ classId, no, kind: '완성 영상', textKo: `${total}초 · 클립 ${clips.length}개`, verdict: 'pass', action: '영상 저장' });
    return { path, missing: missingFiles.length };
  } catch (e: any) {
    logger.error('render failed', { pid, err: String(e?.message ?? e) });
    await projRef.update({ rendering: FieldValue.delete() });
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('unavailable', `영상을 합치지 못했어요. 잠시 뒤 다시 해 보세요. (원인: ${String(e?.message ?? e).replace(/\/[^\s]+/g, '').slice(0, 80)})`);
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

// ───────── 교사 승인 ─────────
// 관리자: functions/.env 의 ADMIN_EMAILS(쉼표로 구분)에 있는 계정.
// ADMIN_EMAILS 가 비어 있으면, 배포 뒤 처음 로그인한 교사가 관리자가 된다(config/admin 에 기록).
const adminEmails = () => (process.env.ADMIN_EMAILS ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
function googleUser(req: CallableRequest) {
  const a = req.auth;
  if (!a || a.token.firebase?.sign_in_provider !== 'google.com') throw new HttpsError('unauthenticated', 'Google 계정으로 로그인해 주세요.');
  return { uid: a.uid, email: String(a.token.email ?? '').toLowerCase(), name: String(a.token.name ?? '') };
}
async function isAdmin(uid: string, email: string) {
  if (email && adminEmails().includes(email)) return true;
  const c = await db.doc('config/admin').get();
  return c.exists && c.data()?.uid === uid;
}

// 교사가 로그인하면 부른다: 관리자면 바로 승인, 아니면 승인 요청을 남긴다.
export const claimTeacher = onCall(async (req) => {
  const u = googleUser(req);
  const tRef = db.doc(`teachers/${u.uid}`);
  const aRef = db.doc('config/admin');
  return db.runTransaction(async (tx) => {
    const [t, a] = await Promise.all([tx.get(tRef), tx.get(aRef)]);
    const listed = !!u.email && adminEmails().includes(u.email);
    const first = !a.exists && adminEmails().length === 0;
    const admin = listed || first || (a.exists && a.data()?.uid === u.uid);
    if (first) tx.set(aRef, { uid: u.uid, email: u.email, at: FieldValue.serverTimestamp() });
    if (admin) {
      tx.set(tRef, { approved: true, admin: true, email: u.email, name: u.name, approvedBy: 'admin-self', at: FieldValue.serverTimestamp() }, { merge: true });
      return { approved: true, admin: true };
    }
    if (t.exists && t.data()?.approved === true) return { approved: true, admin: false };
    if (!t.exists) tx.set(tRef, { approved: false, email: u.email, name: u.name, requestedAt: FieldValue.serverTimestamp() });
    return { approved: false, admin: false };
  });
});

// 관리자: 교사 목록 보기
export const adminTeachers = onCall(async (req) => {
  const u = googleUser(req);
  if (!(await isAdmin(u.uid, u.email))) throw new HttpsError('permission-denied', '관리자만 볼 수 있어요.');
  const qs = await db.collection('teachers').limit(200).get();
  const list = qs.docs.map((d) => {
    const x = d.data();
    const ms = (v: any) => (v instanceof Timestamp ? v.toMillis() : null);
    return { uid: d.id, email: x.email ?? '', name: x.name ?? '', approved: x.approved === true, admin: x.admin === true, requestedAt: ms(x.requestedAt) };
  });
  list.sort((a, b) => Number(a.approved) - Number(b.approved) || (b.requestedAt ?? 0) - (a.requestedAt ?? 0));
  return { list };
});

// 관리자: 승인하기 / 승인 취소
export const setTeacherApproval = onCall<{ uid: string; approved: boolean }>(async (req) => {
  const u = googleUser(req);
  if (!(await isAdmin(u.uid, u.email))) throw new HttpsError('permission-denied', '관리자만 할 수 있어요.');
  const { uid, approved } = req.data ?? ({} as any);
  if (typeof uid !== 'string' || !uid) throw new HttpsError('invalid-argument', '교사를 골라 주세요.');
  if (uid === u.uid && !approved) throw new HttpsError('failed-precondition', '내 계정의 승인은 취소할 수 없어요.');
  await db.doc(`teachers/${uid}`).set({ approved: !!approved, approvedBy: u.email, at: FieldValue.serverTimestamp() }, { merge: true });
  return { ok: true };
});

// ───────── 교사: 반 삭제 (연습한 반 정리) ─────────
// 반 문서와 학생 명단, 학생 작업, 생성 기록, 프롬프트 기록, 비용 기록, 저장된 영상까지 모두 지운다. 되돌릴 수 없다.
export const deleteClass = onCall({ timeoutSeconds: 300, memory: '512MiB' }, async (req) => {
  const uid = await requireTeacher(req);
  const classId = String(req.data?.classId ?? '');
  if (!classId) throw new HttpsError('invalid-argument', '지울 반을 골라 주세요.');
  const c = await ownedClass(uid, classId);
  const code = c.data()?.code as string | undefined;
  const dropQuery = async (q: FirebaseFirestore.Query) => {
    for (;;) {
      const snap = await q.limit(400).get();
      if (snap.empty) return;
      const b = db.batch();
      snap.docs.forEach((d) => b.delete(d.ref));
      await b.commit();
    }
  };
  await dropQuery(db.collection('projects').where('classId', '==', classId));
  await dropQuery(db.collection('generations').where('classId', '==', classId));
  await dropQuery(db.collection('promptLogs').where('classId', '==', classId));
  await dropQuery(db.collection('usage').where(FieldPath.documentId(), '>=', `${classId}_`).where(FieldPath.documentId(), '<', `${classId}_~`));
  if (code) await db.doc(`codes/${code}`).delete().catch(() => {});
  // 학생 로그인 계정도 지운다(다른 기기에 남은 로그인도 더 이상 쓸 수 없게)
  const size = Number(c.data()?.size ?? 40);
  await getAuth().deleteUsers(Array.from({ length: Math.max(1, Math.min(40, size)) }, (_, i) => `s_${classId}_${i + 1}`)).catch((e) => logger.warn('학생 계정 삭제 실패', e));
  await db.recursiveDelete(db.doc(`classes/${classId}`));
  await getStorage().bucket().deleteFiles({ prefix: `classes/${classId}/` }).catch((e) => logger.warn('반 파일 삭제 실패', e));
  logger.info('반 삭제', { classId, by: uid });
  return { ok: true };
});

// ───────── 학생: 내 영상·녹음 올리기 ─────────
// 브라우저가 Storage 에 바로 올리지 않고, 서버가 만든 "업로드 전용 주소"로 올린다.
// (보안 규칙·CORS 설정과 상관없이 동작. 이 주소는 이 파일 한 개에만 쓸 수 있다)
export const startUpload = onCall(async (req) => {
  const { classId, no } = requireStudent(req);
  const kind = String(req.data?.kind ?? '');
  const id = String(req.data?.id ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60);
  const contentType = String(req.data?.contentType ?? '').slice(0, 60);
  const size = Number(req.data?.size ?? 0);
  if (!id || !['upload', 'voice'].includes(kind)) throw new HttpsError('invalid-argument', '올릴 파일을 다시 골라 주세요.');
  if (kind === 'upload' && (!contentType.startsWith('video/') || size > 100 * 1024 * 1024)) throw new HttpsError('invalid-argument', '100MB 이하의 영상 파일만 올릴 수 있어요.');
  if (kind === 'voice' && (!contentType.startsWith('audio/') || size > 5 * 1024 * 1024)) throw new HttpsError('invalid-argument', '녹음 파일이 너무 커요. 더 짧게 녹음해 주세요.');
  const ext = String(req.data?.ext ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || (kind === 'voice' ? 'webm' : 'mp4');
  const path = `classes/${classId}/${no}/${kind === 'upload' ? 'uploads' : 'voices'}/${id}.${ext}`;
  const token = randomUUID();
  const origin = String(req.rawRequest?.headers?.origin ?? '') || undefined;
  const [sessionUrl] = await getStorage()
    .bucket()
    .file(path)
    .createResumableUpload({ origin, metadata: { contentType, metadata: { firebaseStorageDownloadTokens: token, uploadedBy: `${classId}_${no}` } } });
  return { path, sessionUrl, url: mediaUrl(path, token) };
});
