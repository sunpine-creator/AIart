import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldPath, FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { getFunctions } from 'firebase-admin/functions';
import { getStorage } from 'firebase-admin/storage';
import { setGlobalOptions } from 'firebase-functions/v2';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { logger } from 'firebase-functions';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { CONFIG, Kind, MAX_EDITS, OPEN_STAGE_FOR_AI, REGION, pickSec, specFor } from './config';
import { Builder, buildPromptKo, moderateRules } from './moderation';
import { World, checkAndTranslate, makeWorld } from './ai/text';
import { SafetyBlockedError, drawImage, provider } from './ai/video';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pjoin } from 'node:path';
import { Clip, Layers, TlCapIn, TlVoiceIn, XF, applyTimeline, concatCopy, joinXfade, lastFrame, mergeCuts, probeDur, renderSegment, sizeOf, toMp4 } from './render';
import { isAiVoice, speak, voiceId } from './ai/tts';

initializeApp();
setGlobalOptions({ region: REGION, maxInstances: 60 });
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
// 내 반이거나, 관리자면 모든 반을 다룰 수 있다
async function ownedClass(uid: string, classId: string) {
  const c = await db.doc(`classes/${classId}`).get();
  if (!c.exists) throw new HttpsError('not-found', '반을 찾을 수 없어요.');
  if (c.data()!.teacherUid !== uid) {
    const t = await db.doc(`teachers/${uid}`).get();
    if (t.data()?.admin !== true || t.data()?.approved !== true) throw new HttpsError('permission-denied', '내 반이 아니에요.');
  }
  return c;
}
function log(e: { classId: string; no: number; kind: string; textKo: string; textEn?: string; verdict: 'pass' | 'blocked'; category?: string; action: string; layer?: string }) {
  return db.collection('promptLogs').add({ ...e, at: FieldValue.serverTimestamp() });
}
async function enqueue(genId: string) {
  const q = getFunctions().taskQueue(`locations/${REGION}/functions/runGeneration`);
  try {
    await q.enqueue({ genId }, { dispatchDeadlineSeconds: 1800 });
  } catch (e: any) {
    // 대기열에 못 넣으면 "차례 기다리는 중"으로 영영 남지 않게 실패로 끝내고 크레딧을 돌려준다
    logger.error('enqueue failed', { genId, err: String(e?.message ?? e) });
    const ref = db.doc(`generations/${genId}`);
    const g = (await ref.get()).data();
    if (g && g.status === 'queued') {
      await ref.update({ status: 'failed', error: `대기열 오류: ${String(e?.message ?? e).slice(0, 120)}` });
      await db.doc(`classes/${g.classId}/students/${g.no}`).update({ ...(g.charged === false ? {} : { credits: FieldValue.increment(g.credits ?? 0) }), status: 'idle' });
    }
    throw new HttpsError('unavailable', '지금 대기열에 넣지 못했어요. 크레딧은 돌려받았어요. 잠시 뒤 다시 해 주세요.');
  }
}

// 학생·교사: 오래 "차례를 기다리는 중"인 요청을 다시 대기열에 넣는다(대기열에서 빠져 버린 경우 대비)
export const kickGeneration = onCall(async (req) => {
  const genId = String(req.data?.genId ?? '');
  const ref = db.doc(`generations/${genId}`);
  const g = (await ref.get()).data();
  if (!g) throw new HttpsError('not-found', '요청을 찾을 수 없어요.');
  const tok = req.auth?.token as any;
  const isOwner = tok?.classId === g.classId && Number(tok?.no) === g.no;
  if (!isOwner) await ownedClass(await requireTeacher(req), g.classId);
  if (g.status !== 'queued') return { ok: true, status: g.status };
  const since = Math.max(g.createdAt?.toMillis?.() ?? 0, g.kickedAt ?? 0, g.approvedAt ?? 0);
  if (Date.now() - since < 2 * 60_000) return { ok: true, wait: true };
  await ref.update({ kickedAt: Date.now() });
  await enqueue(genId);
  logger.info('kickGeneration', { genId });
  return { ok: true, kicked: true };
});

