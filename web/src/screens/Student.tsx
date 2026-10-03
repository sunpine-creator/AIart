import React, { useEffect, useMemo, useState } from 'react';
import { CLASS_SIZE, CREDIT_PER_SEC, DRAFT, FINAL, MAX_EDITS, Fit, Gen, Scene, Stage, Upload, maxSec, mediaWord, nickOf, useStore } from '../store';
import { buildPromptKo, moderate } from '../moderation';
import { GenMedia, MediaFrame, StoredVideo, useStorageUrl } from '../MediaFrame';
import { api, errText, storage } from '../firebase';
import { getDownloadURL, ref as sref } from 'firebase/storage';

export const STAGES: { n: Stage; name: string; el: number; mid: number }[] = [
  { n: 1, name: '시작하기', el: 20, mid: 20 },
  { n: 2, name: '활동지', el: 15, mid: 10 },
  { n: 3, name: 'AI로 만들기', el: 55, mid: 60 },
  { n: 4, name: '이야기 만들기', el: 20, mid: 25 },
  { n: 5, name: '영상 편집', el: 90, mid: 80 },
  { n: 6, name: '검토하고 나누기', el: 20, mid: 25 },
];

const tc = (sec: number) => `00:${String(Math.max(0, Math.round(sec))).padStart(2, '0')}`;

export function StudentApp() {
  const { s, d } = useStore();
  if (!s.joined) return <Join />;
  // 함수 이름과 단계 번호가 다르다: 2 활동지(Sheet) · 3 AI로 만들기(S3) · 4 이야기(S2) · 5 편집(S4) · 6 검토(S5)
  const Screen = [S1, Sheet, S3, S2, S4, S5][s.tab - 1];
  return (
    <div className="student">
      <header className="st-head">
        <div className="st-who">
          <span className="avatar" aria-hidden="true">{s.me.no}</span>
          <div>
            <div className="st-nick">{s.me.no}번 {s.me.nick}</div>
            <div className="st-class">{s.cls.title} · 반 코드 <span className="mono">{s.cls.code}</span> · {s.band === 'elementary' ? '30초 영상' : '60초 영상'}</div>
          </div>
        </div>
        <div className="credit" title="생성할 때마다 길이만큼 줄어들어요">
          <span className="credit-label">남은 크레딧</span>
          <span className="credit-num">{s.credits}</span>
        </div>
      </header>
      <nav className="stepper" aria-label="수업 단계">
        {STAGES.map((st) => {
          const locked = st.n > s.cls.open;
          return (
            <button
              key={st.n}
              id={`step-${st.n}`}
              className={`step ${s.tab === st.n ? 'on' : ''} ${locked ? 'locked' : ''}`}
              aria-current={s.tab === st.n ? 'step' : undefined}
              disabled={locked}
              onClick={() => d({ t: 'set', patch: { tab: st.n } })}
            >
              <span className="step-n">{st.n}</span>
              <span className="step-name">{st.name}</span>
              <span className="step-min">{locked ? '선생님이 열어 줄 거예요' : `${s.band === 'elementary' ? st.el : st.mid}분`}</span>
            </button>
          );
        })}
      </nav>
      <main className="st-main">
        <Screen />
      </main>
      {s.cls.paused && (
        <div className="pause" role="alertdialog" aria-label="잠시 멈춤">
          <div className="pause-card">
            <div className="pause-big">선생님을 봐 주세요</div>
            <p>선생님이 화면을 잠시 멈췄어요. 만들던 작업은 그대로 저장돼 있어요.</p>
          </div>
        </div>
      )}
    </div>
  );
}

function Join() {
  const { s, d } = useStore();
  const [code, setCode] = useState(() => new URLSearchParams(location.search).get('code')?.toUpperCase() ?? '');
  const [no, setNo] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (s.toast) setBusy(false);
  }, [s.toast]);
  const ok = code.length === 6 && Number(no) >= 1 && Number(no) <= 40 && pin.length === 4;
  return (
    <div className="join">
      <div className="join-card">
        <div className="clap" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </div>
        <h1 className="join-title">오늘의 촬영장에 들어가기</h1>
        <p className="muted">이름은 쓰지 않아요. 선생님이 준 카드의 반 코드, 번호, 비밀 숫자만 넣어요.</p>
        <form
          className="join-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!ok) return;
            setBusy(true);
            d({ t: 'join', code, no: Number(no), pin });
          }}
        >
          <label htmlFor="j-code">반 코드</label>
          <input id="j-code" className="mono big" value={code} maxLength={6} onChange={(e) => setCode(e.target.value.toUpperCase())} />
          <div className="row2">
            <div>
              <label htmlFor="j-no">번호</label>
              <input id="j-no" className="mono big" inputMode="numeric" value={no} onChange={(e) => setNo(e.target.value.replace(/\D/g, ''))} />
            </div>
            <div>
              <label htmlFor="j-pin">비밀 숫자</label>
              <input id="j-pin" className="mono big" inputMode="numeric" type="password" maxLength={4} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
            </div>
          </div>
          <button className="btn primary wide" disabled={!ok || busy}>
            {busy ? '들어가는 중…' : '들어가기'}
          </button>
        </form>
        <p className="tiny muted">
          선생님이신가요? <a href="/teacher">교사 화면으로 가기</a>
        </p>
      </div>
    </div>
  );
}

// ───────────── S1 시작하기 ─────────────
const CARDS: { id: string; text: string; best: 'ai' | 'human'; why: string }[] = [
  { id: 'c1', text: '오늘 날씨 알려 주기', best: 'ai', why: '정해진 정보를 빨리 찾는 일은 AI가 잘해요.' },
  { id: 'c2', text: '영상에 어떤 이야기를 담을지 정하기', best: 'human', why: '내 경험과 생각은 나만 알아요.' },
  { id: 'c3', text: '외국어 간판 번역하기', best: 'ai', why: '번역은 AI가 잘 돕지만, 틀릴 수도 있어요.' },
  { id: 'c4', text: 'AI가 만든 그림이 맞는지 판단하기', best: 'human', why: 'AI는 자기 실수를 모를 때가 많아요.' },
  { id: 'c5', text: '그림을 움직이는 영상으로 만들기', best: 'ai', why: '그리는 일은 AI가 도울 수 있어요.' },
  { id: 'c6', text: '친구에게 상처가 될 장면인지 생각하기', best: 'human', why: '다른 사람의 마음을 살피는 일은 사람이 해요.' },
];

