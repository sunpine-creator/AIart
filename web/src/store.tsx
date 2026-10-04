import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { onAuthStateChanged, signInWithCustomToken, signOut, User } from 'firebase/auth';
import { collection, doc, getDoc, limit, onSnapshot, orderBy, query, setDoc, updateDoc, where } from 'firebase/firestore';
import { deleteObject, getDownloadURL, ref as sref, uploadBytes } from 'firebase/storage';
import { api, auth, db, errText, storage } from './firebase';

// ───────────── 설정값 (서버 functions/src/config.ts 와 같게 유지) ─────────────
export const PRICE = { '360p': 0.03, '720p': 0.1 } as const;
export const CREDIT_PER_SEC = { '360p': 1, '720p': 3 } as const;
// Vertex Omni 미리보기는 720p 만 만든다. 초안을 고르면 그대로 장면으로 확정한다.
export const DRAFT = { res: '720p' as const, sec: 3 };
export const FINAL = DRAFT;
export const MAX_EDITS = 2;
export const CLASS_SIZE = 30;

export type Band = 'elementary' | 'middle';
export type Stage = 1 | 2 | 3 | 4 | 5 | 6;
export type Res = '360p' | '720p';
export type GenStatus = 'awaiting_approval' | 'queued' | 'running' | 'succeeded' | 'blocked' | 'rejected';
export type Fit = 'yes' | 'partial' | 'no';
export type Builder = { who: string; what: string; where: string; how: string };
export type Scene = { id: string; line: string; builder: Builder; selectedGenId?: string; edits: number; dur: number; caption: string; voice: string; voicePath?: string; mood?: string; part?: string; intent?: string };
export type Gen = {
  id: string; sceneId: string; kind: 'draft' | 'edit' | 'final'; promptKo: string; promptEn: string; editText?: string;
  status: GenStatus; queuePos: number; runLeft: number; res: Res; sec: number; hue: number; img: boolean;
  judgement?: { fit: Fit; reason: string }; rejectReason?: string; parentId?: string; at: number;
  storagePath?: string; mimeType?: string; mock?: boolean;
};
export type Log = { id: string; at: number; who: number; kind: string; textKo: string; textEn?: string; verdict: 'pass' | 'blocked'; category?: string; action: string };
export type Upload = { id: string; name: string; url: string; path?: string; srcDur: number; dur: number; caption: string; voice: string; playable: boolean; voicePath?: string };
export type ExportInfo = { path: string; at: number; dur: number; bgmMissing?: boolean };
export type MockStudent = { no: number; nick: string; stage: Stage; credits: number; status: 'idle' | 'waiting' | 'making' | 'blocked' | 'done' };
export type Approval = { id: string; no: number; nick: string; promptKo: string; promptEn: string; genId?: string };
export type ClassInfo = { id: string; title: string; code: string; band: Band; open: Stage; paused: boolean; approval: boolean; videoInMiddle: boolean; budget: number; size: number };

// 학생 작업(프로젝트 문서)에 저장되는 칸
const PROJECT_KEYS = ['sortCards', 'topic', 'story', 'brief', 'scenario', 'scenes', 'intro', 'outro', 'bgm', 'uploads', 'order', 'checklist', 'aiNote', 'self', 'peer', 'submitted', 'prmCmp', 'prmSort', 'prmThink', 'flow', 'editNote', 'reflect'] as const;
export type PromptPart = 'goal' | 'role' | 'content' | 'cond';
type ProjectKey = (typeof PROJECT_KEYS)[number];