// ───────── 교사: 반 만들기 ─────────
export const createClass = onCall(async (req) => {
  const uid = await requireTeacher(req);
  const { band, size = 30, budgetUsd, creditsPerStudent, school, grade, klass } = req.data ?? {};
  // 반 이름이 없으면 학년·반으로 만든다 (예: 중2 3반)
  const title = String(req.data?.title ?? '').trim() || [grade, klass].map((x) => String(x ?? '').trim()).filter(Boolean).join(' ');
  if (!title || !['elementary', 'middle'].includes(band)) throw new HttpsError('invalid-argument', '반 이름과 학교급을 정해 주세요.');
  const n = Math.max(1, Math.min(40, Number(size)));
  let code = '';
  for (let i = 0; i < 30 && !code; i++) {
    // 초등: E + 숫자 5자리(입력하기 쉽게). 중등: 영어·숫자 6자리
    const c = band === 'elementary'
      ? 'E' + String(randomInt(100000)).padStart(5, '0')
      : Array.from({ length: 6 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');
    if (!(await db.doc(`codes/${c}`).get()).exists) code = c;
  }
  if (!code) throw new HttpsError('resource-exhausted', '반 코드를 만들지 못했어요. 다시 해 보세요.');
  const classRef = db.collection('classes').doc();
  // 3초 영상 1개 = 9크레딧. 초등은 장면 5개 안팎(8번), 중·고등은 장면 8개 안팎(10번) 만들 수 있게
  const credits = Number(creditsPerStudent) || (band === 'elementary' ? 60 : 100); // 1크레딧 = 1초
  const batch = db.batch();
  batch.set(classRef, {
    teacherUid: uid, title: String(title).slice(0, 40), school: String(school ?? '').trim().slice(0, 40), grade: String(grade ?? '').slice(0, 10), klass: String(klass ?? '').slice(0, 10), band, code, size: n,
    open: 1, paused: false, approval: true, videoInMiddle: true, creditsPerStudent: credits,
    budgetUsd: Number(budgetUsd) || (band === 'elementary' ? 150 : 250),
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

  const img = false; // 초등·중고등 모두 영상으로 만든다 (예전 '이미지만' 설정은 쓰지 않음)
  // 영상 길이: 초안은 학생이 고른 길이, 수정본은 원본과 같은 길이
  let wantSec = pickSec(req.data?.sec);
  if (kind === 'edit' && parentId) {
    const ps = (await db.doc(`generations/${parentId}`).get()).data()?.sec;
    wantSec = pickSec(ps);
  }
  const spec = specFor(kind, img, wantSec);

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
    const edits = (await db.collection('generations').where('classId', '==', classId).where('no', '==', no).where('sceneId', '==', sceneId).where('kind', '==', 'edit').get()).docs.filter((d) => !['blocked', 'rejected', 'failed', 'retired'].includes(d.data().status)).length;
    if (edits >= MAX_EDITS) throw new HttpsError('failed-precondition', `이 장면은 ${MAX_EDITS}번까지만 고칠 수 있어요.`);
  }

  const promptKo = kind === 'edit' ? `${parent!.promptKo} → 수정: ${editText}` : kind === 'final' ? parent!.promptKo : buildPromptKo(builder);
  const checkText = kind === 'edit' ? editText : promptKo;
  if (!checkText) throw new HttpsError('invalid-argument', '빈칸을 채워 주세요.');
  const kindLabel = (img ? '이미지 ' : '영상 ') + (kind === 'draft' ? '초안' : kind === 'edit' ? '대화형 수정' : '장면 확정');
  const genRef = db.collection('generations').doc();
  // 선생님 승인 목록에서 몇 번 장면인지 알 수 있게 장면 번호·내용을 함께 저장한다
  const projData = (await db.doc(`projects/${classId}_${no}`).get()).data() ?? {};
  const projScenes: any[] = projData.scenes ?? [];
  // 가로(16:9) 또는 세로(9:16). 수정본은 원본과 같은 방향
  const aspect: '16:9' | '9:16' = (kind !== 'draft' && parent?.aspect ? parent.aspect : projData.aspect) === '9:16' ? '9:16' : '16:9';
  const sceneIdx = projScenes.findIndex((x) => x.id === sceneId);
  const sceneNo = sceneIdx >= 0 ? sceneIdx + 1 : null;
  const sceneLine = sceneIdx >= 0 ? String(projScenes[sceneIdx].line ?? '').slice(0, 80) : '';
  const base = { classId, no, sceneId, sceneNo, sceneLine, kind, img, aspect, promptKo, editText: kind === 'edit' ? editText : null, res: spec.res, sec: spec.sec, hue: hueOf(genRef.id), parentId: parentId ?? null, createdAt: FieldValue.serverTimestamp() };

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

  // 안전 검사: 걸려도 막지 않고 '선생님 확인(flagged)'으로 보낸다. 선생님이 괜찮다고 하면 만든다.
  type Flag = { category: string; reason: string; suggestion: string; layer: string };
  let flag: Flag | null = null;
  {
    const r = moderateRules(checkText);
    if (!r.pass) flag = { category: r.category!, reason: r.reason!, suggestion: r.suggestion!, layer: 'rule' };
  }
  // 2단계: Gemini 맥락 검사 + 번역 (가짜 모드에서는 TEXT_CHECK=on 일 때만)
  let promptEn = parent?.promptEn ?? '';
  let editEn: string | undefined;
  const useAi = CONFIG.videoProvider() === 'omni' || process.env.TEXT_CHECK === 'on';
  let refPath: string | null = null; // 주인공 카드: 장면 첫 그림을 이 카드에 맞춰 그린다
  {
    if (useAi) {
      const c = await checkAndTranslate(checkText, kind === 'edit' ? 'edit' : 'prompt');
      if (!c.safe && !flag) flag = { category: c.category ?? '기타', reason: c.reasonKo ?? '확인이 필요한 표현이 있어요.', suggestion: c.suggestionKo ?? '다른 말로 바꿔 써 보세요.', layer: 'ai' };
      const english = c.english || checkText;
      if (kind === 'edit') { editEn = `${NO_TEXT_HEAD}${english} ${KO_TAIL} ${speechFit(spec.sec)}`; promptEn = `${parent!.promptEn} Change: ${english}`; } else {
        // 모든 장면에 같은 주인공·그림 스타일을 붙여 장면끼리 이어지게 한다
        const cast = await castPrefix(classId, no);
        if (cast.blocked && !flag) flag = { ...cast.blocked, layer: 'ai' };
        const world = await worldOf(classId, no).catch(() => undefined);
        const cont = world?.en ? `Story continuity (keep the same in every scene unless this scene's text clearly says otherwise): ${world.en} Keep a similar camera height and framing to the other scenes so the scenes connect smoothly. ` : '';
        promptEn = `${NO_TEXT_HEAD}${cast.text}${cont}Scene: ${english} ${cast.style} ${KO_TAIL} ${speechFit(spec.sec)} ${NO_TEXT_HEAD}`;
        refPath = cast.cardPath ?? null;
      }
    } else {
      if (kind === 'edit') { editEn = `(mock) ${editText}`; promptEn = `${parent!.promptEn} Change: ${editEn}`; } else promptEn = `(mock translation) ${promptKo}`;
    }
  }

  // 승인 모드: 선생님이 승인할 때 크레딧이 줄어든다(반려하면 줄지 않음). 승인 없이 바로 만들 때는 지금 줄어든다.
  // 수업이 끝난 반(자동 모드): 확인해 줄 선생님이 없으니 안전 검사에 걸리면 바로 막고 고쳐 쓰게 한다
  if (flag && cls.ended) {
    await genRef.set({ ...base, status: 'blocked', rejectReason: `${flag.reason}|${flag.suggestion}`, promptEn: null, flag });
    await log({ classId, no, kind: kindLabel, textKo: checkText, verdict: 'blocked', category: flag.category, action: '차단(수업 끝난 반 · 자동)', layer: flag.layer });
    return { genId: genRef.id, blocked: true, category: flag.category, reason: flag.reason, suggestion: flag.suggestion };
  }
  const needApproval = !!cls.approval || !!flag;
  const status = flag ? 'flagged' : needApproval ? 'awaiting_approval' : 'queued';
  const studentRef = db.doc(`classes/${classId}/students/${no}`);
  const sceneGens = db.collection('generations').where('classId', '==', classId).where('no', '==', no).where('sceneId', '==', sceneId);
  await db.runTransaction(async (tx) => {
    const [st, prev] = await Promise.all([tx.get(studentRef), tx.get(sceneGens)]);
    const live = prev.docs.map((d) => d.data()).filter((x) => ['flagged', 'awaiting_approval', 'queued', 'running', 'succeeded'].includes(x.status));
    if (live.some((x) => ['flagged', 'awaiting_approval', 'queued', 'running'].includes(x.status))) throw new HttpsError('already-exists', '이 장면은 이미 만드는 중이에요. 결과가 나올 때까지 기다려 주세요.');
    if (kind === 'draft' && live.some((x) => x.kind === 'draft')) throw new HttpsError('already-exists', '초안은 장면마다 한 번만 만들 수 있어요. 결과를 판단한 뒤 "고쳐서 다시 만들기"를 써 주세요.');
    const credits = st.data()?.credits ?? 0;
    if (credits < spec.credits) throw new HttpsError('resource-exhausted', '크레딧이 부족해요. 선생님께 말씀드려요.');
    tx.update(studentRef, { ...(needApproval ? {} : { credits: credits - spec.credits }), status: needApproval ? 'waiting' : 'making' });
    tx.set(genRef, { ...base, status, promptEn, editEn: editEn ?? null, credits: spec.credits, charged: !needApproval, costUsd: spec.costUsd, flag: flag ?? null, previousInteractionId: kind === 'edit' ? parent!.interactionId ?? null : null, refPath });
  });
  if (flag) {
    await log({ classId, no, kind: kindLabel, textKo: checkText, textEn: editEn ?? promptEn, verdict: 'blocked', category: flag.category, action: '선생님 확인 대기', layer: flag.layer });
    return { genId: genRef.id, blocked: false, flagged: true, category: flag.category, reason: flag.reason, suggestion: flag.suggestion };
  }
  await log({ classId, no, kind: kindLabel, textKo: checkText, textEn: editEn ?? promptEn, verdict: 'pass', action: needApproval ? '승인 대기' : '대기열', layer: useAi ? 'ai' : 'rule' });
  if (!needApproval) await enqueue(genRef.id);
  return { genId: genRef.id, blocked: false };
});

// ───────── 학생: 내가 올린 영상을 고른 그림체로 바꾸기 ─────────
export const restyleUpload = onCall({ timeoutSeconds: 60 }, async (req) => {
  const { classId, no } = requireStudent(req);
  const uploadId = String(req.data?.uploadId ?? '').slice(0, 60);
  const cls = (await db.doc(`classes/${classId}`).get()).data();
  if (!cls) throw new HttpsError('not-found', '반을 찾을 수 없어요.');
  if (cls.paused) throw new HttpsError('failed-precondition', '선생님이 화면을 잠시 멈췄어요.');
  const usage = (await db.doc(`usage/${classId}_${today()}`).get()).data();
  if ((usage?.costUsd ?? 0) >= cls.budgetUsd) throw new HttpsError('resource-exhausted', '오늘 우리 반 예산을 다 썼어요. 선생님께 말씀드려요.');
  const p = (await db.doc(`projects/${classId}_${no}`).get()).data() ?? {};
  const u = ((p.uploads ?? []) as any[]).find((x) => x.id === uploadId);
  if (!u) throw new HttpsError('not-found', '올린 영상을 찾을 수 없어요.');
  if (!u.path) throw new HttpsError('failed-precondition', '영상이 아직 올라가는 중이에요. 잠시 뒤 다시 눌러 주세요.');
  const dur = Math.max(1, Math.min(10, Number(u.srcDur) || 10));
  const sec = [3, 4, 5, 6, 8, 10].find((x) => x >= Math.ceil(dur - 0.05)) ?? 10;
  const spec = specFor('draft', false, sec);
  const card = (await db.doc(`castCache/${classId}_${no}`).get()).data() ?? {};
  const style = styleOf(card.cardPath ? card.cardStyle : p.cast?.style);
  const lookEn = card.cardPath && card.lookEn ? ` If the main character appears, draw them like this character: ${card.lookEn}` : '';
  const promptEn = `Restyle this entire video into the art style below. Keep exactly the same scene content, positions, motion, timing, camera movement and length — only change how it looks. ${STYLE_EN[style]} Draw any person as a friendly fictional character in this style, not as a realistic face.${lookEn} Keep the original sound and speech. Do not add subtitles, captions or any text. ${SAFE_TAIL}`;
  const sceneId = `up:${uploadId}`;
  const genRef = db.collection('generations').doc();
  const needApproval = !!cls.approval;
  const status = needApproval ? 'awaiting_approval' : 'queued';
  const studentRef = db.doc(`classes/${classId}/students/${no}`);
  const same = db.collection('generations').where('classId', '==', classId).where('no', '==', no).where('sceneId', '==', sceneId);
  await db.runTransaction(async (tx) => {
    const [st, prev] = await Promise.all([tx.get(studentRef), tx.get(same)]);
    if (prev.docs.some((d) => ['awaiting_approval', 'queued', 'running'].includes(d.data().status))) throw new HttpsError('already-exists', '이 영상은 이미 바꾸는 중이에요. 조금만 기다려 주세요.');
    const credits = st.data()?.credits ?? 0;
    if (credits < spec.credits) throw new HttpsError('resource-exhausted', '크레딧이 부족해요. 선생님께 말씀드려요.');
    tx.update(studentRef, { ...(needApproval ? {} : { credits: credits - spec.credits }), status: needApproval ? 'waiting' : 'making' });
    tx.set(genRef, {
      classId, no, sceneId, uploadId, kind: 'restyle', img: false, aspect: p.aspect === '9:16' ? '9:16' : '16:9', promptKo: `내 영상(${String(u.name ?? '').slice(0, 40)})을 ${style} 그림체로 바꾸기`, sceneLine: `내 영상 → ${style} 그림체`, sceneNo: null,
      promptEn, editText: null, res: spec.res, sec, hue: hueOf(genRef.id), parentId: null, srcPath: u.path, status, credits: spec.credits, charged: !needApproval, costUsd: spec.costUsd, createdAt: FieldValue.serverTimestamp(),
    });
  });
  await log({ classId, no, kind: '내 영상 그림체 바꾸기', textKo: `${u.name ?? ''} → ${style}`, textEn: promptEn, verdict: 'pass', action: needApproval ? '승인 대기' : '대기열' });
  if (!needApproval) await enqueue(genRef.id);
  return { genId: genRef.id, credits: spec.credits };
});

// ───────── 장면끼리 이어지게: 주인공 카드 + 고정 그림체 ─────────
// 그림체는 한 단어가 아니라 선·색·빛·질감까지 정한 긴 문장으로 모든 장면에 똑같이 붙인다.
export const STYLE_EN: Record<string, string> = {
  그림책: 'Art style (identical in every scene): warm children\'s picture-book illustration, soft rounded shapes, clean thin outlines, flat pastel colors with gentle gradients, soft warm daylight, light paper texture, no photorealism.',
  만화: 'Art style (identical in every scene): bright 2D cartoon animation, bold clean outlines, flat saturated colors, simple cel shading, expressive faces, no photorealism.',
  '3D 애니메이션': 'Art style (identical in every scene): soft friendly 3D animated film look, rounded stylized characters, smooth matte materials, soft global illumination, warm color palette, no photorealism.',
  클레이: 'Art style (identical in every scene): handmade claymation stop-motion, plasticine textures with fingerprints, miniature set, soft studio lighting, warm colors.',
  수채화: 'Art style (identical in every scene): soft watercolor illustration, visible paper grain, gentle color bleeding, light pencil outlines, airy pastel palette, no photorealism.',
};
const styleOf = (v: unknown) => (String(v ?? '') in STYLE_EN ? String(v) : '그림책');
const SAFE_TAIL = 'Safe for children, fictional people only.';
// 영상 속 말이 영상 끝에서 잘리지 않게: 짧게, 조금 빠른 보통 속도로, 끝나기 전에 다 말하기
const speechFit = (sec: number) => `TIMING: This clip is only ${sec} seconds long. Any spoken line must be short and must be completely finished at least half a second before the clip ends — speak at a natural, slightly brisk pace with no long pauses, and start speaking early in the clip.`;
// 자막·글자 절대 넣지 않기(잘못된 자막이 생겨도 학생이 고칠 수 없어서). 프롬프트 앞뒤에 같이 붙인다
const NO_TEXT_HEAD = 'IMPORTANT — NO ON-SCREEN TEXT: this video must contain no subtitles, no captions, no written dialogue, no titles, no speech bubbles and no text overlays of any kind. ';
// 영상 속 말·글자는 모두 한국어로
export const KO_TAIL = 'LANGUAGE: Everyone who speaks in this video speaks KOREAN (한국어) only — all dialogue, narration and voices are in natural spoken Korean, never English. Keep any Korean lines given in quotes exactly as written. NO SUBTITLES: do not add subtitles, captions, speech text, titles or any text overlay on the screen; the speech is heard only as audio. Avoid visible writing in the scene; if a sign or screen must show writing, keep it small and in Korean Hangul.';

// 주인공 설명을 검사·번역한다(같은 설명이면 저장해 둔 번역을 다시 쓴다)
async function lookEnOf(classId: string, no: number, look: string): Promise<{ en?: string; blocked?: { category: string; reason: string; suggestion: string } }> {
  const cacheRef = db.doc(`castCache/${classId}_${no}`);
  const cached = (await cacheRef.get()).data();
  if (cached?.look === look && cached?.lookEn) return { en: cached.lookEn };
  const r = moderateRules(look);
  if (!r.pass) return { blocked: { category: r.category!, reason: `주인공 설정: ${r.reason}`, suggestion: r.suggestion! } };
  const useAi = CONFIG.videoProvider() === 'omni' || process.env.TEXT_CHECK === 'on';
  if (!useAi) return { en: `(mock) ${look}` };
  const c = await checkAndTranslate(`주인공 모습: ${look}`, 'prompt');
  if (!c.safe) return { blocked: { category: c.category ?? '기타', reason: `주인공 설정: ${c.reasonKo ?? ''}`, suggestion: c.suggestionKo ?? '' } };
  await cacheRef.set({ look, lookEn: c.english, at: FieldValue.serverTimestamp() }, { merge: true });
  return { en: c.english };
}

// 모든 장면 프롬프트에 붙일 주인공·그림체 문장과, 주인공 카드(기준 그림) 위치
async function castPrefix(classId: string, no: number): Promise<{ text: string; style: string; cardPath?: string; blocked?: { category: string; reason: string; suggestion: string } }> {
  const p = (await db.doc(`projects/${classId}_${no}`).get()).data() ?? {};
  const card = (await db.doc(`castCache/${classId}_${no}`).get()).data() ?? {};
  // 주인공 카드를 만들었으면 그 카드의 그림체로 고정한다
  const styleKey = card.cardPath ? styleOf(card.cardStyle) : styleOf(p.cast?.style);
  const style = `${STYLE_EN[styleKey]} ${SAFE_TAIL}`;
  const look = String(card.cardPath ? card.cardLook ?? '' : p.cast?.look ?? '').trim().slice(0, 120);
  if (!look) return { text: '', style };
  const l = await lookEnOf(classId, no, look);
  if (l.blocked) return { text: '', style, blocked: l.blocked };
  const text = `Keep the SAME main character (same face, hair, body and clothes) in every scene of this story. Main character: ${l.en} "I", "me" or "나" in the scene means this main character. `;
  return { text, style, cardPath: card.cardPath ?? undefined };
}

// 이야기 공통 설정(장소·날씨·때·빛·구도). 이야기 내용이 바뀔 때만 새로 만들고 저장해 둔다.
async function worldOf(classId: string, no: number, force = false): Promise<World | undefined> {
  const p = (await db.doc(`projects/${classId}_${no}`).get()).data() ?? {};
  const st = p.story ?? {};
  const scenes: any[] = (p.scenes ?? []).filter((x: any) => !x.skip);
  const lines = [
    `주제: ${p.topic ?? ''}`,
    `누가: ${st.who ?? ''} / 언제: ${st.when ?? ''} / 어디서: ${st.where ?? ''} / 무엇을: ${st.what ?? ''} / 어떻게: ${st.event ?? ''} / 왜: ${st.why ?? ''} / 기분: ${st.feeling ?? ''}`,
    `주인공: ${p.cast?.look ?? ''}`,
    `시나리오: ${p.scenario?.final || (p.scenario?.draft ?? []).join(' ')}`,
    ...scenes.map((x, i) => `장면 ${i + 1}: ${x.line ?? ''} (언제: ${x.builder?.when ?? ''}, 어디서: ${x.builder?.where ?? ''})`),
  ].join('\n');
  if (!lines.replace(/[^가-힣a-zA-Z0-9]/g, '').length) return undefined;
  const key = createHash('sha1').update(lines).digest('hex');
  const ref = db.doc(`castCache/${classId}_${no}`);
  const cur = (await ref.get()).data() ?? {};
  if (!force && cur.worldKey === key && cur.world?.en) return cur.world as World;
  const useAi = CONFIG.videoProvider() === 'omni' || process.env.TEXT_CHECK === 'on';
  if (!useAi) return { place: st.where || '이야기 속 장소', weather: '맑음', time: st.when || '낮', light: '밝고 따뜻한 빛', camera: '눈높이의 비슷한 구도', en: '(mock) keep the same place, weather, time of day and camera framing.' };
  if (!moderateRules(lines).pass) return cur.world as World | undefined;
  const w = await makeWorld(lines).catch((e) => (logger.warn('공통 설정 실패', { err: String(e?.message ?? e) }), undefined));
  if (w) await ref.set({ world: w, worldKey: key, worldAt: FieldValue.serverTimestamp() }, { merge: true });
  return w ?? (cur.world as World | undefined);
}

// 학생: 모든 장면에 자동으로 들어가는 공통 설정 보기(다시 정하기)
export const storyWorld = onCall({ timeoutSeconds: 60 }, async (req) => {
  const { classId, no } = requireStudent(req);
  const w = await worldOf(classId, no, req.data?.refresh === true);
  return w ? { place: w.place, weather: w.weather, time: w.time, light: w.light, camera: w.camera } : { empty: true };
});

// 학생: 주인공 카드 만들기 (주인공 기준 그림 1장, 3번까지)
export const makeCharacter = onCall({ timeoutSeconds: 120 }, async (req) => {
  const { classId, no } = requireStudent(req);
  const look = String(req.data?.look ?? '').trim().slice(0, 120);
  const style = styleOf(req.data?.style);
  if (!look) throw new HttpsError('invalid-argument', '주인공 모습을 먼저 써 주세요.');
  const cls = (await db.doc(`classes/${classId}`).get()).data();
  if (cls?.paused) throw new HttpsError('failed-precondition', '선생님이 화면을 잠시 멈췄어요.');
  const ref = db.doc(`castCache/${classId}_${no}`);
  const cur = (await ref.get()).data() ?? {};
  if ((cur.cardTries ?? 0) >= 3) throw new HttpsError('resource-exhausted', '주인공 카드는 3번까지 만들 수 있어요. 지금 카드로 장면을 만들어 봐요.');
  const l = await lookEnOf(classId, no, look);
  if (l.blocked) {
    await log({ classId, no, kind: '주인공 카드', textKo: look, verdict: 'blocked', category: l.blocked.category, action: '차단', layer: 'ai' });
    return { blocked: true, reason: l.blocked.reason, suggestion: l.blocked.suggestion };
  }
  // 반 전체가 한꺼번에 눌러도 되도록 대기열에 넣고 바로 돌아간다. 다 그리면 학생 화면에 저절로 나타난다.
  const projRef = db.doc(`projects/${classId}_${no}`);
  if (cur.cardStatus === 'making' && Date.now() - (cur.cardReqAt ?? 0) < 10 * 60_000) return { blocked: false, queued: true };
  await ref.set({ cardStatus: 'making', cardReqLook: look, cardReqStyle: style, cardReqEn: l.en, cardReqAt: Date.now() }, { merge: true });
  await projRef.set({ card: { status: 'making', at: Date.now(), url: cur.cardUrl ?? null, look: cur.cardLook ?? null, style: cur.cardStyle ?? null, tries: cur.cardTries ?? 0 } }, { merge: true });
  await getFunctions().taskQueue(`locations/${REGION}/functions/runCard`).enqueue({ classId, no }, { dispatchDeadlineSeconds: 600 });
  return { blocked: false, queued: true };
});

// 대기열 작업자: 주인공 카드 그리기 (한 번에 몇 장씩만 그려서 AI가 바쁘다고 거절하지 않게)
export const runCard = onTaskDispatched(
  {
    retryConfig: { maxAttempts: 6, minBackoffSeconds: 15, maxBackoffSeconds: 120 },
    rateLimits: { maxConcurrentDispatches: 6 },
    timeoutSeconds: 300,
    memory: '512MiB',
  },
  async (req) => {
    const { classId, no } = (req.data ?? {}) as { classId: string; no: number };
    if (!classId || !Number.isInteger(no)) return;
    const ref = db.doc(`castCache/${classId}_${no}`);
    const projRef = db.doc(`projects/${classId}_${no}`);
    const cur = (await ref.get()).data() ?? {};
    if (cur.cardStatus !== 'making') return;
    const look = String(cur.cardReqLook ?? '');
    const style = styleOf(cur.cardReqStyle);
    const tries = (cur.cardTries ?? 0) + 1;
    try {
      let url = '';
      let path: string | null = null;
      if (CONFIG.videoProvider() === 'omni') {
        const img = await drawImage(
          [{ text: `Character reference sheet of ONE fictional main character: ${cur.cardReqEn} Full body, front view, friendly neutral pose, centered, plain light background, no text, no other people. ${STYLE_EN[style]} ${SAFE_TAIL}` }],
          '1:1',
        );
        const token = randomUUID();
        path = `classes/${classId}/${no}/cast/${Date.now()}.png`;
        await getStorage().bucket().file(path).save(img.bytes, { contentType: img.mimeType, metadata: { metadata: { firebaseStorageDownloadTokens: token, aiGenerated: 'true' } } });
        url = mediaUrl(path, token);
      }
      await ref.set({ cardStatus: 'done', cardPath: path, cardUrl: url, cardLook: look, cardStyle: style, cardTries: tries, cardAt: FieldValue.serverTimestamp() }, { merge: true });
      await projRef.set({ card: { status: 'done', url, look, style, tries, at: Date.now() } }, { merge: true });
      await log({ classId, no, kind: '주인공 카드', textKo: `${look} (${style})`, textEn: cur.cardReqEn, verdict: 'pass', action: `카드 만들기 ${tries}/3` });
    } catch (e: any) {
      const safety = e instanceof SafetyBlockedError;
      const last = safety || (req.retryCount ?? 0) >= 5;
      logger.warn('주인공 카드 실패', { classId, no, retry: req.retryCount, err: String(e?.message ?? e).slice(0, 300) });
      if (!last) {
        await projRef.set({ card: { status: 'making', retry: (req.retryCount ?? 0) + 1 } }, { merge: true });
        throw e; // 대기열이 잠시 뒤 다시 그린다
      }
      await ref.set({ cardStatus: 'failed' }, { merge: true });
      await projRef.set({ card: { status: 'failed', error: safety ? 'AI가 이 주인공은 그릴 수 없대요. 설명을 바꿔 보세요.' : '지금은 주인공 카드를 그리지 못했어요. 잠시 뒤 다시 눌러 주세요. (횟수는 줄지 않았어요)', at: Date.now() } }, { merge: true });
    }
  },
);

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
  if (!['awaiting_approval', 'flagged'].includes(g.status)) return { ok: true };
  const wasFlagged = g.status === 'flagged';
  const studentRef = db.doc(`classes/${g.classId}/students/${g.no}`);
  if (approve) {
    await db.runTransaction(async (tx) => {
      const [cur, st] = await Promise.all([tx.get(ref), tx.get(studentRef)]);
      if (!['awaiting_approval', 'flagged'].includes(cur.data()?.status)) throw new HttpsError('failed-precondition', '이미 처리된 요청이에요.');
      const need = cur.data()?.charged === false ? Number(cur.data()?.credits ?? 0) : 0;
      const credits = st.data()?.credits ?? 0;
      if (credits < need) throw new HttpsError('resource-exhausted', `${g.no}번 학생의 크레딧이 부족해요. 크레딧을 늘려 주거나 돌려보내 주세요.`);
      tx.update(studentRef, { ...(need ? { credits: credits - need } : {}), status: 'making' });
      tx.update(ref, { status: 'queued', reviewedBy: uid, charged: true, approvedAt: Date.now() });
    });
    await log({ classId: g.classId, no: g.no, kind: wasFlagged ? '안전 검사 확인' : '교사 승인', textKo: g.editText ?? g.promptKo, textEn: g.promptEn, verdict: 'pass', action: wasFlagged ? `선생님이 괜찮다고 함 (${g.flag?.category ?? ''})` : '승인' });
    await enqueue(genId);
  } else {
    await ref.update({ status: 'rejected', rejectReason: reason || '선생님이 다시 생각해 보라고 했어요', reviewedBy: uid });
    await studentRef.update({ ...(g.charged === false ? {} : { credits: FieldValue.increment(g.credits ?? 0) }), status: 'idle' });
    await log({ classId: g.classId, no: g.no, kind: wasFlagged ? '안전 검사 확인' : '교사 반려', textKo: g.editText ?? g.promptKo, verdict: 'pass', action: `반려: ${reason}` });
  }
  return { ok: true };
});

// ───────── 교사: 수업 끝내기(자동 모드) / 다시 수업 모드 ─────────
// 끝내면: 교사 승인 없이 바로 만들고(안전 검사는 그대로, 걸리면 자동 차단), 모든 단계를 열고, 멈춤을 푼다.
// 기다리던 승인 요청은 크레딧이 있으면 바로 승인해 만든다.
export const setClassEnded = onCall({ timeoutSeconds: 120 }, async (req) => {
  const uid = await requireTeacher(req);
  const classId = String(req.data?.classId ?? '');
  const ended = req.data?.ended === true;
  await ownedClass(uid, classId);
  const clsRef = db.doc(`classes/${classId}`);
  const cls = (await clsRef.get()).data() ?? {};
  await clsRef.update(ended ? { ended: true, endedAt: Date.now(), approval: false, open: 6, paused: false } : { ended: false, approval: true });
  let approved = 0;
  let bonus = 0;
  // 수업이 끝나면 크레딧을 처음 받은 양의 2배로 채워 준다(반마다 한 번만). 이미 그보다 많으면 그대로
  if (ended && !cls.endBonusGiven) {
    const base = Number(cls.creditsPerStudent) || (cls.band === 'elementary' ? 60 : 100);
    bonus = base * 2;
    const studs = await clsRef.collection('students').get();
    const batch = db.batch();
    studs.docs.forEach((d) => {
      const cur = Number(d.data().credits ?? 0);
      if (cur < bonus) batch.update(d.ref, { credits: bonus });
    });
    batch.update(clsRef, { endBonusGiven: true });
    await batch.commit();
  }
  if (ended) {
    const waiting = await db.collection('generations').where('classId', '==', classId).where('status', '==', 'awaiting_approval').get();
    for (const d of waiting.docs) {
      const g = d.data();
      const studentRef = db.doc(`classes/${classId}/students/${g.no}`);
      const ok = await db
        .runTransaction(async (tx) => {
          const [cur, st] = await Promise.all([tx.get(d.ref), tx.get(studentRef)]);
          if (cur.data()?.status !== 'awaiting_approval') return false;
          const need = cur.data()?.charged === false ? Number(cur.data()?.credits ?? 0) : 0;
          const credits = st.data()?.credits ?? 0;
          if (credits < need) return false;
          tx.update(studentRef, { ...(need ? { credits: credits - need } : {}), status: 'making' });
          tx.update(d.ref, { status: 'queued', reviewedBy: uid, charged: true, approvedAt: Date.now(), autoApproved: true });
          return true;
        })
        .catch(() => false);
      if (ok) {
        approved++;
        await enqueue(d.id).catch(() => {});
      }
    }
  }
  await log({ classId, no: 0, kind: ended ? '수업 끝내기' : '다시 수업 모드', textKo: ended ? '교사 승인 없이 자동 생성으로 바꿈' : '교사 승인 모드로 돌아옴', verdict: 'pass', action: ended ? `기다리던 요청 ${approved}개 자동 승인${bonus ? ` · 학생 크레딧 ${bonus}로 채움` : ''}` : '' });
  return { ok: true, approved, bonus };
});

// ───────── 교사: 학생이 확정한 장면 되돌리기 ─────────
// unfinal: 확정만 풀어서 학생이 이미 만든 결과 중에서 다시 고르거나 고치게 한다
// redo: 그 장면의 결과를 모두 치워서 초안부터 다시 만들게 한다(새로 만들 때 크레딧이 다시 든다)
export const teacherResetScene = onCall(async (req) => {
  const uid = await requireTeacher(req);
  const classId = String(req.data?.classId ?? '');
  const no = Number(req.data?.no);
  const sceneId = String(req.data?.sceneId ?? '').slice(0, 60);
  const mode = req.data?.mode === 'redo' ? 'redo' : 'unfinal';
  await ownedClass(uid, classId);
  if (!sceneId || !Number.isInteger(no)) throw new HttpsError('invalid-argument', '요청이 올바르지 않아요.');
  const snap = await db.collection('generations').where('classId', '==', classId).where('no', '==', no).where('sceneId', '==', sceneId).get();
  const docs = snap.docs.map((d) => ({ ref: d.ref, ...(d.data() as any) }));
  if (docs.some((g) => ['flagged', 'awaiting_approval', 'queued', 'running'].includes(g.status))) throw new HttpsError('failed-precondition', '이 장면은 지금 만드는 중이에요. 끝난 뒤에 다시 해 주세요.');
  const targets = mode === 'redo' ? docs.filter((g) => g.status !== 'retired') : docs.filter((g) => g.kind === 'final' && g.status !== 'retired');
  const batch = db.batch();
  targets.forEach((g) => batch.update(g.ref, { status: 'retired', retiredBy: uid, retiredAt: FieldValue.serverTimestamp(), retiredMode: mode }));
  // 확정 풀기: 확정했던 영상(원본)은 그대로 남기고 "전에 정했던 영상"으로 표시해서 다시 고를 수 있게 한다
  if (mode === 'unfinal') {
    for (const g of targets) {
      const parent = g.parentId ? docs.find((x) => x.ref.id === g.parentId) : undefined;
      if (parent && parent.status === 'succeeded') batch.update(parent.ref, { wasFinal: true });
    }
  }
  const projRef = db.doc(`projects/${classId}_${no}`);
  const p = (await projRef.get()).data();
  if (p?.scenes) {
    const ids = new Set(targets.map((g) => g.ref.id));
    const scenes = (p.scenes as any[]).map((sc) => {
      if (sc.id !== sceneId) return sc;
      const { selectedGenId, ...rest } = sc;
      return selectedGenId && (ids.has(selectedGenId) || mode === 'redo') ? rest : sc;
    });
    batch.update(projRef, { scenes });
  }
  await batch.commit();
  await log({ classId, no, kind: '교사 되돌리기', textKo: `장면 ${((p?.scenes ?? []) as any[]).findIndex((x) => x.id === sceneId) + 1}`, verdict: 'pass', action: mode === 'redo' ? '처음부터 다시 만들기 허락' : '확정 풀기' });
  return { ok: true, count: targets.length };
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

// 이야기 순서에서 바로 앞 장면(뺀 장면 제외)의 영상 마지막 화면
async function prevSceneFrame(classId: string, no: number, sceneId: string): Promise<{ png: Buffer; genId: string } | undefined> {
  const p = (await db.doc(`projects/${classId}_${no}`).get()).data() ?? {};
  const scenes: any[] = (p.scenes ?? []).filter((x: any) => !x.skip || x.id === sceneId);
  const ids = scenes.map((x) => x.id);
  const kept = ((p.order ?? []) as string[]).filter((k) => ids.includes(k));
  const ordered = [...kept, ...ids.filter((k) => !kept.includes(k))];
  const idx = ordered.indexOf(sceneId);
  if (idx <= 0) return undefined;
  const prevId = ordered[idx - 1];
  const prev = scenes.find((x) => x.id === prevId);
  const gens = (await db.collection('generations').where('classId', '==', classId).where('no', '==', no).where('sceneId', '==', prevId).get()).docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
  const done = gens.filter((x) => x.status === 'succeeded' && x.storagePath && !x.img).sort((a, b) => (a.createdAt?.toMillis?.() ?? 0) - (b.createdAt?.toMillis?.() ?? 0));
  const g = done.find((x) => x.id === prev?.selectedGenId) ?? done.pop();
  if (!g) return undefined;
  const dir = mkdtempSync(pjoin(tmpdir(), 'prev-'));
  try {
    const v = pjoin(dir, 'v.mp4');
    const f = pjoin(dir, 'last.png');
    await getStorage().bucket().file(g.storagePath).download({ destination: v });
    if (!(await lastFrame(v, f))) return undefined;
    const { readFileSync } = await import('node:fs');
    return { png: readFileSync(f), genId: g.id };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ───────── 대기열 작업자: 실제 생성 ─────────
export const runGeneration = onTaskDispatched(
  {
    // 반 전체가 한꺼번에 만들 때 AI가 바쁘다고 하면 대기열에서 여러 번 다시 시도한다(실패해도 크레딧은 돌려준다)
    retryConfig: { maxAttempts: 8, minBackoffSeconds: 15, maxBackoffSeconds: 120 },
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
      // 주인공 카드가 있으면 내려받아 함께 보낸다
      let refImage: Buffer | undefined;
      if (g.refPath && !g.editEn) refImage = await getStorage().bucket().file(g.refPath).download().then(([b]) => b).catch(() => undefined);
      // 앞 장면의 마지막 화면에서 이어 시작하게 한다(초안만)
      const prevFrame = g.kind === 'draft' && !g.editEn && CONFIG.videoProvider() === 'omni' ? await prevSceneFrame(g.classId, g.no, g.sceneId).catch(() => undefined) : undefined;
      if (prevFrame) await ref.update({ contFrom: prevFrame.genId }).catch(() => {});
      // 내 영상 그림체 바꾸기: 올린 영상을 MP4로 바꿔서 보낸다
      let srcVideo: Buffer | undefined;
      if (g.kind === 'restyle' && g.srcPath) {
        const tdir = mkdtempSync(pjoin(tmpdir(), 'restyle-'));
        try {
          const raw = pjoin(tdir, 'in');
          await getStorage().bucket().file(g.srcPath).download({ destination: raw });
          const out = await toMp4(raw, pjoin(tdir, 'in.mp4'), 10, g.aspect);
          const { readFileSync } = await import('node:fs');
          srcVideo = readFileSync(out);
        } finally {
          rmSync(tdir, { recursive: true, force: true });
        }
      }
      const result = await provider().generate({
        promptEn: g.promptEn, editEn: g.editEn ?? undefined, previousInteractionId: g.previousInteractionId ?? undefined,
        res: g.res, sec: g.sec, img: g.img, refImage, prevFrame: prevFrame?.png, srcVideo, aspect: g.aspect === '9:16' ? '9:16' : '16:9',
      });
      if (result.keyframe) {
        const kp = `classes/${g.classId}/${g.no}/gens/${genId}_key.png`;
        await getStorage().bucket().file(kp).save(result.keyframe, { contentType: 'image/png' }).catch(() => {});
      }
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
      // 실제 영상 길이를 재서 저장한다(요청한 길이와 다를 수 있어서)
      let realSec = result.sec ?? 0;
      if (result.bytes && !result.mimeType.includes('image')) {
        const tdir = mkdtempSync(pjoin(tmpdir(), 'probe-'));
        try {
          const f = pjoin(tdir, 'v.mp4');
          writeFileSync(f, result.bytes);
          const d = await probeDur(f);
          if (d > 0) realSec = Math.round(d * 10) / 10;
        } finally {
          rmSync(tdir, { recursive: true, force: true });
        }
      }
      await ref.update({ ...(realSec ? { sec: realSec } : {}), status: 'succeeded', storagePath, url, mimeType: result.mimeType, interactionId: result.interactionId ?? null, mock: !!result.mock, doneAt: FieldValue.serverTimestamp() });
      await studentRef.update({ status: 'idle' });
      // 내 영상 그림체 바꾸기: 편집에서 바뀐 영상을 쓰도록 올린 영상에 표시한다
      if (g.kind === 'restyle' && g.uploadId && storagePath) {
        const projRef = db.doc(`projects/${g.classId}_${g.no}`);
        await db.runTransaction(async (tx) => {
          const pd = (await tx.get(projRef)).data();
          if (!pd?.uploads) return;
          tx.update(projRef, { uploads: (pd.uploads as any[]).map((x) => (x.id === g.uploadId ? { ...x, styledPath: storagePath, styledUrl: url, styledGenId: genId, useStyled: true } : x)) });
        });
      }
      const cost = result.mock ? 0 : g.costUsd ?? 0;
      await db.doc(`usage/${g.classId}_${today()}`).set(
        { classId: g.classId, costUsd: FieldValue.increment(cost), videoSec: FieldValue.increment(g.img ? 0 : g.sec), count: FieldValue.increment(1), updatedAt: Timestamp.now() },
        { merge: true },
      );
    } catch (e: any) {
      logger.error('generation failed', { genId, err: String(e?.message ?? e) });
      if (e instanceof SafetyBlockedError) return fail('blocked', '모델 안전 정책에 걸림');
      // 요청 자체가 잘못된 오류(400·404·403 등)는 다시 해도 똑같으니 바로 끝내고 크레딧을 돌려준다(오래 기다리지 않게)
      const em = String(e?.message ?? e);
      const permanent = /\b(400|403|404)\b|INVALID_ARGUMENT|NOT_FOUND|PERMISSION_DENIED|FAILED_PRECONDITION|not supported|unsupported/i.test(em) && !/429|RESOURCE_EXHAUSTED/i.test(em);
      if (permanent) return fail('failed', em.slice(0, 200));
      const last = (req.retryCount ?? 0) >= 7;
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
        systemInstruction: '중·고등학생이 만드는 60초 이내 영상의 시나리오 초안을 쓴다. 장면마다 한 문장, "장면 N. ..." 형식. 폭력·혐오·개인정보·실존 인물은 쓰지 않는다. 학생이 고칠 수 있게 일부러 완벽하지 않아도 된다. JSON 문자열 배열만 출력한다.',
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

// ───────── 초등: 활동지로 장면 초안 만들기 ─────────
// 학생이 쓴 활동지(육하원칙·기분)를 바탕으로 장면 3~5개의 초안(장면 설명 + 육하원칙)을 만든다. 학생이 고쳐서 쓴다.
export const draftScenes = onCall({ timeoutSeconds: 60 }, async (req) => {
  const { classId, no } = requireStudent(req);
  const f = req.data ?? {};
  const t = (k: string) => String(f[k] ?? '').trim().slice(0, 120);
  const sheet = { topic: t('topic'), who: t('who'), when: t('when'), where: t('where'), what: t('what'), how: t('event'), why: t('why'), feeling: t('feeling') };
  const joined = Object.values(sheet).filter(Boolean).join(' / ');
  if (!joined) throw new HttpsError('invalid-argument', '활동지를 먼저 써 주세요.');
  const r = moderateRules(joined);
  if (!r.pass) {
    await log({ classId, no, kind: '장면 초안', textKo: joined, verdict: 'blocked', category: r.category, action: '차단', layer: 'rule' });
    return { blocked: true, reason: r.reason, scenes: [] };
  }
  type S = { line: string; who: string; when: string; where: string; what: string; how: string; why: string };
  let scenes: S[];
  let cast = { look: '' };
  const cut = (v: unknown, n: number) => String(v ?? '').slice(0, n);
  const useAi = CONFIG.videoProvider() === 'omni' || process.env.TEXT_CHECK === 'on';
  if (!useAi) {
    scenes = [
      { line: '(연습 모드) 하루가 시작돼요', who: sheet.who, when: sheet.when, where: sheet.where, what: '하루를 시작한다', how: '', why: '' },
      { line: '(연습 모드) AI를 써요', who: sheet.who, when: sheet.when, where: sheet.where, what: sheet.what, how: sheet.how, why: sheet.why },
      { line: '(연습 모드) 기분을 표현해요', who: sheet.who, when: '', where: sheet.where, what: `${sheet.feeling || '기분'}을 느낀다`, how: '', why: '' },
    ];
  } else {
    const { genai } = await import('./ai/client');
    const res: any = await genai().models.generateContent({
      model: CONFIG.textModel(),
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: `주제: ${sheet.topic}\n누가: ${sheet.who}\n언제: ${sheet.when}\n어디서: ${sheet.where}\n무엇을(어떤 AI와): ${sheet.what}\n어떻게: ${sheet.how}\n왜: ${sheet.why}\n기분: ${sheet.feeling}`,
            },
          ],
        },
      ],
      config: {
        systemInstruction:
          '초등학생이 쓴 활동지로 30초 영상의 장면 초안을 만든다. look 에는 모든 장면에 똑같이 나올 주인공의 모습(나이·머리·옷차림을 짧게, 실존 인물·실명 금지)을 쓴다. 장면은 3~5개, 시간 순서대로. 장면마다 line(초등학생이 읽기 쉬운 한 문장 장면 설명)과 육하원칙(who 누가, when 언제, where 어디서, what 무엇을, how 어떻게·어떤 모습으로, why 왜)을 짧은 한국어로 쓴다. 학생이 쓴 내용을 최대한 그대로 살리고, 없는 내용을 지나치게 지어내지 않는다. 마지막 장면에는 학생의 기분이 드러나게 한다. 폭력·혐오·개인정보·실존 인물·실제 상표 이름은 쓰지 않는다. 비어 있는 칸은 빈 문자열로 둔다.',
        temperature: 0.6,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            look: { type: 'STRING' },
            scenes: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: { line: { type: 'STRING' }, who: { type: 'STRING' }, when: { type: 'STRING' }, where: { type: 'STRING' }, what: { type: 'STRING' }, how: { type: 'STRING' }, why: { type: 'STRING' } },
                required: ['line', 'who', 'when', 'where', 'what', 'how', 'why'],
              },
            },
          },
          required: ['look', 'scenes'],
        },
      } as any,
    });
    try {
      const parsed = JSON.parse(res.text ?? '{}');
      cast = { look: cut(parsed.look, 80) };
      scenes = ((parsed.scenes ?? []) as any[]).slice(0, 5).map((x) => ({
        line: cut(x.line, 80), who: cut(x.who, 30), when: cut(x.when, 30), where: cut(x.where, 30), what: cut(x.what, 60), how: cut(x.how, 40), why: cut(x.why, 40),
      }));
    } catch {
      throw new HttpsError('internal', '초안을 만들지 못했어요. 다시 해 보세요.');
    }
    // 만든 초안도 한 번 더 규칙 검사
    const bad = scenes.find((x) => !moderateRules(Object.values(x).join(' ')).pass);
    if (bad) scenes = scenes.filter((x) => x !== bad);
  }
  await log({ classId, no, kind: '장면 초안', textKo: joined, textEn: scenes.map((x) => x.line).join(' | '), verdict: 'pass', action: `AI 장면 초안 ${scenes.length}개`, layer: useAi ? 'ai' : 'rule' });
  if (!moderateRules(cast.look).pass) cast = { look: '' };
  return { blocked: false, scenes, cast };
});