function S1() {
  const { s, d } = useStore();
  const placed = CARDS.filter((c) => s.sortCards[c.id]);
  const put = (id: string, v: 'ai' | 'human') => d({ t: 'set', patch: { sortCards: { ...s.sortCards, [id]: v } } });
  return (
    <div className="screen">
      <ScreenHead n={1} title="AI는 무엇을 잘하고, 나는 무엇을 할까?" lead="카드를 하나씩 골라 알맞은 칸에 넣어 보세요. 정답이 하나가 아닐 수도 있어요." />
      <div className="sort">
        <div className="sort-pool">
          {CARDS.filter((c) => !s.sortCards[c.id]).map((c) => (
            <div className="card-chip" key={c.id}>
              <span>{c.text}</span>
              <div className="chip-actions">
                <button className="btn tiny ai" onClick={() => put(c.id, 'ai')}>AI가 잘해요</button>
                <button className="btn tiny human" onClick={() => put(c.id, 'human')}>내가 해요</button>
              </div>
            </div>
          ))}
          {placed.length === CARDS.length && <p className="muted">모두 골랐어요. 선생님과 함께 이유를 이야기해 봐요.</p>}
        </div>
        {(['ai', 'human'] as const).map((col) => (
          <div key={col} className={`sort-col ${col}`}>
            <h3>{col === 'ai' ? 'AI가 잘하는 일' : '사람이 판단할 일'}</h3>
            {CARDS.filter((c) => s.sortCards[c.id] === col).map((c) => (
              <div key={c.id} className="sorted">
                <span>{c.text}</span>
                {c.best !== col && <span className="hint">다시 생각해 볼까요? {c.why}</span>}
                <button className="link" onClick={() => d({ t: 'set', patch: { sortCards: { ...s.sortCards, [c.id]: undefined } } })}>
                  빼기
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>
      <NextBar to={2} />
    </div>
  );
}

// ───────────── 2단계 활동지 ─────────────
function Sheet() {
  const { s, d } = useStore();
  const st = s.story;
  const set = (k: keyof typeof st) => (v: string) => d({ t: 'set', patch: { story: { ...st, [k]: v } } });
  const limit = maxSec(s.band);
  return (
    <div className="screen">
      <ScreenHead n={2} title="활동지로 내 하루를 정리해요" lead="AI로 만들기 전에 무엇을 만들지 내가 먼저 정해요. 이 단계에서는 AI를 쓰지 않아요." human />
      <section className="panel sheet">
        <div className="panel-head">
          <h3>활동지</h3>
          <span className="tiny muted">큰 주제: AI로 달라진 나의 일상 · 영상 {limit}초 이내</span>
        </div>
        <div className="field">
          <label htmlFor="topic" className="label-human">
            내가 정한 주제
          </label>
          <input
            id="topic"
            maxLength={40}
            placeholder="예: AI 스피커 덕분에 우산을 챙긴 날"
            value={s.topic}
            onChange={(e) => d({ t: 'set', patch: { topic: e.target.value } })}
          />
          <span className="tiny muted count mono">{s.topic.length}/40</span>
          <p className="tiny muted">이런 순간을 떠올려 봐요: 아침에 일어날 때, 학교 가는 길, 숙제할 때, 가족과 저녁 먹을 때, 친구와 놀 때</p>
        </div>
        {s.band === 'middle' && (
          <div className="grid3">
            <Field id="b-aud" label="누구에게 (대상)" value={s.brief.audience} onChange={(v) => d({ t: 'set', patch: { brief: { ...s.brief, audience: v } } })} />
            <Field id="b-pur" label="왜 (목적)" value={s.brief.purpose} onChange={(v) => d({ t: 'set', patch: { brief: { ...s.brief, purpose: v } } })} />
            <Field id="b-msg" label="무엇을 전할까 (핵심 메시지)" value={s.brief.message} onChange={(v) => d({ t: 'set', patch: { brief: { ...s.brief, message: v } } })} />
          </div>
        )}
        <div className="grid5">
          <Field id="st-who" label="누가" value={st.who} onChange={set('who')} />
          <Field id="st-where" label="어디서" value={st.where} onChange={set('where')} />
          <Field id="st-what" label="무엇을(어떤 AI)" value={st.what} onChange={set('what')} />
          <Field id="st-event" label="어떤 일이" value={st.event} onChange={set('event')} wide />
          <FeelingPicker value={st.feeling} onChange={set('feeling')} />
        </div>
      </section>
      <p className="tiny muted">활동지에 쓴 “누가”와 “어디서”는 다음 단계에서 새 장면을 만들 때 자동으로 채워져요.</p>
      <NextBar to={3} />
    </div>
  );
}

// 활동지 요약. AI로 만들기·이야기 단계 위에 띄워 둔다.
function SheetSummary() {
  const { s, d } = useStore();
  const st = s.story;
  return (
    <div className="sheet-sum">
      <span className="tag human">내 활동지</span>
      <span>
        <strong>{s.topic || '주제를 아직 안 정했어요'}</strong>
      </span>
      <span className="muted">
        {[st.who, st.where, st.what].filter(Boolean).join(' · ')}
        {st.feeling ? ` · 기분: ${st.feeling}` : ''}
      </span>
      <button className="link" onClick={() => d({ t: 'set', patch: { tab: 2 } })}>
        고치기
      </button>
    </div>
  );
}

// ───────────── 4단계 이야기 만들기 (함수 이름 S2) ─────────────
function S2() {
  const { s } = useStore();
  return s.band === 'elementary' ? <S2Elementary /> : <S2Middle />;
}

function S2Elementary() {
  return (
    <div className="screen">
      <ScreenHead n={4} title="AI로 만든 장면을 이야기로 엮어요" lead="활동지에 정리한 내 경험에 맞게 장면 순서와 이야기를 정해요. 이 단계에서는 AI를 쓰지 않아요." human />
      <SheetSummary />
      <Storyboard max={5} />
      <NextBar to={5} />
    </div>
  );
}

const FEELINGS: { group: string; items: string[] }[] = [
  { group: '좋은 기분', items: ['기쁨', '신남', '뿌듯함', '든든함', '고마움', '편안함', '설렘', '신기함'] },
  { group: '놀란 기분', items: ['놀람', '궁금함', '어리둥절함'] },
  { group: '아쉬운 기분', items: ['아쉬움', '걱정됨', '답답함', '속상함', '무서움', '미안함'] },
];
const ALL_FEELINGS = FEELINGS.flatMap((g) => g.items);

function FeelingPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const custom = value && !ALL_FEELINGS.includes(value) ? value : '';
  return (
    <div className="field wide feelings">
      <label>어떤 기분이었나요? 하나를 고르거나 직접 써요</label>
      {FEELINGS.map((g) => (
        <div className="feel-row" key={g.group}>
          <span className="feel-group">{g.group}</span>
          <div className="pills">
            {g.items.map((f) => (
              <button key={f} className={`pill ${value === f ? 'on' : ''}`} aria-pressed={value === f} onClick={() => onChange(f)}>
                {f}
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className="feel-row">
        <label htmlFor="feel-custom" className="feel-group">
          직접 쓰기
        </label>
        <input
          id="feel-custom"
          maxLength={20}
          placeholder="예: 비 맞을 뻔해서 조마조마했어"
          value={custom}
          onChange={(e) => onChange(e.target.value)}
          className={custom ? 'on-custom' : ''}
        />
      </div>
    </div>
  );
}

function Storyboard({ max }: { max: number }) {
  const { s, d } = useStore();
  const move = (i: number, dir: -1 | 1) => {
    const arr = [...s.scenes];
    const j = i + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    d({ t: 'set', patch: { scenes: arr } });
  };
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>스토리보드</h3>
        <span className="muted">장면 {s.scenes.length}개 · 최대 {max}개</span>
      </div>
      <ol className="board">
        {s.scenes.map((sc, i) => (
          <li key={sc.id} className="board-card">
            <div className="board-n mono">#{i + 1}</div>
            <BoardThumb sceneId={sc.id} />
            <textarea
              id={`board-${sc.id}`}
              aria-label={`장면 ${i + 1} 이야기`}
              value={sc.line}
              rows={3}
              onChange={(e) => d({ t: 'scene', id: sc.id, patch: { line: e.target.value } })}
            />
            <div className="board-act">
              <button className="btn tiny" onClick={() => move(i, -1)} disabled={i === 0} aria-label="앞으로">◀</button>
              <button className="btn tiny" onClick={() => move(i, 1)} disabled={i === s.scenes.length - 1} aria-label="뒤로">▶</button>
              <button
                className="btn tiny"
                disabled={s.scenes.length <= 2}
                onClick={() => d({ t: 'set', patch: { scenes: s.scenes.filter((x) => x.id !== sc.id) } })}
              >
                지우기
              </button>
            </div>
          </li>
        ))}
        {s.scenes.length < max && (
          <li>
            <button
              className="board-add"
              onClick={() =>
                d({
                  t: 'set',
                  patch: {
                    scenes: [
                      ...s.scenes,
                      { id: `s${Date.now()}`, line: '', builder: { who: '', what: '', where: '', how: '' }, edits: 0, dur: 5, caption: '', voice: '없음' },
                    ],
                  },
                })
              }
            >
              + 장면 추가
            </button>
          </li>
        )}
      </ol>
    </section>
  );
}

function BoardThumb({ sceneId }: { sceneId: string }) {
  const { s } = useStore();
  const sc = s.scenes.find((x) => x.id === sceneId);
  const g = s.gens.find((x) => x.id === sc?.selectedGenId) ?? [...s.gens].reverse().find((x) => x.sceneId === sceneId && x.status === 'succeeded');
  if (!g) return <div className="frame frame-sm empty-frame tiny">AI 장면 없음</div>;
  return <GenMedia g={g} label={sc?.line ?? ''} size="sm" badge="AI" still />;
}


function S2Middle() {
  const { s, d } = useStore();
  const sc = s.scenario;
  const [loading, setLoading] = useState(false);
  const setB = (k: keyof typeof sc.builder) => (v: string) => d({ t: 'set', patch: { scenario: { ...sc, builder: { ...sc.builder, [k]: v } } } });
  const ask = () => {
    setLoading(true);
    api
      .draftScenario({ ...sc.builder, topic: s.topic })
      .then((r) => {
        if (r.blocked) d({ t: 'toast', msg: `안전 검사에서 멈췄어요: ${r.reason}` });
        else d({ t: 'set', patch: { scenario: { ...sc, draft: r.lines, marked: [], final: '' } } });
      })
      .catch((e) => d({ t: 'toast', msg: errText(e) }))
      .finally(() => setLoading(false));
  };
  const toggle = (i: number) => {
    const marked = sc.marked.includes(i) ? sc.marked.filter((x) => x !== i) : [...sc.marked, i];
    d({ t: 'set', patch: { scenario: { ...sc, marked, final: sc.draft.filter((_, j) => !marked.includes(j)).join('\n') } } });
  };
  // 시나리오 문장을 장면 이야기에 차례로 넣는다. 2단계에서 AI로 만든 장면과 기록은 그대로 둔다.
  const toScenes = () => {
    const lines = (sc.final || sc.draft.join('\n')).split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 8);
    const clean = lines.map((l) => l.replace(/^장면 \d+\.\s*/, ''));
    const scenes = clean.map((line, i) =>
      s.scenes[i] ? { ...s.scenes[i], line } : { id: `m${Date.now()}${i}`, line, builder: { who: '나', what: '', where: '', how: '' }, edits: 0, dur: 8, caption: '', voice: '없음' },
    );
    d({ t: 'set', patch: { scenes: [...scenes, ...s.scenes.slice(clean.length)], toast: '시나리오 문장을 장면에 차례로 넣었어요.' } });
  };
  return (
    <div className="screen">
      <ScreenHead n={4} title="시나리오를 설계해요" lead="좋은 프롬프트는 목적·역할·내용·조건이 분명해요. AI 초안은 출발점일 뿐, 고치는 사람은 나예요." />
      <SheetSummary />
      <section className="compare">
        <div className="cmp weak">
          <h4>부족한 프롬프트</h4>
          <p>"번역 앱 영상 시나리오 써 줘"</p>
          <span className="muted">누구에게, 얼마나 길게, 어떤 분위기인지 알 수 없어요.</span>
        </div>
        <div className="cmp good">
          <h4>좋은 프롬프트</h4>
          <p>"너는 중학생 영상 작가야. 번역 앱으로 길을 알려 준 경험을 60초 시나리오로, 장면 5개 이내, 대사는 짧게 써 줘."</p>
          <span className="muted">목적·역할·내용·조건이 모두 들어 있어요.</span>
        </div>
      </section>
      <section className="panel">
        <h3>프롬프트 만들기</h3>
        <div className="grid2">
          <Field id="sc-goal" label="목적" value={sc.builder.goal} onChange={setB('goal')} />
          <Field id="sc-role" label="역할" value={sc.builder.role} onChange={setB('role')} />
          <Field id="sc-content" label="내용" value={sc.builder.content} onChange={setB('content')} />
          <Field id="sc-cond" label="조건" value={sc.builder.cond} onChange={setB('cond')} />
        </div>
        <button className="btn ai" onClick={ask} disabled={loading}>
          {loading ? 'AI가 쓰는 중…' : 'AI에게 시나리오 초안 받기'}
        </button>
      </section>
      {sc.draft.length > 0 && (
        <section className="panel">
          <div className="panel-head">
            <h3>AI 초안에서 필요 없는 문장 찾기</h3>
            <span className="muted">{sc.marked.length}개 표시함</span>
          </div>
          <ul className="draft">
            {sc.draft.map((l, i) => (
              <li key={i}>
                <button className={`draft-line ${sc.marked.includes(i) ? 'cut' : ''}`} aria-pressed={sc.marked.includes(i)} onClick={() => toggle(i)}>
                  <span className="tag ai">AI</span> {l}
                </button>
              </li>
            ))}
          </ul>
          <label htmlFor="sc-final" className="label-human">
            내가 고친 최종 시나리오
          </label>
          <textarea
            id="sc-final"
            rows={6}
            value={sc.final || sc.draft.join('\n')}
            onChange={(e) => d({ t: 'set', patch: { scenario: { ...sc, final: e.target.value } } })}
          />
          <button className="btn primary" onClick={toScenes}>
            장면으로 나누기
          </button>
        </section>
      )}
      <Storyboard max={8} />
      <NextBar to={5} />
    </div>
  );
}

// ───────────── 3단계 AI로 만들기 (함수 이름 S3) ─────────────
function S3() {
  const { s, d } = useStore();
  const [sel, setSel] = useState(s.scenes[0]?.id);
  useEffect(() => {
    if (!s.scenes.find((x) => x.id === sel)) setSel(s.scenes[0]?.id);
  }, [s.scenes, sel]);
  const scene = s.scenes.find((x) => x.id === sel);
  const word = mediaWord(s);
  return (
    <div className="screen">
      <ScreenHead
        n={3}
        title={`장면마다 AI로 ${word === "영상" ? "영상을" : "이미지를"} 만들어요`}
        lead={`활동지를 보며 장면을 AI로 만들어 봐요. 먼저 ${word === '영상' ? '3초짜리 초안' : '초안'}으로 확인하고, 마음에 들면 완성본을 만들어요. 이야기로 엮는 건 다음 단계에서 해요.`}
      />
      <SheetSummary />
      <div className="make">
        <aside className="scene-list" aria-label="장면 목록">
          {s.scenes.map((sc, i) => {
            const done = !!sc.selectedGenId;
            const busy = s.gens.some((g) => g.sceneId === sc.id && ['awaiting_approval', 'queued', 'running'].includes(g.status));
            return (
              <button key={sc.id} className={`scene-tab ${sel === sc.id ? 'on' : ''}`} onClick={() => setSel(sc.id)}>
                <span className="mono">#{i + 1}</span>
                <span className="scene-tab-line">{sc.line || '(이야기 없음)'}</span>
                <span className={`dot ${done ? 'good' : busy ? 'warn' : ''}`} aria-label={done ? '완성' : busy ? '진행 중' : '시작 전'} />
              </button>
            );
          })}
          {s.scenes.length < (s.band === 'elementary' ? 5 : 8) && (
            <button
              className="scene-add"
              onClick={() => {
                const id = `s${Date.now()}`;
                d({ t: 'set', patch: { scenes: [...s.scenes, { id, line: '새 장면', builder: { who: s.story.who, what: '', where: s.story.where, how: '' }, edits: 0, dur: 5, caption: '', voice: '없음' }] } });
                setSel(id);
              }}
            >
              + 장면 추가
            </button>
          )}
        </aside>
        {scene && <SceneWork scene={scene} index={s.scenes.indexOf(scene)} />}
      </div>
      <NextBar to={4} />
    </div>
  );
}

function SceneWork({ scene, index }: { scene: Scene; index: number }) {
  const { s, d } = useStore();
  const word = mediaWord(s);
  const gens = s.gens.filter((g) => g.sceneId === scene.id);
  const latest = gens[gens.length - 1];
  const busy = latest && ['awaiting_approval', 'queued', 'running'].includes(latest.status);
  const b = scene.builder;
  const ko = buildPromptKo(b);
  const lastSent = [...gens].reverse().find((g) => g.promptEn && g.status !== 'blocked');
  const en = lastSent?.promptEn || '보내면 안전 검사를 거쳐 영어로 바뀌어요. 바뀐 문장이 여기에 보여요.';
  const live = moderate(ko);
  const img = s.band === 'middle' && !s.cls.videoInMiddle;
  const draftCost = img ? 1 : CREDIT_PER_SEC[DRAFT.res] * DRAFT.sec;
  const finalCost = img ? 2 : CREDIT_PER_SEC[FINAL.res] * FINAL.sec;
  const lastGood = [...gens].reverse().find((g) => g.status === 'succeeded' && g.kind !== 'final');
  const final = gens.find((g) => g.kind === 'final' && g.status === 'succeeded');
  return (
    <section className="work">
      <div className="work-head">
        <span className="mono muted">장면 #{index + 1}</span>
        <h3>{scene.line}</h3>
      </div>
      <div className="builder">
        <Field id={`b-who-${scene.id}`} label="누가" value={b.who} onChange={(v) => d({ t: 'builder', id: scene.id, patch: { who: v } })} human />
        <Field id={`b-what-${scene.id}`} label="무엇을" value={b.what} onChange={(v) => d({ t: 'builder', id: scene.id, patch: { what: v } })} human />
        <Field id={`b-where-${scene.id}`} label="어디서" value={b.where} onChange={(v) => d({ t: 'builder', id: scene.id, patch: { where: v } })} human />
        <Field id={`b-how-${scene.id}`} label="어떤 모습으로" value={b.how} onChange={(v) => d({ t: 'builder', id: scene.id, patch: { how: v } })} human />
      </div>
      <div className="prompt-pair">
        <div className="pp human">
          <span className="tag human">내가 쓴 말</span>
          <p>{ko || '빈칸을 채우면 여기에 문장이 만들어져요.'}</p>
        </div>
        <div className="pp ai">
          <span className="tag ai">AI가 알아들은 말 (마지막으로 보낸 것)</span>
          <p className="en">{en}</p>
        </div>
      </div>
      {!live.pass && ko && (
        <div className="notice warn" role="status">
          <strong>보내기 전에 한 번 더 생각해요 · {live.category}</strong>
          <span>{live.reason}</span>
        </div>
      )}
      {!final && (
        <div className="actions">
          <button
            className="btn primary"
            disabled={!ko || busy || s.cls.paused}
            onClick={() => d({ t: 'request', sceneId: scene.id, kind: 'draft' })}
          >
            {word} 초안 만들기
          </button>
          <span className="cost mono">{img ? '이미지 1장' : `${DRAFT.res} · ${DRAFT.sec}초`} · {draftCost}크레딧</span>
        </div>
      )}

      <ol className="history" aria-label="이 장면의 생성 기록">
        {[...gens].reverse().map((g) => (
          <GenCard key={g.id} g={g} scene={scene} isLatestGood={g.id === lastGood?.id && !final} finalCost={finalCost} />
        ))}
      </ol>
    </section>
  );
}

function GenCard({ g, scene, isLatestGood, finalCost }: { g: Gen; scene: Scene; isLatestGood: boolean; finalCost: number }) {
  const { s, d } = useStore();
  const [edit, setEdit] = useState('');
  const [fit, setFit] = useState<Fit | undefined>(g.judgement?.fit);
  const [reason, setReason] = useState(g.judgement?.reason ?? '');
  const word = g.img ? '이미지' : '영상';
  const label = g.kind === 'final' ? '완성본' : g.kind === 'edit' ? '수정본' : '초안';
  const time = new Date(g.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  if (g.status === 'blocked') {
    const [why, tip] = (g.rejectReason ?? '|').split('|');
    return (
      <li className="gen blocked">
        <div className="gen-top">
          <span className="chip critical">안전 검사에서 멈춤</span>
          <span className="mono muted">{time}</span>
        </div>
        <p className="gen-prompt">“{g.editText ?? g.promptKo}”</p>
        <p>
          <strong>왜 멈췄나요?</strong> {why}
        </p>
        <p>
          <strong>이렇게 바꿔 볼까요?</strong> {tip}
        </p>
        <p className="tiny muted">크레딧은 줄지 않았어요. 선생님 화면에도 알림이 갔어요.</p>
      </li>
    );
  }
  if (g.status === 'rejected')
    return (
      <li className="gen">
        <div className="gen-top">
          <span className="chip warn">선생님이 돌려보냄</span>
          <span className="mono muted">{time}</span>
        </div>
        <p>
          <strong>선생님 의견:</strong> {g.rejectReason}
        </p>
        <p className="tiny muted">크레딧을 돌려받았어요. 프롬프트를 고쳐서 다시 만들어 보세요.</p>
      </li>
    );
  if (g.status !== 'succeeded')
    return (
      <li className="gen pending">
        <div className="gen-top">
          <span className="chip">{label}</span>
          <span className="mono muted">{time}</span>
        </div>
        {g.status === 'awaiting_approval' && <Progress text="선생님이 프롬프트를 확인하고 있어요" />}
        {g.status === 'queued' && <Progress text="대기열에서 차례를 기다려요 · 반 친구들 작업과 차례로 만들어요" />}
        {g.status === 'running' && <Progress text={`AI가 ${word === "영상" ? "영상을" : "이미지를"} 만드는 중이에요 · 1~3분쯤 걸려요`} running />}
      </li>
    );
  const judged = !!g.judgement;
  return (
    <li className={`gen done ${g.kind === 'final' ? 'final' : ''}`}>
      <div className="gen-top">
        <span className={`chip ${g.kind === 'final' ? 'good' : 'ai'}`}>{label}</span>
        <span className="mono muted">
          {g.img ? '이미지' : `${g.res} · ${g.sec}초`} · {time}
        </span>
      </div>
      <div className="gen-body">
        <GenMedia g={g} label={scene.line} badge={`AI 생성 · ${g.img ? '이미지' : g.res}`} size="md" controls />
        <div className="gen-side">
          {g.editText && (
            <p className="gen-prompt">
              <span className="tag human">수정 지시</span> {g.editText}
            </p>
          )}
          {g.kind === 'final' ? (
            <p className="good-text">이 장면이 완성됐어요. 편집 단계에서 사용할 수 있어요.</p>
          ) : (
            <>
              <fieldset className="judge" disabled={judged && !isLatestGood}>
                <legend>내 의도와 맞나요? (꼭 골라야 다음으로 갈 수 있어요)</legend>
                <div className="pills">
                  {(
                    [
                      ['yes', '맞아요'],
                      ['partial', '조금 맞아요'],
                      ['no', '아니에요'],
                    ] as [Fit, string][]
                  ).map(([v, t]) => (
                    <button type="button" key={v} className={`pill ${fit === v ? 'on' : ''}`} aria-pressed={fit === v} onClick={() => setFit(v)}>
                      {t}
                    </button>
                  ))}
                </div>
                <input
                  id={`reason-${g.id}`}
                  aria-label="그렇게 생각한 이유"
                  placeholder="그렇게 생각한 이유를 한 줄로 써요"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
                {s.band === 'middle' && <p className="tiny muted">생각해 보기: 이 장면 속 인물은 한 가지 모습만 보여 주나요?</p>}
                <button
                  type="button"
                  className="btn"
                  disabled={!fit || reason.trim().length < 2}
                  onClick={() => d({ t: 'judge', genId: g.id, judgement: { fit: fit!, reason } })}
                >
                  판단 저장
                </button>
              </fieldset>
              {isLatestGood && judged && (
                <div className="next-choice">
                  {g.judgement!.fit !== 'yes' && (
                    <div className="edit-row">
                      <input
                        id={`edit-${g.id}`}
                        aria-label="고치고 싶은 점"
                        placeholder="예: 우산 색을 노란색으로 바꿔 줘"
                        value={edit}
                        onChange={(e) => setEdit(e.target.value)}
                        disabled={scene.edits >= MAX_EDITS}
                      />
                      <button
                        className="btn ai"
                        disabled={!edit.trim() || scene.edits >= MAX_EDITS || s.cls.paused}
                        onClick={() => {
                          d({ t: 'request', sceneId: scene.id, kind: 'edit', editText: edit.trim(), parentId: g.id });
                          setEdit('');
                        }}
                      >
                        고쳐서 다시 만들기 ({MAX_EDITS - scene.edits}번 남음)
                      </button>
                    </div>
                  )}
                  {g.judgement!.fit !== 'no' && (
                    <div className="actions">
                      <button className="btn primary" disabled={s.cls.paused} onClick={() => d({ t: 'request', sceneId: scene.id, kind: 'final', parentId: g.id })}>
                        이 장면으로 정하고 완성본 만들기
                      </button>
                      <span className="cost mono">{g.img ? '이미지 고화질' : `${FINAL.res} · ${FINAL.sec}초`} · {finalCost}크레딧</span>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </li>
  );
}

function Progress({ text, running }: { text: string; running?: boolean }) {
  return (
    <div className="progress" role="status">
      <span className={`spinner ${running ? 'run' : ''}`} aria-hidden="true" />
      <span>{text}</span>
    </div>
  );
}

// ───────────── 5단계 영상 편집 (함수 이름 S4) ─────────────
const VOICES = ['없음', '내 목소리', 'AI 목소리 · 맑은', 'AI 목소리 · 차분한', 'AI 목소리 · 씩씩한'];
const BGMS = ['없음', '산뜻한 아침', '통통 튀는 하루', '잔잔한 저녁'];
const MAX_UPLOAD_MB = 100;

type Item = {
  key: string;
  kind: 'intro' | 'scene' | 'upload' | 'outro';
  scene?: Scene;
  upload?: Upload;
  dur: number;
  caption: string;
  voice?: string;
  hue: number;
  gen?: Gen;
  still?: boolean;
};

function S4() {
  const { s, d } = useStore();
  const [sel, setSel] = useState('intro');
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);

  // 타임라인 가운데 클립 순서: 저장된 순서 + 새로 생긴 장면·업로드는 뒤에 붙인다
  const middleKeys = useMemo(() => {
    const all = [...s.scenes.map((x) => x.id), ...s.uploads.map((u) => u.id)];
    const kept = s.order.filter((k) => all.includes(k));
    return [...kept, ...all.filter((k) => !kept.includes(k))];
  }, [s.order, s.scenes, s.uploads]);

  const items: Item[] = useMemo(() => {
    const mid = middleKeys.map((k): Item => {
      const sc = s.scenes.find((x) => x.id === k);
      if (sc) {
        const gen = s.gens.find((g) => g.id === sc.selectedGenId) ?? [...s.gens].reverse().find((g) => g.sceneId === sc.id && g.status === 'succeeded');
        return { key: sc.id, kind: 'scene', scene: sc, dur: sc.dur, caption: sc.caption, voice: sc.voice, hue: gen?.hue ?? 0, gen, still: gen?.img };
      }
      const u = s.uploads.find((x) => x.id === k)!;
      return { key: u.id, kind: 'upload', upload: u, dur: u.dur, caption: u.caption, voice: u.voice, hue: 0 };
    });
    return [
      { key: 'intro', kind: 'intro', dur: s.intro.dur, caption: s.intro.caption, hue: 210, still: true },
      ...mid,
      { key: 'outro', kind: 'outro', dur: s.outro.dur, caption: s.outro.caption, hue: 30, still: true },
    ];
  }, [middleKeys, s.intro, s.outro, s.scenes, s.uploads, s.gens]);

  const total = items.reduce((a, b) => a + b.dur, 0);
  const limit = maxSec(s.band);
  const over = total > limit;
  const missing = items.filter((i) => i.kind === 'scene' && !i.scene!.selectedGenId).length;
  const cur = items.find((i) => i.key === sel) ?? items[0];
  const curIdx = middleKeys.indexOf(cur.key);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setT((x) => (x + 0.25 >= total ? (setPlaying(false), 0) : x + 0.25)), 250);
    return () => clearInterval(id);
  }, [playing, total]);
  let acc = 0;
  const atItem =
    items.find((i) => {
      acc += i.dur;
      return t < acc;
    }) ?? items[0];
  const show = playing ? atItem : cur;

  const setItem = (patch: { dur?: number; caption?: string; voice?: string }) => {
    if (cur.kind === 'intro') d({ t: 'set', patch: { intro: { ...s.intro, ...patch } } });
    else if (cur.kind === 'outro') d({ t: 'set', patch: { outro: { ...s.outro, ...patch } } });
    else if (cur.kind === 'upload') d({ t: 'set', patch: { uploads: s.uploads.map((u) => (u.id === cur.key ? { ...u, ...patch } : u)) } });
    else d({ t: 'scene', id: cur.key, patch });
  };
  const maxDur =
    cur.kind === 'scene' ? (s.band === 'elementary' ? 5 : 10) : cur.kind === 'upload' ? Math.max(1, Math.min(Math.floor(cur.upload!.srcDur) || 1, limit)) : 5;

  const moveTo = (key: string, target: number) => {
    const arr = middleKeys.filter((k) => k !== key);
    const i = Math.max(0, Math.min(arr.length, target));
    arr.splice(i, 0, key);
    d({ t: 'set', patch: { order: arr } });
  };
  const nudge = (dir: -1 | 1) => curIdx >= 0 && moveTo(cur.key, curIdx + dir);
  const removeUpload = (id: string) => {
    d({ t: 'removeUpload', id });
    setSel('intro');
  };
  const sceneNo = (sc: Scene) => s.scenes.indexOf(sc) + 1;
  const clipLabel = (it: Item) =>
    it.kind === 'intro' ? '제목' : it.kind === 'outro' ? '끝' : it.kind === 'upload' ? '내 영상' : `장면 #${sceneNo(it.scene!)}`;

  return (
    <div className="screen">
      <ScreenHead n={5} title="장면을 이어 붙여 영상으로 만들어요" lead="화려한 효과보다 이야기 순서와 내용이 잘 전해지는지가 중요해요. 내가 찍은 영상도 넣을 수 있어요." />
      <div className="editor">
        <div className="viewer">
          {show.kind === 'upload' ? (
            <div className="frame frame-lg video-frame">
              {show.upload!.playable ? (
                <video key={show.key + (playing ? '-p' : '')} src={show.upload!.url} muted playsInline autoPlay={playing} controls={!playing} />
              ) : (
                <span className="no-preview">이 브라우저에서는 미리 볼 수 없는 형식이에요. 저장할 때 자동으로 바꿔서 넣어요.</span>
              )}
              <span className="frame-badge human-badge">내가 올린 영상</span>
              {show.caption && <span className="frame-caption">{show.caption}</span>}
            </div>
          ) : show.kind === 'scene' && show.gen ? (
            <GenMedia g={show.gen} label={show.scene!.line} caption={show.caption} badge="AI 생성" size="lg" autoPlay={playing} controls={!playing} />
          ) : show.kind === 'scene' ? (
            <div className="frame frame-lg empty-frame">
              <span>아직 만든 장면이 없어요</span>
              {show.caption && <span className="frame-caption">{show.caption}</span>}
            </div>
          ) : (
            <div className={`frame frame-lg title-card ${show.kind}`}>
              <span className="title-card-text">{show.caption}</span>
              {show.kind === 'outro' && <span className="title-card-sub">이 영상에는 AI 생성 콘텐츠가 포함되어 있어요</span>}
            </div>
          )}
          <div className="transport">
            <button className="btn" onClick={() => (setPlaying(!playing), playing ? null : setT(0))}>
              {playing ? '멈추기' : '처음부터 재생'}
            </button>
            <span className="mono">
              {tc(playing ? t : 0)} / {tc(total)}
            </span>
            <span className="muted">배경음악: {s.bgm}</span>
          </div>
        </div>
        <div className="inspector">
          <div className="ins-head">
            <h3>{cur.kind === 'intro' ? '제목 화면' : cur.kind === 'outro' ? '마무리 화면' : cur.kind === 'upload' ? '내가 올린 영상' : `장면 #${sceneNo(cur.scene!)}`}</h3>
            {curIdx >= 0 && (
              <div className="order-btns">
                <button className="btn tiny" onClick={() => nudge(-1)} disabled={curIdx === 0} aria-label="앞으로 옮기기">
                  ◀ 앞으로
                </button>
                <button className="btn tiny" onClick={() => nudge(1)} disabled={curIdx === middleKeys.length - 1} aria-label="뒤로 옮기기">
                  뒤로 ▶
                </button>
              </div>
            )}
          </div>
          {cur.kind === 'upload' && <p className="tiny muted file-name">{cur.upload!.name} · 원본 {Math.round(cur.upload!.srcDur)}초</p>}
          <label htmlFor="ins-dur">
            길이 <span className="mono">{cur.dur}초</span>
          </label>
          <input id="ins-dur" type="range" min={1} max={maxDur} step={1} value={Math.min(cur.dur, maxDur)} onChange={(e) => setItem({ dur: Number(e.target.value) })} />
          <label htmlFor="ins-cap">{cur.kind === 'intro' || cur.kind === 'outro' ? '화면 글자' : '자막·말풍선'}</label>
          <input id="ins-cap" value={cur.caption} onChange={(e) => setItem({ caption: e.target.value })} />
          {(cur.kind === 'scene' || cur.kind === 'upload') && (
            <>
              <label htmlFor="ins-voice">목소리</label>
              <select id="ins-voice" value={cur.voice} onChange={(e) => setItem({ voice: e.target.value })}>
                {(cur.kind === 'upload' ? ['원래 소리', ...VOICES] : VOICES).map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
              {cur.voice === '내 목소리' && <VoiceRecorder key={cur.key} itemKey={cur.key} maxSec={cur.dur} path={cur.scene?.voicePath ?? cur.upload?.voicePath} />}
              <p className="tiny muted">AI 목소리는 정해진 목소리만 쓸 수 있어요. 내 목소리를 AI로 흉내 내지 않아요.</p>
            </>
          )}
          {cur.kind === 'upload' && (
            <button className="btn tiny" onClick={() => removeUpload(cur.key)}>
              이 영상 빼기
            </button>
          )}
          <label htmlFor="ins-bgm">배경음악 (무료 라이선스 목록)</label>
          <select id="ins-bgm" value={s.bgm} onChange={(e) => d({ t: 'set', patch: { bgm: e.target.value } })}>
            {BGMS.map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
          <BgmPreview name={s.bgm} timelinePlaying={playing} />
        </div>
      </div>
      <div className="timeline-wrap">
        <div className={`meter ${over ? 'over' : ''}`}>
          <div className="meter-fill" style={{ width: `${Math.min(100, (total / limit) * 100)}%` }} />
          <span className="mono">
            {total}초 / {limit}초
          </span>
        </div>
        <p className="tiny muted">클립을 끌어서 순서를 바꿀 수 있어요. 태블릿에서는 클립을 고른 뒤 “◀ 앞으로 / 뒤로 ▶”를 눌러요. 제목과 끝 화면은 움직이지 않아요.</p>
        <div className="timeline" role="list" aria-label="타임라인">
          {items.map((it) => {
            const movable = it.kind === 'scene' || it.kind === 'upload';
            return (
              <button
                key={it.key}
                role="listitem"
                draggable={movable}
                onDragStart={(e) => {
                  if (!movable) return;
                  setDragKey(it.key);
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', it.key);
                }}
                onDragOver={(e) => {
                  if (!dragKey || !movable) return;
                  e.preventDefault();
                  setOverKey(it.key);
                }}
                onDragLeave={() => setOverKey((k) => (k === it.key ? null : k))}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragKey && movable && dragKey !== it.key) moveTo(dragKey, middleKeys.filter((k) => k !== dragKey).indexOf(it.key) + (middleKeys.indexOf(dragKey) < middleKeys.indexOf(it.key) ? 1 : 0));
                  setDragKey(null);
                  setOverKey(null);
                }}
                onDragEnd={() => (setDragKey(null), setOverKey(null))}
                className={`clip ${it.kind} ${sel === it.key ? 'on' : ''} ${it.kind === 'scene' && !it.gen ? 'missing' : ''} ${dragKey === it.key ? 'dragging' : ''} ${overKey === it.key && dragKey !== it.key ? 'drop-target' : ''}`}
                style={{ flexGrow: it.dur, ['--h' as any]: it.hue }}
                onClick={() => (setSel(it.key), setPlaying(false))}
              >
                <span className="clip-n mono">{clipLabel(it)}</span>
                <span className="clip-d mono">{it.dur}s</span>
              </button>
            );
          })}
        </div>
        <UploadBox
          onAdd={(u, file) => {
            d({ t: 'set', patch: { order: [...middleKeys, u.id] } });
            d({ t: 'upload', file, meta: u });
            d({ t: 'log', entry: { kind: '영상 업로드', textKo: `${u.name} (${Math.round(u.srcDur)}초)`, action: '타임라인에 추가' } });
            setSel(u.id);
          }}
        />
        {over && <p className="danger-text">영상이 {limit}초를 넘었어요. 길이를 줄이거나 클립을 빼야 저장할 수 있어요.</p>}
        {missing > 0 && <p className="muted">완성본이 없는 장면이 {missing}개 있어요. 3단계에서 완성본을 만들어 주세요.</p>}
        <div className="actions">
          <button className="btn primary" disabled={over || s.rendering} onClick={() => d({ t: 'render' })}>
            {s.rendering ? '영상을 합치는 중… (1분쯤 걸려요)' : s.lastExport ? '다시 저장하기' : '영상 저장하기'}
          </button>
          <span className="tiny muted">장면을 한 편의 MP4로 합쳐요. 끝 화면에 “AI 생성 콘텐츠 포함” 표시가 자동으로 들어가요.</span>
        </div>
        {s.lastExport && (
          <div className="export">
            <div className="panel-head">
              <strong>저장한 완성 영상</strong>
              <span className="tiny muted mono">
                {new Date(s.lastExport.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })} · {s.lastExport.dur}초
              </span>
            </div>
            <StoredVideo path={s.lastExport.path} label="내 완성 영상" />
            <p className="tiny muted">편집을 바꿨다면 “다시 저장하기”를 눌러야 완성 영상에 반영돼요.</p>
          </div>
        )}
      </div>
      <NextBar to={6} />
    </div>
  );
}

// 배경음악 미리 듣기. Storage 의 bgm/{이름}.mp3 를 재생한다.
// "처음부터 재생" 중에는 완성 영상과 같은 크기(18%)로 함께 깔린다.
function BgmPreview({ name, timelinePlaying }: { name: string; timelinePlaying: boolean }) {
  const [url, setUrl] = useState<string | undefined>(undefined);
  const [state, setState] = useState<'none' | 'loading' | 'ready' | 'missing'>('none');
  const [solo, setSolo] = useState(false);
  const [why, setWhy] = useState('');
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    setSolo(false);
    if (!name || name === '없음') return void (setUrl(undefined), setState('none'));
    setState('loading');
    // Mac 에서 올린 한글 파일 이름은 자모가 풀어진(NFD) 형태라 두 형태를 모두 찾는다
    const tryName = (n: string) => getDownloadURL(sref(storage, `bgm/${n}.mp3`));
    tryName(name.normalize('NFC'))
      .catch(() => tryName(name.normalize('NFD')))
      .then(
      (u) => (setUrl(u), setState('ready')),
      (e: any) => (setUrl(undefined), setWhy(`${e?.code ?? e} · 찾은 위치: ${storage.app.options.storageBucket}/bgm/${name}.mp3`), setState('missing')),
    );
  }, [name]);
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const on = solo || timelinePlaying;
    a.volume = timelinePlaying && !solo ? 0.18 : 0.8;
    if (on) {
      if (timelinePlaying) a.currentTime = 0;
      a.play().catch(() => {});
    } else a.pause();
  }, [solo, timelinePlaying, url]);
  if (state === 'none') return null;
  if (state === 'missing')
    return (
      <p className="tiny muted">
        이 음악 파일이 아직 없어요. 선생님이 올리면 들을 수 있어요.
        <br />
        <span className="mono">{why}</span>
      </p>
    );
  return (
    <div className="bgm-preview">
      <audio ref={audioRef} src={url} loop preload="auto" onEnded={() => setSolo(false)} />
      <button className="btn tiny" disabled={state !== 'ready'} onClick={() => setSolo(!solo)}>
        {state === 'loading' ? '불러오는 중…' : solo ? '■ 멈추기' : '▶ 미리 듣기'}
      </button>
      <span className="tiny muted">“처음부터 재생”을 누르면 영상에 깔리는 크기로 함께 들려요.</span>
    </div>
  );
}

// 내 목소리 녹음. 클립 길이만큼만 녹음되고, 다시 녹음할 수 있다.
function VoiceRecorder({ itemKey, maxSec, path }: { itemKey: string; maxSec: number; path?: string }) {
  const { d } = useStore();
  const saved = useStorageUrl(path);
  const [state, setState] = useState<'idle' | 'rec' | 'done'>('idle');
  const [left, setLeft] = useState(maxSec);
  const [local, setLocalUrl] = useState<string | undefined>(undefined);
  const [err, setErr] = useState('');
  const recRef = React.useRef<MediaRecorder | null>(null);
  const start = async () => {
    setErr('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        setLocalUrl(URL.createObjectURL(blob));
        setState('done');
        d({ t: 'voice', key: itemKey, blob });
      };
      recRef.current = rec;
      rec.start();
      setState('rec');
      setLeft(maxSec);
      let n = maxSec;
      const timer = window.setInterval(() => {
        n -= 1;
        setLeft(n);
        if (n <= 0 || rec.state !== 'recording') {
          window.clearInterval(timer);
          if (rec.state === 'recording') rec.stop();
        }
      }, 1000);
    } catch {
      setErr('마이크를 쓸 수 없어요. 브라우저에서 마이크 사용을 허용해 주세요.');
    }
  };
  const src = local ?? saved;
  return (
    <div className="recorder">
      {state === 'rec' ? (
        <button className="btn danger tiny" onClick={() => recRef.current?.stop()}>
          ■ 멈추기 · {left}초 남음
        </button>
      ) : (
        <button className="btn tiny human" onClick={start}>
          ● {src ? '다시 녹음하기' : `녹음하기 (최대 ${maxSec}초)`}
        </button>
      )}
      {src && state !== 'rec' && <audio controls src={src} preload="metadata" />}
      {err && <span className="danger-text tiny">{err}</span>}
    </div>
  );
}

// 내 컴퓨터의 영상 올리기. 올리기 전에 저작권·초상권을 스스로 확인한다.
function UploadBox({ onAdd }: { onAdd: (u: Upload, file: File) => void }) {
  const [own, setOwn] = useState(false);
  const [faces, setFaces] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const ready = own && faces;
  const pick = (file?: File) => {
    setErr('');
    if (!file) return;
    if (!file.type.startsWith('video/')) return setErr('영상 파일(mp4, mov, webm)만 올릴 수 있어요.');
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) return setErr(`${MAX_UPLOAD_MB}MB보다 큰 영상은 올릴 수 없어요. 짧게 잘라서 올려 주세요.`);
    setBusy(true);
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => {
      const srcDur = isFinite(v.duration) ? v.duration : 5;
      onAdd({ id: `u${Date.now()}`, name: file.name, url, srcDur, dur: Math.max(1, Math.min(5, Math.floor(srcDur) || 1)), caption: '', voice: '원래 소리', playable: true }, file);
      setBusy(false);
      setOwn(false);
      setFaces(false);
    };
    // 이 브라우저가 재생하지 못하는 형식(예: 아이폰 HEVC)이어도 올리기는 받는다. 실제 서비스에서는 서버가 MP4로 바꾼다.
    v.onerror = () => {
      onAdd({ id: `u${Date.now()}`, name: file.name, url, srcDur: 10, dur: 5, caption: '', voice: '원래 소리', playable: false }, file);
      setBusy(false);
      setOwn(false);
      setFaces(false);
    };
    v.src = url;
  };
  return (
    <div className="upload">
      <div className="upload-head">
        <strong>내 영상 올리기</strong>
        <span className="tag human">내가 한 일</span>
      </div>
      <label className="check small">
        <input type="checkbox" id="up-own" checked={own} onChange={(e) => setOwn(e.target.checked)} />
        <span>내가 직접 찍었거나 만든 영상이에요.</span>
      </label>
      <label className="check small">
        <input type="checkbox" id="up-faces" checked={faces} onChange={(e) => setFaces(e.target.checked)} />
        <span>다른 사람의 얼굴·이름이 나오지 않아요. (나온다면 그 사람에게 허락을 받았어요.)</span>
      </label>
      <label htmlFor="up-file" className={`upload-drop ${ready ? '' : 'off'}`}>
        <input
          id="up-file"
          type="file"
          accept="video/*"
          disabled={!ready || busy}
          onChange={(e) => {
            pick(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
        <span className="upload-btn">{busy ? '영상을 읽는 중…' : ready ? '영상 파일 고르기' : '위 두 가지를 확인하면 올릴 수 있어요'}</span>
        <span className="tiny muted">mp4·mov·webm · {MAX_UPLOAD_MB}MB 이하</span>
      </label>
      {err && <p className="danger-text">{err}</p>}
    </div>
  );
}

// ───────────── 6단계 검토·공유 (함수 이름 S5) ─────────────
const CHECKS = [
  ['fact', '사실과 다르거나 이상하게 나온 장면이 없나요?', 'AI는 손가락 개수, 글자 같은 것을 틀릴 때가 많아요.'],
  ['ok', '보는 사람이 불편하거나 상처받을 장면이 없나요?', '친구들이 함께 볼 영상이에요.'],
  ['privacy', '내 이름, 학교 이름, 얼굴, 전화번호가 나오지 않나요?', '개인정보는 한 번 퍼지면 지우기 어려워요.'],
  ['copy', '배경음악과 그림은 써도 되는 것만 썼나요?', '앱 안의 무료 음악 목록만 쓸 수 있어요.'],
] as const;

function S5() {
  const { s, d } = useStore();
  const allChecked = CHECKS.every(([k]) => s.checklist[k]);
  const peers = s.peers.map((p) => p.no);
  const exportOf = (no: number) => s.peers.find((p) => p.no === no)?.exportPath;
  return (
    <div className="screen">
      <ScreenHead n={6} title="검토하고, 친구들과 나눠요" lead="완성도만 보지 않아요. AI를 어떻게 쓰고 어떻게 판단했는지가 더 중요해요." />
      <section className="panel">
        <h3>최종 체크리스트</h3>
        <ul className="checks">
          {CHECKS.map(([k, q, why]) => (
            <li key={k}>
              <label className="check">
                <input
                  type="checkbox"
                  id={`chk-${k}`}
                  checked={!!s.checklist[k]}
                  onChange={(e) => d({ t: 'set', patch: { checklist: { ...s.checklist, [k]: e.target.checked } } })}
                />
                <span>
                  <strong>{q}</strong>
                  <span className="muted">{why}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </section>
      <section className="panel">
        <div className="panel-head">
          <h3>AI 사용 내역</h3>
          <span className="legend">
            <span className="tag ai">AI가 한 일</span>
            <span className="tag human">내가 한 일</span>
          </span>
        </div>
        <div className="table-wrap">
          <table className="usage">
            <thead>
              <tr>
                <th>장면</th>
                <th>AI가 한 일</th>
                <th>내가 한 일</th>
              </tr>
            </thead>
            <tbody>
              {s.scenes.map((sc, i) => {
                const gens = s.gens.filter((g) => g.sceneId === sc.id && g.status === 'succeeded');
                const judged = gens.filter((g) => g.judgement).length;
                return (
                  <tr key={sc.id}>
                    <td className="mono">#{i + 1}</td>
                    <td className="ai-cell">
                      {gens.length ? `${mediaWord(s)} ${gens.length}개 생성, 프롬프트 번역` : '아직 없음'}
                    </td>
                    <td className="human-cell">
                      이야기 만들기, 프롬프트 작성{sc.edits ? `, 수정 지시 ${sc.edits}번` : ''}
                      {judged ? `, 결과 판단 ${judged}번` : ''}
                      {sc.caption ? ', 자막' : ''}
                      {sc.voice === '내 목소리' ? ', 목소리 녹음' : ''}, 길이 조절
                    </td>
                  </tr>
                );
              })}
              {s.uploads.map((u) => (
                <tr key={u.id}>
                  <td className="mono">내 영상</td>
                  <td className="ai-cell">없음</td>
                  <td className="human-cell">직접 찍은 영상 올리기({u.name}){u.caption ? ', 자막' : ''}, 길이 조절</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <label htmlFor="ai-note" className="label-human">
          AI를 어떻게 썼는지 내 말로 설명해요
        </label>
        <textarea
          id="ai-note"
          rows={3}
          placeholder="예: 장면 그림은 AI가 만들었지만, 이야기와 순서는 내가 정했어요. 2번 장면은 AI가 우산을 빨간색으로 만들어서 고쳐 달라고 했어요."
          value={s.aiNote}
          onChange={(e) => d({ t: 'set', patch: { aiNote: e.target.value } })}
        />
      </section>
      <section className="panel">
        <h3>자기평가</h3>
        {[
          ['story', '내 경험을 이야기로 잘 나타냈나요?'],
          ['judge', 'AI가 만든 결과를 그대로 쓰지 않고 판단했나요?'],
          ['respect', 'AI를 안전하고 책임 있게 썼나요?'],
        ].map(([k, q]) => (
          <div className="self" key={k}>
            <span>{q}</span>
            <div className="pills">
              {['잘했어요', '보통이에요', '더 노력할래요'].map((v) => (
                <button key={v} className={`pill ${s.self[k] === v ? 'on' : ''}`} aria-pressed={s.self[k] === v} onClick={() => d({ t: 'set', patch: { self: { ...s.self, [k]: v } } })}>
                  {v}
                </button>
              ))}
            </div>
          </div>
        ))}
      </section>
      <section className="panel">
        <h3>우리 반 상영관</h3>
        {peers.length === 0 && <p className="muted">아직 제출한 친구가 없어요. 친구들이 제출하면 여기에 나타나요.</p>}
        <div className="gallery">
          {peers.map((no) => (
            <div className="peer" key={no}>
              {exportOf(no) ? (
                <StoredVideo path={exportOf(no)!} label={`${no}번 ${nickOf(no)}의 영상`} size="sm" />
              ) : (
                <MediaFrame hue={(no * 47) % 360} label={`${no}번 ${nickOf(no)}의 영상`} size="sm" badge="저장한 영상 없음" />
              )}
              <div className="peer-meta">
                <strong>{no}번 {nickOf(no)}</strong>
              </div>
              <input
                id={`peer-${no}`}
                aria-label={`${no}번 작품에 남길 말`}
                placeholder="인상 깊었던 점 한 줄"
                value={s.peer[no] ?? ''}
                onChange={(e) => d({ t: 'set', patch: { peer: { ...s.peer, [no]: e.target.value } } })}
              />
            </div>
          ))}
        </div>
      </section>
      <div className="submit-bar">
        <button className="btn primary big" disabled={!allChecked || s.submitted} onClick={() => d({ t: 'set', patch: { submitted: true, toast: '제출했어요. 수고했어요!' } })}>
          {s.submitted ? '제출 완료' : '작품 제출하기'}
        </button>
        {!allChecked && <span className="muted">체크리스트를 모두 확인하면 제출할 수 있어요.</span>}
      </div>
    </div>
  );
}

// ───────────── 공통 ─────────────
function ScreenHead({ n, title, lead, human }: { n: number; title: string; lead: string; human?: boolean }) {
  return (
    <div className="screen-head">
      <span className="slate mono">S{n}</span>
      <div>
        <h2>{title}</h2>
        <p className={human ? 'lead human-lead' : 'lead'}>{lead}</p>
      </div>
    </div>
  );
}

function Field({ id, label, value, onChange, wide, human }: { id: string; label: string; value: string; onChange: (v: string) => void; wide?: boolean; human?: boolean }) {
  return (
    <div className={`field ${wide ? 'wide' : ''} ${human ? 'human-field' : ''}`}>
      <label htmlFor={id}>{label}</label>
      <input id={id} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function NextBar({ to }: { to: Stage }) {
  const { s, d } = useStore();
  const locked = to > s.cls.open;
  return (
    <div className="nextbar">
      <button className="btn" disabled={locked} onClick={() => d({ t: 'set', patch: { tab: to } })}>
        {locked ? `${to}단계는 선생님이 열어 줄 거예요` : `다음 단계로 →`}
      </button>
    </div>
  );
}