export type State = {
  role: 'loading' | 'none' | 'student' | 'teacher' | 'teacher-pending';
  view: 'student' | 'teacher';
  band: Band;
  joined: boolean;
  me: { no: number; nick: string };
  classId: string;
  cls: { title: string; code: string; open: Stage; paused: boolean; approval: boolean; videoInMiddle: boolean; budget: number };
  tab: Stage;
  credits: number;
  sortCards: Record<string, 'ai' | 'human' | undefined>;
  prmCmp: Record<string, { pick?: 'a' | 'b'; missing?: PromptPart[]; checked?: boolean }>;
  prmSort: Record<string, PromptPart | undefined>;
  prmThink: string;
  flow: Record<string, { v?: string; note?: string }>;
  editNote: string;
  reflect: string;
  topic: string;
  story: { who: string; where: string; what: string; event: string; feeling: string };
  brief: { audience: string; purpose: string; message: string };
  scenario: { builder: { goal: string; role: string; content: string; cond: string }; draft: string[]; marked: number[]; final: string };
  scenes: Scene[];
  gens: Gen[];
  logs: Log[];
  intro: { dur: number; caption: string };
  outro: { dur: number; caption: string };
  bgm: string;
  uploads: Upload[];
  order: string[];
  checklist: Record<string, boolean>;
  aiNote: string;
  self: Record<string, string>;
  peer: Record<string, string>;
  submitted: boolean;
  spent: number;
  others: MockStudent[];
  approvals: Approval[];
  otherQueue: number;
  selectedStudent: number;
  peers: { no: number; nick: string; exportPath?: string }[];
  lastExport?: ExportInfo;
  rendering: boolean;
  classes: ClassInfo[];
  pins: Record<string, string>;
  teacherEmail: string;
  toast?: string;
};

const NICKS = ['파랑고래', '초록거북', '노랑병아리', '빨강여우', '하늘다람쥐', '보라문어', '주황호랑이', '분홍돌고래', '하양토끼', '검정고양이', '민트펭귄', '갈색곰', '은빛늑대', '황금사자', '연두개구리', '남색부엉이', '살구판다', '회색코끼리', '하늘고래', '바다수달'];
export const nickOf = (no: number) => NICKS[(no * 7) % NICKS.length];

const newScene = (i: number, who = '', where = ''): Scene => ({ id: `s${Date.now().toString(36)}${i}`, line: '', builder: { who, what: '', where, how: '' }, edits: 0, dur: 3, caption: '', voice: '없음' });

function emptyProject(band: Band) {
  return {
    sortCards: {},
    topic: '',
    story: { who: '나', where: '', what: '', event: '', feeling: '' },
    brief: { audience: '', purpose: '', message: '' },
    scenario: { builder: { goal: '60초 영상 시나리오', role: '중학생 영상 작가', content: '', cond: '장면 5개 이내, 대사는 짧게' }, draft: [], marked: [], final: '' },
    scenes: [newScene(0, '나'), newScene(1, '나')],
    intro: { dur: 3, caption: '' },
    outro: { dur: 3, caption: '판단은 내가, 도움은 AI가' },
    bgm: '없음',
    uploads: [],
    order: [],
    checklist: {},
    aiNote: '',
    self: {},
    peer: {},
    submitted: false,
  } as Record<string, any>;
}

const base: State = {
  role: 'loading', view: 'student', band: 'elementary', joined: false, me: { no: 0, nick: '' }, classId: '',
  cls: { title: '', code: '', open: 1, paused: false, approval: true, videoInMiddle: false, budget: 0 },
  tab: 1, credits: 0, sortCards: {}, prmCmp: {}, prmSort: {}, prmThink: '', flow: {}, editNote: '', reflect: '', topic: '', story: { who: '', where: '', what: '', event: '', feeling: '' },
  brief: { audience: '', purpose: '', message: '' }, scenario: { builder: { goal: '', role: '', content: '', cond: '' }, draft: [], marked: [], final: '' },
  scenes: [], gens: [], logs: [], intro: { dur: 3, caption: '' }, outro: { dur: 3, caption: '' }, bgm: '없음', uploads: [], order: [],
  checklist: {}, aiNote: '', self: {}, peer: {}, submitted: false, spent: 0, others: [], approvals: [], otherQueue: 0,
  selectedStudent: 1, peers: [], classes: [], pins: {}, teacherEmail: '', rendering: false,
};