// ───────── 학생: 편집한 장면을 한 편의 MP4 로 합치기 ─────────

export const renderVideo = onCall({ timeoutSeconds: 540, memory: '2GiB', cpu: 2, concurrency: 1, maxInstances: 50 }, async (req) => {
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
  const kept = [...new Set<string>((p.order ?? []).filter((k: string) => all.includes(k)))];
  const keys = [...kept, ...[...new Set(all)].filter((k) => !kept.includes(k))];
  const gens = (await db.collection('generations').where('classId', '==', classId).where('no', '==', no).get()).docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
  const genOf = (sc: any) => gens.find((x) => x.id === sc.selectedGenId) ?? gens.filter((x) => x.sceneId === sc.id && x.status === 'succeeded').pop();
  const uploadDur = (u: any) => Math.max(1, Math.min(Math.floor(Number(u.srcDur) || Number(u.dur) || 5), 10)); // 내 영상은 10초까지
  const tl = (p.tl ?? {}) as { cuts?: any[]; caps?: any[]; voices?: any[] };
  const num = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : 0);

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

  try {
    // 브라우저가 그려 보낸 글자 그림(PNG)을 파일로 저장한다
    const ov = (req.data?.overlays ?? {}) as { intro?: string; outro?: string; clips?: Record<string, string>; caps?: Record<string, string[]> };
    let pngN = 0;
    const savePng = (dataUrl?: string) => {
      const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl ?? ''));
      if (!m || pngN > 400) return undefined;
      const buf = Buffer.from(m[1], 'base64');
      if (buf.length > 3 * 1024 * 1024) return undefined;
      const f = pjoin(dir, `ov_${pngN++}.png`);
      writeFileSync(f, buf);
      return f;
    };
    const fixedOf = (png?: string): Layers | undefined => {
      const f = savePng(png);
      return f ? { fixed: f } : undefined;
    };

    // ① 바탕 조각: 제목 · 장면(만든 영상 길이 그대로) · 올린 영상 · 끝 화면
    const clips: Clip[] = [{ kind: 'title', dur: Math.max(1, Math.min(num(p.intro?.dur) || 3, 5)), layers: fixedOf(ov.intro) }];
    const ckeys: string[] = ['intro'];
    let i = 0;
    for (const k of keys) {
      i++;
      const sc = scenes.find((s) => s.id === k);
      if (sc) {
        const g = genOf(sc);
        const src = g?.storagePath ? await fetchFile(g.storagePath, `gen_${i}`) : undefined;
        if (g && src) {
          const real = g.img ? 0 : await probeDur(src);
          const srcLen = real > 0 ? real : g.sec ?? 3;
          const dur = g.img ? Math.max(1, Math.min(num(sc.dur) || 3, 10)) : Math.max(1, Math.round(srcLen * 10) / 10);
          // AI가 만든 소리(한국어 말·효과음)를 그대로 쓴다. 학생이 끄면 뺀다
          clips.push({ kind: g.img ? 'image' : 'video', dur, start: 0, srcLen, src, keepAudio: !sc.mute, layers: fixedOf(ov.clips?.[sc.id]), grade: true });
        } else {
          clips.push({ kind: 'placeholder', dur: Math.max(1, Math.min(num(sc.dur) || 3, 10)), layers: fixedOf(ov.clips?.[sc.id]) });
        }
        ckeys.push(sc.id);
        continue;
      }
      const u = uploads.find((x) => x.id === k);
      const usrc = u?.path ? await fetchFile(u.path, `up_${i}`) : undefined;
      const styled = u?.useStyled && u?.styledPath ? await fetchFile(u.styledPath, `upst_${i}`) : undefined;
      if (u && usrc) {
        clips.push({ kind: 'video', dur: uploadDur(u), start: 0, src: styled ?? usrc, audioSrc: styled ? usrc : undefined, keepAudio: u.voice === '원래 소리', grade: !!styled, layers: fixedOf(ov.clips?.[u.id]) });
        ckeys.push(u.id);
      }
    }
    clips.push({ kind: 'outro', dur: Math.max(1, Math.min(num(p.outro?.dur) || 3, 5)), layers: fixedOf(ov.outro) });
    ckeys.push('outro');
    // 조각마다 바탕 영상에서 시작하는 시각. 자막·목소리·지운 구간은 "조각 + 그 안의 초"로 저장돼 있다
    const atOf: Record<string, { at: number; dur: number }> = {};
    {
      let acc = 0;
      clips.forEach((c, k) => {
        // 장면을 끝까지 다 보여 준다(겹쳐서 잘라 먹지 않음). 다음 장면은 앞 장면 끝 화면 위로 서서히 나타난다
        const at = acc;
        acc = at + c.dur;
        atOf[ckeys[k]] = { at, dur: c.dur };
      });
    }
    const absAt = (x: any): number | undefined => {
      const m = atOf[String(x?.k ?? '')];
      return m ? m.at + Math.max(0, Math.min(num(x.o), m.dur)) : undefined;
    };

    const base = clips.reduce((a, c) => a + c.dur, 0);
    const cuts = mergeCuts(
      (tl.cuts ?? []).slice(0, 40).flatMap((c) => {
        const a = absAt(c);
        return a === undefined ? [] : [{ a, b: a + Math.max(0, num(c.len)) }];
      }),
      base,
    );
    const finalDur = base - cuts.reduce((a, c) => a + (c.b - c.a), 0);
    // 정한 길이(초등 30초·중등 60초)를 넘어도 저장은 한다(학생 화면에 경고를 보여 준다). 너무 긴 것만 막는다.
    if (finalDur > limit * 3) throw new HttpsError('failed-precondition', `영상이 너무 길어요(지금 ${Math.round(finalDur)}초). 필요 없는 구간을 지우거나 장면을 빼 주세요.`);

    // 조각을 만들고 디졸브로 잇는다. 이을 수 없으면(오래된 ffmpeg) 그냥 붙인다.
    const segs: string[] = [];
    // 마지막이 아닌 조각은 끝 화면을 XF초 더 붙여 두고, 그 위로 다음 조각이 서서히 나타나게 잇는다
    const padded = clips.map((c, k) => (k < clips.length - 1 ? c.dur + XF : c.dur));
    const size = sizeOf(p.aspect);
    for (let k = 0; k < clips.length; k++) segs.push(await renderSegment({ ...clips[k], dur: padded[k] }, k, dir, size));
    let baseFile: string;
    try {
      baseFile = await joinXfade(segs, padded, dir);
    } catch (e: any) {
      logger.warn('render: 디졸브 잇기 실패, 그냥 붙입니다', { err: String(e?.message ?? e).slice(0, 300) });
      const list = pjoin(dir, 'list.txt');
      writeFileSync(list, segs.map((x) => `file '${x}'`).join('\n'));
      baseFile = pjoin(dir, 'joined.mp4');
      await concatCopy(list, baseFile);
    }

    // 구간 자막
    const caps: TlCapIn[] = [];
    for (const c of (tl.caps ?? []).slice(0, 40)) {
      const pngs = (ov.caps?.[String(c.id)] ?? []).slice(0, 16).map(savePng).filter((x): x is string => !!x);
      const anim = (['none', 'fade', 'slide', 'type'].includes(String(c.style?.anim)) ? c.style.anim : 'none') as TlCapIn['anim'];
      const a = absAt(c);
      if (pngs.length && a !== undefined) caps.push({ a, b: a + Math.max(0, num(c.len)), pngs, anim });
    }
    // 구간 목소리: 내 녹음 또는 AI 목소리(정해진 목소리만)
    const voices: TlVoiceIn[] = [];
    let vn = 0;
    for (const v of (tl.voices ?? []).slice(0, 30)) {
      vn++;
      const at = absAt(v);
      if (at === undefined) continue;
      let file: string | undefined;
      if (v.kind === 'mine' && v.path) file = await fetchFile(String(v.path), `voice_${vn}`);
      else if (v.kind === 'ai' && isAiVoice(v.voice) && String(v.text ?? '').trim() && useAi) file = await speak(String(v.text).slice(0, 120), v.voice, pjoin(dir, `tts_${vn}.wav`)).catch(() => undefined);
      // 내 녹음은 정한 길이까지, AI 목소리는 학생이 길이를 직접 정했을 때만 자른다(아니면 끝까지 다 들려준다)
      const cutTo = v.kind === 'mine' || v.fixed ? Math.max(0, num(v.dur)) || undefined : undefined;
      if (file) voices.push({ a: at, file, dur: cutTo });
    }

    const out = await applyTimeline(baseFile, base, cuts, caps, voices, dir);
    const exportId = `${Date.now()}`;
    const path = `classes/${classId}/${no}/exports/${exportId}.mp4`;
    const token = randomUUID();
    await bucket.upload(out.file, { destination: path, contentType: 'video/mp4', metadata: { metadata: { firebaseStorageDownloadTokens: token, aiGenerated: 'true', notice: 'AI 생성 콘텐츠 포함' } } });
    await projRef.update({ lastExport: { path, url: mediaUrl(path, token), at: Date.now(), dur: out.dur, aspect: p.aspect === '9:16' ? '9:16' : '16:9' }, rendering: FieldValue.delete() });
    await log({ classId, no, kind: '완성 영상', textKo: `${out.dur}초 · 클립 ${clips.length}개 · 지운 구간 ${cuts.length}개 · 자막 ${caps.length}개 · 목소리 ${voices.length}개`, verdict: 'pass', action: '영상 저장' });
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
  // ADMIN_EMAILS 를 정해 두면 그 계정만 관리자다(가장 확실한 방법)
  if (adminEmails().length) return !!email && adminEmails().includes(email);
  const c = await db.doc('config/admin').get();
  return c.exists && c.data()?.uid === uid;
}

