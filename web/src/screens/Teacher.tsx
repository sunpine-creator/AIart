import React, { useEffect, useState } from 'react';
import { GoogleAuthProvider, signInWithPopup } from 'firebase/auth';
import { Log, Stage, useStore } from '../store';
import { STAGES } from './Student';
import { StudentWork, TeacherRow, api, auth, errText } from '../firebase';

const REJECT_REASONS = ['장면 이야기와 맞지 않아요', '더 구체적으로 써 보세요', '안전하지 않은 표현이 있어요'];

export function TeacherApp() {
  const { s } = useStore();
  if (s.role === 'loading') return <div className="teacher"><p className="muted">불러오는 중…</p></div>;
  if (s.role === 'none' || s.role === 'student') return <TeacherSignIn />;
  if (s.role === 'teacher-pending') return <TeacherPending />;
  if (!s.classId) return <ClassList />;
  return <Dashboard />;
}

function TeacherSignIn() {
  const [err, setErr] = useState('');
  return (
    <div className="join">
      <div className="join-card">
        <h1 className="join-title">교사 로그인</h1>
        <p className="muted">학교 Google 계정으로 로그인하세요. 처음 로그인하면 운영자 승인이 필요해요.</p>
        <button
          className="btn primary wide"
          onClick={() => signInWithPopup(auth, new GoogleAuthProvider()).catch((e) => setErr(errText(e)))}
        >
          Google 계정으로 로그인
        </button>
        {err && <p className="danger-text">{err}</p>}
        <p className="tiny muted">
          학생이신가요? <a href="/">학생 입장 화면으로 가기</a>
        </p>
      </div>
    </div>
  );
}