// ───────────── 액션 (시안과 같은 이름을 유지해 화면 코드를 그대로 쓴다) ─────────────
export type Action =
  | { t: 'set'; patch: Partial<State> }
  | { t: 'cls'; patch: Partial<State['cls']> }
  | { t: 'reset'; band: Band }
  | { t: 'scene'; id: string; patch: Partial<Scene> }
  | { t: 'builder'; id: string; patch: Partial<Builder> }
  | { t: 'request'; sceneId: string; kind: Gen['kind']; editText?: string; parentId?: string }
  | { t: 'judge'; genId: string; judgement: Gen['judgement'] }
  | { t: 'approve'; id: string }
  | { t: 'reject'; id: string; reason: string }
  | { t: 'log'; entry: { kind: string; textKo: string; action: string } }
  | { t: 'upload'; file: File; meta: Upload }
  | { t: 'removeUpload'; id: string }
  | { t: 'voice'; key: string; blob: Blob }
  | { t: 'render' }
  | { t: 'join'; code: string; no: number; name: string }
  | { t: 'openClass'; classId: string }
  | { t: 'signOut' }
  | { t: 'tick' }
  | { t: 'toast'; msg?: string };

const Ctx = createContext<{ s: State; d: (a: Action) => void } | null>(null);

const tsMs = (v: any) => (v?.toMillis ? v.toMillis() : typeof v === 'number' ? v : Date.now());