// 교사 승인 요청에 적는 정보
function teacherInfo(v: any) {
  const t = (x: unknown, n: number) => String(x ?? '').trim().slice(0, n);
  return {
    org: t(v?.org, 60), // 소속 (학교·기관 이름 등)
    realName: t(v?.realName, 20),
  };
}

// 교사가 로그인하면 부른다: 관리자면 바로 승인, 아니면 승인 요청을 남긴다.
export const claimTeacher = onCall(async (req) => {
  const u = googleUser(req);
  const tRef = db.doc(`teachers/${u.uid}`);
  const aRef = db.doc('config/admin');
  const anyApproved = (await db.collection('teachers').where('approved', '==', true).limit(1).get()).size > 0;
  return db.runTransaction(async (tx) => {
    const [t, a] = await Promise.all([tx.get(tRef), tx.get(aRef)]);
    const approvedNow = t.exists && t.data()?.approved === true;
    let admin: boolean;
    if (adminEmails().length) admin = !!u.email && adminEmails().includes(u.email);
    else if (a.exists) admin = a.data()?.uid === u.uid;
    else {
      // 관리자가 아직 없을 때: 이미 승인된 교사이거나, 승인된 교사가 한 명도 없을 때(처음 설치)만 관리자가 된다.
      // 승인 안 된 새 교사가 먼저 들어와도 관리자가 되지 않게 한다.
      admin = approvedNow || !anyApproved;
      if (admin) tx.set(aRef, { uid: u.uid, email: u.email, at: FieldValue.serverTimestamp() });
    }
    if (admin) {
      tx.set(tRef, { approved: true, admin: true, email: u.email, name: u.name, approvedBy: approvedNow ? t.data()?.approvedBy ?? 'admin-self' : 'admin-self', at: FieldValue.serverTimestamp() }, { merge: true });
      return { approved: true, admin: true, requested: true };
    }
    // 관리자가 아닌데 예전에 관리자 표시가 남아 있으면 지운다
    if (t.data()?.admin === true) tx.update(tRef, { admin: false });
    if (approvedNow) return { approved: true, admin: false, requested: true };
    if (!t.exists) tx.set(tRef, { approved: false, email: u.email, name: u.name, firstSeenAt: FieldValue.serverTimestamp() });
    return { approved: false, admin: false, requested: !!t.data()?.requestedAt };
  });
});