function TeacherPending() {
  const { s, d } = useStore();
  const [requested, setRequested] = useState<boolean | null>(null);
  const [f, setF] = useState({ realName: '', school: '', grade: '', klass: '', students: '' });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.claimTeacher({}).then((r) => (r.approved ? location.reload() : setRequested(r.requested)), () => setRequested(false));
  }, []);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const ok = f.school.trim() && f.grade && Number(f.students) > 0;
  const send = () => {
    setBusy(true);
    api
      .requestTeacher({ ...f, students: Number(f.students) })
      .then(() => (setRequested(true), d({ t: 'toast', msg: '승인 요청을 보냈어요.' })), (e) => d({ t: 'toast', msg: errText(e) }))
      .finally(() => setBusy(false));
  };
  return (
    <div className="join">
      <div className="join-card">
        <h1 className="join-title">{requested ? '승인을 기다리고 있어요' : '교사 승인 요청하기'}</h1>
        <p>유료 AI를 쓰는 서비스라 관리자가 교사 계정을 승인해야 해요.</p>
        <p className="mono tiny">{s.teacherEmail}</p>
        {requested === false && (
          <div className="join-form">
            <label htmlFor="tr-name">선생님 이름</label>
            <input id="tr-name" value={f.realName} onChange={set('realName')} placeholder="예: 김하늘" maxLength={20} />
            <label htmlFor="tr-school">학교 이름</label>
            <input id="tr-school" value={f.school} onChange={set('school')} placeholder="예: 제주초등학교" maxLength={40} />
            <div className="row3">
              <div>
                <label htmlFor="tr-grade">학년</label>
                <select id="tr-grade" value={f.grade} onChange={set('grade')}>
                  <option value="">고르기</option>
                  {['초1', '초2', '초3', '초4', '초5', '초6', '중1', '중2', '중3'].map((g) => (
                    <option key={g}>{g}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="tr-klass">반</label>
                <input id="tr-klass" value={f.klass} onChange={set('klass')} placeholder="예: 2반" maxLength={10} />
              </div>
              <div>
                <label htmlFor="tr-n">학생 수</label>
                <input id="tr-n" type="number" min={1} max={40} value={f.students} onChange={set('students')} placeholder="예: 25" />
              </div>
            </div>
            <button className="btn primary wide" disabled={!ok || busy} onClick={send}>
              {busy ? '보내는 중…' : '승인 요청 보내기'}
            </button>
          </div>
        )}
        {requested && <p className="muted">요청을 보냈어요. 관리자가 승인하면 아래 "다시 확인"을 눌러 주세요.</p>}
        {import.meta.env.VITE_USE_EMULATORS === '1' && (
          <button
            className="btn primary"
            onClick={() => api.devApproveTeacher({}).then(() => location.reload(), (e) => d({ t: 'toast', msg: errText(e) }))}
          >
            연습 모드: 바로 승인하기
          </button>
        )}
        {requested && <button className="btn" onClick={() => location.reload()}>승인됐는지 다시 확인</button>}
        <button className="link" onClick={() => d({ t: 'signOut' })}>다른 계정으로 로그인</button>
      </div>
    </div>
  );
}

function ClassList() {
  const { s, d } = useStore();
  const [title, setTitle] = useState('');
  const [band, setBand] = useState<'elementary' | 'middle'>('elementary');
  const [size, setSize] = useState(30);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const r = await api.createClass({ title, band, size });
      setTitle('');
      setAdding(false);
      d({ t: 'openClass', classId: r.classId });
    } catch (e) {
      d({ t: 'toast', msg: errText(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="teacher">
      <header className="t-head">
        <div>
          <h1 className="t-title">내 반 목록</h1>
          <span className="muted">
            {s.teacherEmail} · <button className="link" onClick={() => d({ t: 'signOut' })}>로그아웃</button>
          </span>
        </div>
        <button className="btn primary" onClick={() => setAdding(!adding)}>
          {adding ? '닫기' : '+ 새 반 추가'}
        </button>
      </header>
      <div className="class-grid">
        {s.classes.map((c) => (
          <button key={c.id} className="class-card" onClick={() => d({ t: 'openClass', classId: c.id })}>
            <strong>{c.title}</strong>
            <span className="muted">{c.band === 'elementary' ? '초등' : '중등'} · {c.size}명 · 열린 단계 {c.open}</span>
            <span className="mono strong">반 코드 {c.code}</span>
          </button>
        ))}
        {s.classes.length === 0 && !adding && <p className="muted">아직 만든 반이 없어요. 오른쪽 위 “+ 새 반 추가”를 눌러 첫 반을 만들어 보세요.</p>}
        <button className="class-card add-card" onClick={() => setAdding(true)}>
          <strong>+ 새 반 추가</strong>
          <span className="muted">반을 더 만들 수 있어요</span>
        </button>
      </div>
      {(adding || s.classes.length === 0) && (
      <section className="panel" id="new-class">
        <h3>새 반 만들기</h3>
        <div className="grid3">
          <div className="field">
            <label htmlFor="c-title">반 이름</label>
            <input id="c-title" placeholder="예: 6학년 2반" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="c-band">학교급</label>
            <select id="c-band" value={band} onChange={(e) => setBand(e.target.value as any)}>
              <option value="elementary">초등 (30초 영상)</option>
              <option value="middle">중등 (60초 영상)</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="c-size">학생 수</label>
            <input id="c-size" type="number" min={1} max={40} value={size} onChange={(e) => setSize(Number(e.target.value))} />
          </div>
        </div>
        <button className="btn primary" disabled={!title.trim() || busy} onClick={create}>
          {busy ? '만드는 중…' : '반 만들고 학생 카드 받기'}
        </button>
      </section>
      )}
      <AdminPanel />
    </div>
  );
}

// 관리자에게만 보이는 교사 승인 관리. 관리자가 아니면 아무것도 그리지 않는다.
function AdminPanel() {
  const { d } = useStore();
  const [list, setList] = useState<TeacherRow[] | null>(null);
  const [busy, setBusy] = useState('');
  const load = () => api.adminTeachers({}).then((r) => setList(r.list), () => setList(null));
  useEffect(() => {
    load();
    const id = window.setInterval(load, 30_000);
    return () => window.clearInterval(id);
  }, []);
  if (!list) return null;
  const pending = list.filter((t) => !t.approved).length;
  const set = (uid: string, approved: boolean) => {
    setBusy(uid);
    api
      .setTeacherApproval({ uid, approved })
      .then(load, (e) => d({ t: 'toast', msg: errText(e) }))
      .finally(() => setBusy(''));
  };
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>교사 승인 관리 (관리자)</h3>
        <span className="tiny muted">승인 대기 {pending}명 · <button className="link" onClick={load}>새로고침</button></span>
      </div>
      {list.length === 0 && <p className="muted">아직 로그인한 교사가 없어요.</p>}
      <table className="admin-table">
        <tbody>
          {list.map((t) => (
            <tr key={t.uid}>
              <td>
                <strong>{t.realName || t.name || '(이름 없음)'}</strong>
                <div className="tiny muted mono">{t.email}</div>
              </td>
              <td>
                {t.school ? (
                  <>
                    {t.school}
                    <div className="tiny muted">
                      {t.grade} {t.klass} · 학생 {t.students}명
                    </div>
                  </>
                ) : (
                  <span className="tiny muted">{t.approved ? '' : '아직 요청서를 안 보냈어요'}</span>
                )}
              </td>
              <td>{t.admin ? '관리자' : t.approved ? '승인됨' : <strong>대기 중</strong>}</td>
              <td>
                {!t.admin &&
                  (t.approved ? (
                    <button className="btn tiny" disabled={busy === t.uid} onClick={() => set(t.uid, false)}>승인 취소</button>
                  ) : (
                    <button className="btn tiny primary" disabled={busy === t.uid} onClick={() => set(t.uid, true)}>승인하기</button>
                  ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// 학생 입장 안내: 반 코드와 주소만 알려 주면, 학생이 번호와 이름으로 들어온다.
// 처음 들어올 때 쓴 이름이 그 번호에 저장된다. 잘못 등록됐으면 고치거나 지울 수 있다.
function PinCards() {
  const { s, d } = useStore();
  const link = `${location.origin}/?code=${s.cls.code}`;
  const [editNo, setEditNo] = useState(0);
  const [val, setVal] = useState('');
  const save = (no: number, name: string) =>
    api
      .resetPin({ classId: s.classId, no, name })
      .then(() => (d({ t: 'toast', msg: name ? `${no}번 이름을 고쳤어요.` : `${no}번 이름을 지웠어요. 다음에 들어올 때 새로 등록해요.` }), setEditNo(0)), (e) => d({ t: 'toast', msg: errText(e) }));
  const joined = s.others.filter((r) => r.nick).length;
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>학생 입장 안내</h3>
        <span className="tiny muted">들어온 학생 {joined} / {s.others.length}명</span>
      </div>
      <div className="entry-guide">
        <div>
          <span className="tiny muted">반 코드</span>
          <span className="mono entry-code">{s.cls.code}</span>
        </div>
        <div>
          <span className="tiny muted">학생 주소</span>
          <span className="mono">{link}</span>
        </div>
        <p className="tiny muted">학생은 반 코드, 번호, 이름을 넣고 들어와요. 처음 쓴 이름이 그 번호에 저장되고, 다음부터는 같은 이름이어야 들어올 수 있어요.</p>
      </div>
      <div className="pin-grid">
        {s.others.map((r) => (
          <div className="pin-card" key={r.no}>
            <span className="mono strong">{r.no}번</span>
            {editNo === r.no ? (
              <>
                <input aria-label={`${r.no}번 이름`} value={val} maxLength={12} onChange={(e) => setVal(e.target.value)} />
                <div className="chip-actions">
                  <button className="btn tiny primary" disabled={!val.trim()} onClick={() => save(r.no, val.trim())}>저장</button>
                  <button className="btn tiny" onClick={() => setEditNo(0)}>취소</button>
                </div>
              </>
            ) : (
              <>
                <span className={r.nick ? '' : 'muted'}>{r.nick || '아직 안 들어왔어요'}</span>
                <div className="chip-actions">
                  <button className="link tiny" onClick={() => (setEditNo(r.no), setVal(r.nick))}>{r.nick ? '고치기' : '미리 넣기'}</button>
                  {r.nick && <button className="link tiny" onClick={() => save(r.no, '')}>지우기</button>}
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

// 반 삭제: 반 이름을 그대로 써야 지울 수 있다(실수 방지). 되돌릴 수 없다.
function DeleteClass({ onClose }: { onClose: () => void }) {
  const { s, d } = useStore();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [sec, setSec] = useState(0);
  useEffect(() => {
    if (!busy) return;
    const id = window.setInterval(() => setSec((x) => x + 1), 1000);
    return () => window.clearInterval(id);
  }, [busy]);
  const run = () => {
    const title = s.cls.title;
    const classId = s.classId;
    setSec(0);
    setBusy(true);
    api
      .deleteClass({ classId })
      .then(() => {
        setBusy(false);
        onClose();
        d({ t: 'openClass', classId: '' });
        d({ t: 'toast', msg: `「${title}」 반을 삭제했어요.` });
      })
      .catch((e) => {
        setBusy(false);
        d({ t: 'toast', msg: `삭제하지 못했어요: ${errText(e)}` });
      });
  };
  return (
    <section className="panel danger-panel" role="alertdialog" aria-label="반 삭제 확인">
      <h3>이 반을 삭제할까요?</h3>
      <p>
        학생 명단, 학생 작업, AI로 만든 영상, 프롬프트 기록, 완성 영상이 <strong>모두 지워지고 되돌릴 수 없어요.</strong> 반 코드로도 더 이상 들어올 수 없어요.
      </p>
      <label htmlFor="del-typed">확인을 위해 반 이름 「{s.cls.title}」을 그대로 써 주세요</label>
      <input id="del-typed" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
      <div className="actions">
        <button className="btn danger" disabled={typed.trim() !== s.cls.title.trim() || busy} onClick={run}>
          {busy ? `지우는 중… ${sec}초 (영상이 많으면 1~2분 걸려요)` : '영구 삭제'}
        </button>
        <button className="btn" onClick={onClose} disabled={busy}>
          취소
        </button>
      </div>
    </section>
  );
}

// 학생 작품 모아 보기: 완성 영상, 학생이 올린 영상, 장면으로 정한 AI 영상
function StudentWorks() {
  const { s, d } = useStore();
  const [list, setList] = useState<StudentWork[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [only, setOnly] = useState<'all' | 'export' | 'upload'>('all');
  const load = () => {
    setBusy(true);
    api
      .teacherWorks({ classId: s.classId })
      .then((r) => setList(r.list), (e) => d({ t: 'toast', msg: errText(e) }))
      .finally(() => setBusy(false));
  };
  useEffect(() => void load(), [s.classId]);
  const shown = (list ?? []).filter((w) => (only === 'export' ? !!w.exportUrl : only === 'upload' ? w.uploads.length > 0 : w.exportUrl || w.uploads.length || w.ai.length));
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>학생 작품</h3>
        <div className="actions">
          <div className="pills">
            {(
              [
                ['all', '전체'],
                ['export', '완성 영상'],
                ['upload', '학생이 올린 영상'],
              ] as const
            ).map(([k, t]) => (
              <button key={k} className={`pill ${only === k ? 'on' : ''}`} aria-pressed={only === k} onClick={() => setOnly(k)}>
                {t}
              </button>
            ))}
          </div>
          <button className="btn tiny" onClick={load} disabled={busy}>
            {busy ? '불러오는 중…' : '새로고침'}
          </button>
        </div>
      </div>
      {!list && <p className="muted">불러오는 중…</p>}
      {list && shown.length === 0 && <p className="muted">아직 보여 줄 작품이 없어요.</p>}
      <div className="works">
        {shown.map((w) => (
          <article className="work-card" key={w.no}>
            <header className="work-card-head">
              <strong>
                {w.no}번 {w.name || '(미입장)'}
              </strong>
              {w.submitted && <span className="chip good">제출함</span>}
              {w.topic && <span className="tiny muted">「{w.topic}」</span>}
            </header>
            {only !== 'upload' && (
              w.exportUrl ? (
                <div className="work-block">
                  <span className="tiny muted">
                    완성 영상 · {w.exportDur}초{w.exportAt ? ` · ${new Date(w.exportAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''}
                  </span>
                  <video className="work-video" src={w.exportUrl} controls playsInline preload="metadata" />
                  <a className="tiny" href={w.exportUrl} target="_blank" rel="noreferrer">
                    새 창에서 열기 (⋮ 메뉴에서 저장)
                  </a>
                </div>
              ) : (
                <p className="tiny muted">아직 완성 영상을 저장하지 않았어요.</p>
              )
            )}
            {only !== 'export' && w.uploads.length > 0 && (
              <div className="work-block">
                <span className="tiny muted">학생이 올린 영상 {w.uploads.length}개</span>
                <div className="work-thumbs">
                  {w.uploads.map((u) => (
                    <figure key={u.id}>
                      <video className="work-video sm" src={u.url} controls playsInline preload="metadata" />
                      <figcaption className="tiny muted">{u.name}</figcaption>
                    </figure>
                  ))}
                </div>
              </div>
            )}
            {only === 'all' && w.ai.length > 0 && (
              <details className="work-block">
                <summary className="tiny">AI로 만든 장면 {w.ai.length}개 보기</summary>
                <div className="work-thumbs">
                  {w.ai.map((a) =>
                    a.url ? (
                      <figure key={a.n}>
                        {a.img ? <img className="work-video sm" src={a.url} alt="" /> : <video className="work-video sm" src={a.url} controls playsInline preload="none" />}
                        <figcaption className="tiny muted">
                          #{a.n} {a.line}
                        </figcaption>
                      </figure>
                    ) : null,
                  )}
                </div>
              </details>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

function Dashboard() {
  const { s, d } = useStore();
  const [showPins, setShowPins] = useState(false);
  const [showWorks, setShowWorks] = useState(false);
  const [askDelete, setAskDelete] = useState(false);
  const roster = s.others;
  const me = roster[0] ?? { no: 0, nick: '', stage: 1 as Stage, credits: 0, status: 'idle' as const };
  const blocked = s.logs.filter((l) => l.verdict === 'blocked').slice(-4).reverse();
  const pct = s.cls.budget ? Math.min(100, (s.spent / s.cls.budget) * 100) : 0;
  const sel = roster.find((r) => r.no === s.selectedStudent) ?? me;
  const logs = s.logs.filter((l) => l.who === sel.no);

  return (
    <div className="teacher">
      <header className="t-head">
        <div>
          <h1 className="t-title">{s.cls.title} · {s.band === 'elementary' ? '초등' : '중등'}</h1>
          <div className="muted">
            반 코드 <span className="mono strong">{s.cls.code}</span> · 학생 {roster.length}명 · 프로젝트 「AI로 달라진 나의 일상」
          </div>
        </div>
        <div className="t-controls">
          <button className="btn" onClick={() => d({ t: 'openClass', classId: '' })}>
            ← 내 반 목록
          </button>
          <button className="btn" onClick={() => (setShowWorks(!showWorks), setShowPins(false))}>
            {showWorks ? '현황판 보기' : '학생 작품 보기'}
          </button>
          <button className="btn" onClick={() => (setShowPins(!showPins), setShowWorks(false))}>
            {showPins ? '현황판 보기' : '학생 명단·입장 안내'}
          </button>
          <button className="btn" onClick={() => setAskDelete(!askDelete)}>
            반 삭제
          </button>
          <button className={`btn ${s.cls.paused ? 'danger' : ''}`} onClick={() => d({ t: 'cls', patch: { paused: !s.cls.paused } })}>
            {s.cls.paused ? '화면 다시 열기' : '모든 화면 멈추기'}
          </button>
        </div>
      </header>

      {askDelete && <DeleteClass onClose={() => setAskDelete(false)} />}
      {showWorks ? <StudentWorks /> : showPins ? <PinCards /> : <>
      <section className="t-bar">
        <div className="t-block">
          <span className="t-label">열린 단계</span>
          <div className="seg" role="group" aria-label="열린 단계">
            {STAGES.map((st) => (
              <button key={st.n} className={`seg-b ${st.n <= s.cls.open ? 'on' : ''}`} aria-pressed={st.n <= s.cls.open} onClick={() => d({ t: 'cls', patch: { open: st.n as Stage } })}>
                {st.n} {st.name}
              </button>
            ))}
          </div>
        </div>
        <div className="t-block">
          <span className="t-label">생성 방식</span>
          <label className="switch">
            <input type="checkbox" id="t-approval" checked={s.cls.approval} onChange={(e) => d({ t: 'cls', patch: { approval: e.target.checked } })} />
            <span>{s.cls.approval ? '교사 승인 후 생성' : '자동 생성(검사만)'}</span>
          </label>
          {s.band === 'middle' && (
            <label className="switch">
              <input type="checkbox" id="t-video" checked={s.cls.videoInMiddle} onChange={(e) => d({ t: 'cls', patch: { videoInMiddle: e.target.checked } })} />
              <span>영상 생성 {s.cls.videoInMiddle ? '켜짐' : '꺼짐(이미지만)'}</span>
            </label>
          )}
        </div>
        <div className="t-block budget">
          <span className="t-label">오늘 비용</span>
          <div className={`meter ${pct >= 80 ? 'warn' : ''}`}>
            <div className="meter-fill" style={{ width: `${pct}%` }} />
            <span className="mono">
              ${s.spent.toFixed(2)} / ${s.cls.budget}
            </span>
          </div>
          <span className="tiny muted">80%가 되면 알림, 100%면 새 생성이 멈춰요</span>
        </div>
      </section>

      <div className="t-grid">
        <section className="panel roster-panel">
          <div className="panel-head">
            <h3>학생 현황</h3>
            <span className="legend tiny">
              <i className="dot good" /> 완성 <i className="dot warn" /> 승인 대기 <i className="dot ai" /> 만드는 중 <i className="dot critical" /> 차단 알림
            </span>
          </div>
          <div className="roster">
            {roster.map((r) => (
              <button key={r.no} className={`seat ${r.status} ${s.selectedStudent === r.no ? 'on' : ''}`} onClick={() => d({ t: 'set', patch: { selectedStudent: r.no } })}>
                <span className="seat-no mono">{r.no}</span>
                <span className="seat-nick">{r.nick || '(미입장)'}</span>
                <span className="seat-stage">{r.stage}단계</span>
                <span className="seat-cr mono">{r.credits}</span>
              </button>
            ))}
          </div>
          <p className="tiny muted">카드를 누르면 오른쪽에 그 학생의 프롬프트 기록이 보여요.</p>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3>승인 대기 {s.approvals.length}건</h3>
            {!s.cls.approval && <span className="tiny muted">자동 생성 모드</span>}
          </div>
          {s.approvals.length === 0 && <p className="muted">확인할 프롬프트가 없어요.</p>}
          <ul className="approvals">
            {s.approvals.map((a) => (
              <ApprovalItem key={a.id} a={a} />
            ))}
          </ul>
          <h3 className="mt">차단 알림</h3>
          <ul className="alerts">
            {blocked.map((l) => (
              <li key={l.id}>
                <span className="chip critical">{l.category}</span>
                <span>
                  <strong>{l.who}번</strong> “{l.textKo}”
                </span>
                <span className="mono muted">{time(l.at)}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel log-panel">
          <div className="panel-head">
            <h3>
              {sel.no}번 {sel.nick} 프롬프트 기록
            </h3>
            <button className="btn tiny" onClick={() => (copyCsv(s.logs), d({ t: 'toast', msg: '프롬프트 기록을 CSV로 복사했어요. 엑셀에 붙여 넣으면 돼요.' }))}>
              전체 CSV 복사
            </button>
          </div>
          {logs.length === 0 && <p className="muted">아직 기록이 없어요. 기록은 지울 수 없고 계속 쌓여요.</p>}
          <ol className="logline">
            {logs.map((l) => (
              <li key={l.id} className={l.verdict}>
                <span className="mono muted">{time(l.at)}</span>
                <div>
                  <div className="log-kind">
                    {l.kind} · {l.action}
                    {l.category && <span className="chip critical">{l.category}</span>}
                  </div>
                  <div>{l.textKo}</div>
                  {l.textEn && <div className="en tiny">{l.textEn}</div>}
                </div>
              </li>
            ))}
          </ol>
        </section>
      </div>
      </>}
    </div>
  );
}

function ApprovalItem({ a }: { a: { id: string; no: number; nick: string; promptKo: string; promptEn: string } }) {
  const { d } = useStore();
  const [rejecting, setRejecting] = useState(false);
  return (
    <li className="approval">
      <div>
        <strong>
          {a.no}번 {a.nick}
        </strong>
        <p>{a.promptKo}</p>
        <p className="en tiny">{a.promptEn}</p>
      </div>
      {rejecting ? (
        <div className="reject-reasons">
          {REJECT_REASONS.map((r) => (
            <button key={r} className="btn tiny" onClick={() => d({ t: 'reject', id: a.id, reason: r })}>
              {r}
            </button>
          ))}
          <button className="link" onClick={() => setRejecting(false)}>
            취소
          </button>
        </div>
      ) : (
        <div className="approval-act">
          <button className="btn primary tiny" onClick={() => d({ t: 'approve', id: a.id })}>
            승인
          </button>
          <button className="btn tiny" onClick={() => setRejecting(true)}>
            돌려보내기
          </button>
        </div>
      )}
    </li>
  );
}

const time = (t: number) => new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });

function copyCsv(logs: Log[]) {
  const esc = (v: string) => `"${(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['시각', '번호', '종류', '프롬프트', '번역', '검사', '분류', '처리'], ...logs.map((l) => [new Date(l.at).toISOString(), String(l.who), l.kind, l.textKo, l.textEn ?? '', l.verdict, l.category ?? '', l.action])];
  const csv = rows.map((r) => r.map(esc).join(',')).join('\n');
  navigator.clipboard?.writeText(csv).catch(() => {});
}