function toGen(id: string, x: any): Gen {
  let status = x.status as string;
  let rejectReason = x.rejectReason ?? undefined;
  if (status === 'failed') {
    status = 'rejected';
    rejectReason = '만드는 중에 문제가 생겼어요. 크레딧을 돌려받았어요. 다시 해 보세요.';
  }
  return {
    id, sceneId: x.sceneId, kind: x.kind, promptKo: x.promptKo ?? '', promptEn: x.promptEn ?? '', editText: x.editText ?? undefined,
    status: status as GenStatus, queuePos: 0, runLeft: 0, res: x.res, sec: x.sec, hue: x.hue ?? 200, img: !!x.img,
    judgement: x.judgement ?? undefined, rejectReason, parentId: x.parentId ?? undefined, at: tsMs(x.createdAt),
    storagePath: x.storagePath ?? undefined, mimeType: x.mimeType ?? undefined, mock: !!x.mock,
  };
}

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [role, setRole] = useState<State['role']>('loading');
  const [claims, setClaims] = useState<{ classId?: string; no?: number }>({});
  const [local, setLocal] = useState({ tab: 1 as Stage, selectedStudent: 1, toast: undefined as string | undefined, classId: '', rendering: false });
  const [cls, setCls] = useState<any>(null);
  const [student, setStudent] = useState<any>(null);
  const [project, setProject] = useState<Record<string, any> | null>(null);
  const [gens, setGens] = useState<Gen[]>([]);
  const [students, setStudents] = useState<any[]>([]);
  const [pending, setPending] = useState<any[]>([]);
  const [logs, setLogs] = useState<Log[]>([]);
  const [usage, setUsage] = useState(0);
  const [classes, setClasses] = useState<ClassInfo[]>([]);
  const [pins] = useState<Record<string, string>>({});
  const [peers, setPeers] = useState<{ no: number; nick: string; exportPath?: string }[]>([]);
  const [uploadUrls, setUploadUrls] = useState<Record<string, string>>({});
  const saveTimer = useRef<number | undefined>(undefined);
  const projectRef = useRef<Record<string, any> | null>(null);

  const toast = (msg?: string) => setLocal((l) => ({ ...l, toast: msg }));
  // 실시간 구독이 권한 등으로 실패하면 조용히 멈추지 않고 화면과 콘솔에 알린다
  const onErr = (what: string) => (e: any) => {
    console.error(`[구독 실패] ${what}`, e);
    toast(`${what}을(를) 불러오지 못했어요: ${e?.code ?? e?.message ?? e}`);
  };

  // 로그인 상태와 역할
  useEffect(
    () =>
      onAuthStateChanged(auth, async (u) => {
        setUser(u);
        if (!u) return setRole('none');
        const tok = await u.getIdTokenResult();
        if (tok.claims.role === 'student') {
          setClaims({ classId: String(tok.claims.classId), no: Number(tok.claims.no) });
          setRole('student');
        } else {
          let ok = false;
          const t = await getDoc(doc(db, 'teachers', u.uid)).catch(() => null);
          ok = !!(t?.exists() && t.data()?.approved === true);
          // 아직 승인 전이면 서버에 알린다(관리자면 바로 승인, 아니면 승인 요청이 남는다)
          if (!ok && u.providerData.some((p) => p.providerId === 'google.com')) {
            ok = await api.claimTeacher({}).then((r) => r.approved, () => false);
          }
          setRole(ok ? 'teacher' : 'teacher-pending');
        }
      }),
    [],
  );

  // ───── 학생 구독 ─────
  useEffect(() => {
    if (role !== 'student' || !claims.classId) return;
    const { classId, no } = claims as { classId: string; no: number };
    const pid = `${classId}_${no}`;
    const unsubs = [
      onSnapshot(doc(db, 'classes', classId), (d) => setCls({ id: d.id, ...d.data() }), onErr('반 정보')),
      onSnapshot(doc(db, 'classes', classId, 'students', String(no)), (d) => setStudent(d.data()), onErr('내 정보')),
      onSnapshot(collection(db, 'classes', classId, 'students'), (q) => setStudents(q.docs.map((d) => d.data()).sort((a, b) => a.no - b.no)), () => {}),
      onSnapshot(doc(db, 'projects', pid), (d) => {
        if (!d.exists()) {
          const p: Record<string, any> = { ...emptyProject('elementary'), classId, no };
          setDoc(doc(db, 'projects', pid), p);
          return;
        }
        // 내가 방금 고친 내용이 저장 대기 중이면 덮어쓰지 않는다
        if (saveTimer.current) return;
        projectRef.current = d.data();
        setProject(d.data());
      }, onErr('내 작업')),
      onSnapshot(query(collection(db, 'generations'), where('classId', '==', classId), where('no', '==', no), orderBy('createdAt', 'asc')), (q) =>
        setGens(q.docs.map((x) => toGen(x.id, x.data()))),
      onErr('내 생성 기록')),
      onSnapshot(query(collection(db, 'projects'), where('classId', '==', classId), where('submitted', '==', true), limit(30)), (q) =>
        setPeers(q.docs.map((x) => ({ no: x.data().no, nick: '', exportPath: x.data().lastExport?.path })).filter((p) => p.no !== no)),
      onErr('친구 작품')),
    ];
    return () => unsubs.forEach((u) => u());
  }, [role, claims.classId, claims.no]);

  // ───── 교사 구독 ─────
  useEffect(() => {
    if (role !== 'teacher' || !user) return;
    return onSnapshot(query(collection(db, 'classes'), where('teacherUid', '==', user.uid)), (q) =>
      setClasses(
        q.docs.map((d) => {
          const x = d.data();
          return { id: d.id, title: x.title, code: x.code, band: x.band, open: x.open, paused: x.paused, approval: x.approval, videoInMiddle: x.videoInMiddle, budget: x.budgetUsd, size: x.size };
        }),
      ),
    onErr('내 반 목록'));
  }, [role, user]);
  useEffect(() => {
    if (role !== 'teacher' || !local.classId) return;
    const c = local.classId;
    const day = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, '');
    const unsubs = [
      onSnapshot(doc(db, 'classes', c), (d) => setCls({ id: d.id, ...d.data() }), onErr('반 정보')),
      onSnapshot(collection(db, 'classes', c, 'students'), (q) => setStudents(q.docs.map((d) => d.data()).sort((a, b) => a.no - b.no)), onErr('학생 명단')),
      onSnapshot(query(collection(db, 'generations'), where('classId', '==', c), where('status', '==', 'awaiting_approval'), orderBy('createdAt', 'asc')), (q) =>
        setPending(q.docs.map((d) => ({ id: d.id, ...d.data() }))),
      onErr('승인 대기')),
      onSnapshot(query(collection(db, 'promptLogs'), where('classId', '==', c), orderBy('at', 'desc'), limit(500)), (q) =>
        setLogs(
          q.docs
            .map((d) => {
              const x = d.data();
              return { id: d.id, at: tsMs(x.at), who: x.no, kind: x.kind, textKo: x.textKo, textEn: x.textEn, verdict: x.verdict, category: x.category, action: x.action } as Log;
            })
            .reverse(),
        ),
      onErr('프롬프트 기록')),
      onSnapshot(doc(db, 'usage', `${c}_${day}`), (d) => setUsage(d.data()?.costUsd ?? 0), onErr('오늘 비용')),
    ];
    return () => unsubs.forEach((u) => u());
  }, [role, local.classId]);

  // 완성본이 끝나면 그 장면에 자동으로 넣는다
  useEffect(() => {
    if (!project) return;
    const finals = gens.filter((g) => g.kind === 'final' && g.status === 'succeeded');
    const scenes: Scene[] = project.scenes ?? [];
    let changed = false;
    const next = scenes.map((sc) => {
      const f = finals.filter((g) => g.sceneId === sc.id).pop();
      if (f && sc.selectedGenId !== f.id) {
        changed = true;
        return { ...sc, selectedGenId: f.id };
      }
      return sc;
    });
    if (changed) patchProject({ scenes: next });
  }, [gens, project?.scenes]);

  // 올린 영상의 주소 찾기
  useEffect(() => {
    for (const u of (project?.uploads ?? []) as Upload[]) {
      if (u.path && !uploadUrls[u.id]) getDownloadURL(sref(storage, u.path)).then((url) => setUploadUrls((m) => ({ ...m, [u.id]: url })), () => {});
    }
  }, [project?.uploads]);

  // 학생이 보고 있는 단계를 교사 현황판에 알린다
  useEffect(() => {
    if (role !== 'student' || !claims.classId) return;
    updateDoc(doc(db, 'classes', claims.classId, 'students', String(claims.no)), { stage: local.tab, lastSeen: Date.now() }).catch(() => {});
  }, [role, local.tab, claims.classId]);

  function patchProject(patch: Record<string, any>) {
    if (!claims.classId) return;
    const next = { ...(projectRef.current ?? {}), ...patch };
    projectRef.current = next;
    setProject(next);
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = undefined;
      const clean: Record<string, any> = {};
      for (const k of PROJECT_KEYS) if (k in next) clean[k] = k === 'uploads' ? (next.uploads as Upload[]).map(({ url, ...rest }) => rest) : next[k];
      // updateDoc 은 최상위 칸을 통째로 바꾼다(지운 항목이 남지 않게). JSON 변환으로 undefined 를 뺀다.
      updateDoc(doc(db, 'projects', `${claims.classId}_${claims.no}`), JSON.parse(JSON.stringify({ ...clean, updatedAt: Date.now() }))).catch((e) =>
        toast(`저장하지 못했어요: ${errText(e)}`),
      );
    }, 600);
  }

  const s: State = useMemo(() => {
    const band: Band = cls?.band ?? 'elementary';
    const p = project ?? {};
    const editsOf = (sceneId: string) => gens.filter((g) => g.sceneId === sceneId && g.kind === 'edit' && g.status !== 'blocked' && g.status !== 'rejected').length;
    const nickByNo = (no: number) => students.find((x) => x.no === no)?.nick || '';
    return {
      ...base,
      role,
      view: role === 'teacher' ? 'teacher' : 'student',
      band,
      joined: role === 'student',
      me: { no: claims.no ?? 0, nick: student?.nick || '' },
      classId: cls?.id ?? local.classId,
      cls: cls
        ? { title: cls.title, code: cls.code, open: cls.open, paused: cls.paused, approval: cls.approval, videoInMiddle: cls.videoInMiddle, budget: cls.budgetUsd }
        : base.cls,
      tab: local.tab,
      credits: student?.credits ?? 0,
      sortCards: p.sortCards ?? {},
      prmCmp: p.prmCmp ?? {},
      prmSort: p.prmSort ?? {},
      prmThink: p.prmThink ?? '',
      flow: p.flow ?? {},
      editNote: p.editNote ?? '',
      reflect: p.reflect ?? '',
      topic: p.topic ?? '',
      story: p.story ?? base.story,
      brief: p.brief ?? base.brief,
      scenario: p.scenario ?? base.scenario,
      // 영상 장면은 만든 영상 길이(3초)보다 길게 쓸 수 없다
      scenes: ((p.scenes ?? []) as Scene[]).map((sc) => {
        const g = gens.find((x) => x.id === sc.selectedGenId);
        return { ...sc, edits: editsOf(sc.id), dur: g && !g.img ? Math.min(sc.dur, g.sec) : sc.dur };
      }),
      gens,
      logs,
      intro: p.intro ?? base.intro,
      outro: p.outro ?? base.outro,
      bgm: p.bgm ?? '없음',
      uploads: ((p.uploads ?? []) as Upload[]).map((u) => ({ ...u, url: u.url || uploadUrls[u.id] || '' })),
      order: p.order ?? [],
      checklist: p.checklist ?? {},
      aiNote: p.aiNote ?? '',
      self: p.self ?? {},
      peer: p.peer ?? {},
      submitted: !!p.submitted,
      spent: Math.round(usage * 100) / 100,
      others: students.map((x) => ({ no: x.no, nick: x.nick || '', stage: x.stage, credits: x.credits, status: x.status })),
      approvals: pending.map((g) => ({ id: g.id, genId: g.id, no: g.no, nick: nickByNo(g.no), promptKo: g.editText ? `${g.promptKo}` : g.promptKo, promptEn: g.promptEn ?? '' })),
      selectedStudent: local.selectedStudent,
      peers: peers.map((p) => ({ ...p, nick: nickByNo(p.no) })),
      lastExport: p.lastExport,
      rendering: local.rendering || (!!p.rendering && Date.now() - p.rendering < 10 * 60_000),
      classes,
      pins,
      teacherEmail: user?.email ?? '',
      toast: local.toast,
    };
  }, [role, cls, student, project, gens, students, pending, logs, usage, classes, pins, peers, uploadUrls, local, claims, user]);

  const d = (a: Action) => {
    switch (a.t) {
      case 'set': {
        const proj: Record<string, any> = {};
        const loc: any = {};
        for (const [k, v] of Object.entries(a.patch)) {
          if ((PROJECT_KEYS as readonly string[]).includes(k)) proj[k] = k === 'scenes' ? (v as Scene[]).map(({ edits, ...rest }) => ({ ...rest, edits: 0 })) : v;
          else if (k === 'tab' || k === 'selectedStudent' || k === 'toast') loc[k] = v;
        }
        if (Object.keys(loc).length) setLocal((l) => ({ ...l, ...loc }));
        if (Object.keys(proj).length) patchProject(proj);
        return;
      }
      case 'cls':
        if (!s.classId) return;
        updateDoc(doc(db, 'classes', s.classId), {
          ...(a.patch.open !== undefined && { open: a.patch.open }),
          ...(a.patch.paused !== undefined && { paused: a.patch.paused }),
          ...(a.patch.approval !== undefined && { approval: a.patch.approval }),
          ...(a.patch.videoInMiddle !== undefined && { videoInMiddle: a.patch.videoInMiddle }),
          ...(a.patch.budget !== undefined && { budgetUsd: a.patch.budget }),
        }).catch((e) => toast(errText(e)));
        return;
      case 'scene':
        patchProject({ scenes: (projectRef.current?.scenes ?? []).map((x: Scene) => (x.id === a.id ? { ...x, ...a.patch } : x)) });
        return;
      case 'builder':
        patchProject({ scenes: (projectRef.current?.scenes ?? []).map((x: Scene) => (x.id === a.id ? { ...x, builder: { ...x.builder, ...a.patch } } : x)) });
        return;
      case 'request': {
        const sc = (projectRef.current?.scenes ?? []).find((x: Scene) => x.id === a.sceneId);
        api
          .requestGeneration({ kind: a.kind, sceneId: a.sceneId, builder: sc?.builder, editText: a.editText, parentId: a.parentId })
          .then((r) => r.blocked && toast('안전 검사에서 멈췄어요. 크레딧은 그대로예요.'))
          .catch((e) => toast(errText(e)));
        return;
      }
      case 'judge':
        updateDoc(doc(db, 'generations', a.genId), { judgement: a.judgement }).catch((e) => toast(errText(e)));
        return;
      case 'approve':
        api.reviewGeneration({ genId: a.id, approve: true }).catch((e) => toast(errText(e)));
        return;
      case 'reject':
        api.reviewGeneration({ genId: a.id, approve: false, reason: a.reason }).catch((e) => toast(errText(e)));
        return;
      case 'log':
        api.logEvent(a.entry).catch(() => {});
        return;
      case 'upload': {
        const ext = a.file.name.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4';
        const path = `classes/${claims.classId}/${claims.no}/uploads/${a.meta.id}.${ext}`;
        setUploadUrls((m) => ({ ...m, [a.meta.id]: a.meta.url }));
        patchProject({ uploads: [...(projectRef.current?.uploads ?? []), { ...a.meta, path }], order: [...(projectRef.current?.order ?? []), a.meta.id] });
        toast('영상을 올리는 중이에요…');
        uploadBytes(sref(storage, path), a.file, { contentType: a.file.type })
          .then(() => toast('영상을 올렸어요.'))
          .catch((e) => {
            toast(`올리지 못했어요: ${errText(e)}`);
            patchProject({ uploads: (projectRef.current?.uploads ?? []).filter((u: Upload) => u.id !== a.meta.id) });
          });
        return;
      }
      case 'removeUpload': {
        const u = (projectRef.current?.uploads ?? []).find((x: Upload) => x.id === a.id);
        if (u?.path) deleteObject(sref(storage, u.path)).catch(() => {});
        patchProject({ uploads: (projectRef.current?.uploads ?? []).filter((x: Upload) => x.id !== a.id), order: (projectRef.current?.order ?? []).filter((k: string) => k !== a.id) });
        return;
      }
      case 'voice': {
        const path = `classes/${claims.classId}/${claims.no}/voices/${a.key}.webm`;
        toast('녹음을 저장하는 중이에요…');
        uploadBytes(sref(storage, path), a.blob, { contentType: a.blob.type || 'audio/webm' })
          .then(() => {
            const cur = projectRef.current ?? {};
            if ((cur.scenes ?? []).some((x: Scene) => x.id === a.key)) patchProject({ scenes: cur.scenes.map((x: Scene) => (x.id === a.key ? { ...x, voicePath: path, voice: '내 목소리' } : x)) });
            else patchProject({ uploads: (cur.uploads ?? []).map((u: Upload) => (u.id === a.key ? { ...u, voicePath: path, voice: '내 목소리' } : u)) });
            toast('녹음을 저장했어요.');
          })
          .catch((e) => toast(`녹음을 저장하지 못했어요: ${errText(e)}`));
        return;
      }
      case 'render':
        setLocal((l) => ({ ...l, rendering: true }));
        // 편집 내용이 저장된 뒤에 합치도록 잠깐 기다린다
        window.setTimeout(() => {
          api
            .renderVideo({})
            .then(() => toast('영상을 저장했어요!'))
            .catch((e) => toast(errText(e)))
            .finally(() => setLocal((l) => ({ ...l, rendering: false })));
        }, 900);
        return;
      case 'join':
        api
          .joinClass({ code: a.code, no: a.no, name: a.name })
          .then((r) => signInWithCustomToken(auth, r.token))
          .catch((e) => toast(errText(e)));
        return;
      case 'openClass':
        setLocal((l) => ({ ...l, classId: a.classId, selectedStudent: 1 }));
        return;
      case 'signOut':
        signOut(auth);
        setLocal((l) => ({ ...l, classId: '' }));
        return;
      case 'toast':
        toast(a.msg);
        return;
      case 'reset':
      case 'tick':
        return;
    }
  };

  useEffect(() => {
    if (!local.toast) return;
    const t = setTimeout(() => toast(undefined), 3200);
    return () => clearTimeout(t);
  }, [local.toast]);

  return <Ctx.Provider value={{ s, d }}>{children}</Ctx.Provider>;
}

export function useStore() {
  const v = useContext(Ctx);
  if (!v) throw new Error('StoreProvider 밖에서 사용됨');
  return v;
}

export const maxSec = (b: Band) => (b === 'elementary' ? 30 : 60);
export const mediaWord = (s: State) => (s.band === 'middle' && !s.cls.videoInMiddle ? '이미지' : '영상');