// 새 교사: 학교·학년·반·학생 수를 적어 승인 요청 보내기
export const requestTeacher = onCall(async (req) => {
  const u = googleUser(req);
  const info = teacherInfo(req.data);
  if (!info.org || !info.realName) throw new HttpsError('invalid-argument', '소속과 이름을 적어 주세요.');
  const tRef = db.doc(`teachers/${u.uid}`);
  const t = await tRef.get();
  if (t.exists && t.data()?.approved === true) return { ok: true };
  await tRef.set({ approved: false, email: u.email, name: u.name, ...info, requestedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { ok: true };
});

// 관리자: 교사 목록 보기
export const adminTeachers = onCall(async (req) => {
  const u = googleUser(req);
  if (!(await isAdmin(u.uid, u.email))) throw new HttpsError('permission-denied', '관리자만 볼 수 있어요.');
  const qs = await db.collection('teachers').limit(200).get();
  const list = qs.docs.map((d) => {
    const x = d.data();
    const ms = (v: any) => (v instanceof Timestamp ? v.toMillis() : null);
    return { uid: d.id, email: x.email ?? '', name: x.name ?? '', approved: x.approved === true, admin: x.admin === true, requestedAt: ms(x.requestedAt) ?? ms(x.firstSeenAt), org: x.org ?? x.school ?? '', realName: x.realName ?? '', requested: !!x.requestedAt };
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

// ───────── 교사: 학생 작품 모아 보기 ─────────
// 완성 영상, 학생이 올린 영상, 장면으로 정한 AI 영상을 학생별로 모아 바로 재생할 수 있는 주소와 함께 돌려준다.
async function playableUrl(path?: string | null): Promise<string | null> {
  if (!path) return null;
  try {
    const f = getStorage().bucket().file(path);
    const [meta] = await f.getMetadata();
    let token = String((meta.metadata as any)?.firebaseStorageDownloadTokens ?? '').split(',')[0];
    if (!token) {
      token = randomUUID();
      await f.setMetadata({ metadata: { firebaseStorageDownloadTokens: token } });
    }
    return mediaUrl(path, token);
  } catch {
    return null; // 파일이 없으면 건너뛴다
  }
}

export const teacherWorks = onCall({ timeoutSeconds: 120 }, async (req) => {
  const uid = await requireTeacher(req);
  const classId = String(req.data?.classId ?? '');
  await ownedClass(uid, classId);
  const [studentsSnap, projSnap, genSnap] = await Promise.all([
    db.collection(`classes/${classId}/students`).get(),
    db.collection('projects').where('classId', '==', classId).get(),
    db.collection('generations').where('classId', '==', classId).where('kind', '==', 'final').get(),
  ]);
  const names = new Map(studentsSnap.docs.map((d) => [Number(d.data().no), String(d.data().nick || '')]));
  const finals = genSnap.docs.map((d) => d.data()).filter((g) => g.status === 'succeeded');
  const list = await Promise.all(
    projSnap.docs.map(async (d) => {
      const p = d.data();
      const no = Number(p.no);
      const scenes: any[] = p.scenes ?? [];
      const uploads = await Promise.all(
        ((p.uploads ?? []) as any[]).map(async (u) => ({ id: u.id, name: String(u.name ?? ''), dur: u.dur ?? 0, url: u.dl || (await playableUrl(u.path)) })),
      );
      const ai = await Promise.all(
        scenes.map(async (sc, i) => {
          const g = finals.find((x) => x.no === no && x.sceneId === sc.id);
          return g ? { n: i + 1, line: String(sc.line ?? ''), img: !!g.img, url: g.url || (await playableUrl(g.storagePath)) } : null;
        }),
      );
      return {
        no,
        name: names.get(no) ?? '',
        topic: String(p.topic ?? ''),
        submitted: !!p.submitted,
        exportUrl: p.lastExport ? p.lastExport.url || (await playableUrl(p.lastExport.path)) : null,
        exportAt: p.lastExport?.at ?? null,
        exportDur: p.lastExport?.dur ?? null,
        uploads: uploads.filter((u) => u.url),
        ai: ai.filter(Boolean),
      };
    }),
  );
  list.sort((a, b) => a.no - b.no);
  return { list };
});

// ───────── AI 목소리 미리 듣기 ─────────
// text 가 없으면 목소리마다 정해진 예시 문장(한 번 만들어 저장해 두고 다시 씀), 있으면 학생 자막을 읽어 준다.
const VOICE_SAMPLE = '안녕하세요! 오늘은 AI 덕분에 달라진 나의 하루를 소개할게요.';
export const previewVoice = onCall({ timeoutSeconds: 60 }, async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', '다시 로그인해 주세요.');
  const voice = String(req.data?.voice ?? '');
  if (!isAiVoice(voice)) throw new HttpsError('invalid-argument', 'AI 목소리를 골라 주세요.');
  const text = String(req.data?.text ?? '').trim().slice(0, 60);
  const dir = mkdtempSync(pjoin(tmpdir(), 'voice-'));
  try {
    if (!text) {
      const path = `voice-samples/${voiceId(voice)}.wav`;
      const cached = await playableUrl(path);
      if (cached) return { url: cached };
      const out = await speak(VOICE_SAMPLE, voice, pjoin(dir, 's.wav'));
      if (!out) throw new HttpsError('unavailable', '목소리를 만들지 못했어요. 잠시 뒤 다시 해 보세요.');
      const token = randomUUID();
      await getStorage().bucket().upload(out, { destination: path, contentType: 'audio/wav', metadata: { metadata: { firebaseStorageDownloadTokens: token } } });
      return { url: mediaUrl(path, token) };
    }
    const r = moderateRules(text);
    if (!r.pass) throw new HttpsError('invalid-argument', `이 자막은 읽어 줄 수 없어요: ${r.reason}`);
    const out = await speak(text, voice, pjoin(dir, 't.wav'));
    if (!out) throw new HttpsError('unavailable', '목소리를 만들지 못했어요. 잠시 뒤 다시 해 보세요.');
    const { readFileSync } = await import('node:fs');
    return { url: `data:audio/wav;base64,${readFileSync(out).toString('base64')}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
