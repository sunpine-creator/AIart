import React, { useState } from 'react';
import { GoogleAuthProvider, signInWithPopup } from 'firebase/auth';
import { Log, Stage, useStore } from '../store';
import { STAGES } from './Student';
import { api, auth, errText } from '../firebase';

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
  return (
    <div className="join">
      <div className="join-card">
        <h1 className="join-title">승인을 기다리고 있어요</h1>
        <p>
          유료 AI를 쓰는 서비스라 운영자가 교사 계정을 승인해야 해요. 아래 정보를 운영자에게 보내 주세요.
        </p>
        <p className="mono">{s.teacherEmail}</p>
        <p className="mono tiny">UID: {auth.currentUser?.uid}</p>
        <button className="btn" onClick={() => location.reload()}>승인됐는지 다시 확인</button>
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
  const create = async () => {
    setBusy(true);
    try {
      const r = await api.createClass({ title, band, size });
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
        <h1 className="t-title">내 반</h1>
        <span className="muted">{s.teacherEmail} · <button className="link" onClick={() => d({ t: 'signOut' })}>로그아웃</button></span>
      </header>
      <div className="class-grid">
        {s.classes.map((c) => (
          <button key={c.id} className="class-card" onClick={() => d({ t: 'openClass', classId: c.id })}>
            <strong>{c.title}</strong>
            <span className="muted">{c.band === 'elementary' ? '초등' : '중등'} · {c.size}명 · 열린 단계 {c.open}</span>
            <span className="mono">{c.code}</span>
          </button>
        ))}
        {s.classes.length === 0 && <p className="muted">아직 만든 반이 없어요. 아래에서 첫 반을 만들어 보세요.</p>}
      </div>
      <section className="panel">
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
    </div>
  );
}

function PinCards() {
  const { s, d } = useStore();
  const link = `${location.origin}/?code=${s.cls.code}`;
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>학생 입장 카드</h3>
        <span className="tiny muted">카드를 잘라 나눠 주세요. 학생 주소: <span className="mono">{link}</span></span>
      </div>
      <div className="pin-grid">
        {s.others.map((r) => (
          <div className="pin-card" key={r.no}>
            <span className="tiny muted">반 코드</span>
            <span className="mono strong">{s.cls.code}</span>
            <span className="tiny muted">번호 · 비밀 숫자</span>
            <span className="mono strong">{r.no}번 · {s.pins[r.no] ?? '----'}</span>
            <button
              className="link tiny"
              onClick={() => api.resetPin({ classId: s.classId, no: r.no }).then(() => d({ t: 'toast', msg: `${r.no}번 비밀 숫자를 새로 만들었어요.` }), (e) => d({ t: 'toast', msg: errText(e) }))}
            >
              새로 만들기
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function Dashboard() {
  const { s, d } = useStore();
  const [showPins, setShowPins] = useState(false);
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
          <button className="btn" onClick={() => setShowPins(!showPins)}>
            {showPins ? '현황판 보기' : '학생 입장 카드'}
          </button>
          <button className={`btn ${s.cls.paused ? 'danger' : ''}`} onClick={() => d({ t: 'cls', patch: { paused: !s.cls.paused } })}>
            {s.cls.paused ? '화면 다시 열기' : '모든 화면 멈추기'}
          </button>
        </div>
      </header>

      {showPins ? <PinCards /> : <>
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
                <span className="seat-nick">{r.nick}</span>
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
