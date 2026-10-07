// 교사: 학생 화면 보기
// ① 앱 안 화면 실시간 보기: 학생이 쓰는 내용(활동지·프롬프트·만든 영상·편집)을 바로바로 보여 준다. 허락 창 없음.
// ② 노트북 화면 공유: 교사가 요청하고 학생이 허락하면 노트북 화면 전체를 영상으로 본다.
import React, { useEffect, useRef, useState } from 'react';
import { collection, doc, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { db } from '../firebase';
import { Gen, Scene, Upload, toGen, useStore } from '../store';
import { GenMedia, StoredVideo } from '../MediaFrame';
import { STAGES } from './Student';
import { ShareState, teacherRequest, teacherStop, teacherWatch } from '../screenshare';

const STATUS: Record<string, string> = {
  awaiting_approval: '승인 대기',
  queued: '대기열',
  running: '만드는 중',
  succeeded: '완성',
  blocked: '차단',
  rejected: '돌려보냄',
};

export function StudentScreens() {
  const { s, d } = useStore();
  const roster = s.others;
  const sel = roster.find((r) => r.no === s.selectedStudent) ?? roster[0];
  return (
    <div className="mirror-wrap">
      <aside className="mirror-roster" aria-label="학생 고르기">
        {roster.map((r) => (
          <button key={r.no} className={`mirror-seat ${sel?.no === r.no ? 'on' : ''}`} onClick={() => d({ t: 'set', patch: { selectedStudent: r.no } })}>
            <span className="mono">{r.no}</span>
            <span className="mirror-name">{r.nick || '(미입장)'}</span>
            <span className="tiny muted">{r.stage}단계</span>
          </button>
        ))}
      </aside>
      {sel ? <StudentMirror key={sel.no} no={sel.no} name={sel.nick} stage={sel.stage} /> : <p className="muted">학생이 없어요.</p>}
    </div>
  );
}

function StudentMirror({ no, name, stage }: { no: number; name: string; stage: number }) {
  const { s } = useStore();
  const classId = s.classId;
  const [p, setP] = useState<Record<string, any> | null>(null);
  const [gens, setGens] = useState<Gen[]>([]);
  const [tab, setTab] = useState<number | null>(null); // null = 학생이 보고 있는 단계를 따라감
  const [share, setShare] = useState(false);
  useEffect(() => {
    const u1 = onSnapshot(doc(db, 'projects', `${classId}_${no}`), (x) => setP(x.data() ?? {}), () => setP({}));
    const u2 = onSnapshot(
      query(collection(db, 'generations'), where('classId', '==', classId), where('no', '==', no), orderBy('createdAt', 'asc')),
      (q) => setGens(q.docs.map((x) => toGen(x.id, x.data()))),
      () => setGens([]),
    );
    return () => (u1(), u2());
  }, [classId, no]);
  const view = tab ?? stage;
  const scenes: Scene[] = p?.scenes ?? [];
  const uploads: Upload[] = p?.uploads ?? [];
  const story = p?.story ?? {};
  return (
    <section className="panel mirror">
      <div className="panel-head">
        <h3>
          {no}번 {name || '(미입장)'}의 화면 <span className="chip ai">실시간</span>
        </h3>
        <button className="btn" onClick={() => setShare(!share)}>
          {share ? '노트북 화면 닫기' : '노트북 화면 공유 요청'}
        </button>
      </div>
      {share && <LaptopViewer no={no} />}
      <div className="seg" role="group" aria-label="단계">
        {STAGES.map((st) => (
          <button key={st.n} className={`seg-b ${view === st.n ? 'on' : ''}`} onClick={() => setTab(st.n === stage && tab !== null ? null : st.n)}>
            {st.n} {st.name}
            {st.n === stage ? ' ●' : ''}
          </button>
        ))}
      </div>
      <p className="tiny muted">● 표시가 학생이 지금 보고 있는 단계예요. {tab !== null && <button className="link" onClick={() => setTab(null)}>학생 따라가기</button>}</p>
      {!p ? (
        <p className="muted">불러오는 중…</p>
      ) : (
        <div className="mirror-body">
          {view === 1 && (
            <dl className="kv">
              <dt>카드 분류(초등)</dt>
              <dd>{Object.values(p.sortCards ?? {}).filter(Boolean).length}개 분류함</dd>
              <dt>프롬프트 비교(중·고등)</dt>
              <dd>{Object.values(p.prmCmp ?? {}).filter((x: any) => x?.checked).length}개 확인함</dd>
              <dt>요소 나누기</dt>
              <dd>{Object.values(p.prmSort ?? {}).filter(Boolean).length}개</dd>
              <dt>생각 정리</dt>
              <dd>{p.prmThink || '—'}</dd>
            </dl>
          )}
          {view === 2 && (
            <dl className="kv">
              <dt>주제</dt>
              <dd>{p.topic || '—'}</dd>
              {(
                [
                  ['who', '누가'],
                  ['when', '언제'],
                  ['where', '어디서'],
                  ['what', '무엇을'],
                  ['event', '어떻게'],
                  ['why', '왜'],
                  ['feeling', '기분'],
                ] as const
              ).map(([k, l]) => (
                <React.Fragment key={k}>
                  <dt>{l}</dt>
                  <dd>{story[k] || '—'}</dd>
                </React.Fragment>
              ))}
              {p.brief?.message && (
                <>
                  <dt>핵심 메시지</dt>
                  <dd>{p.brief.message}</dd>
                </>
              )}
              {(p.scenario?.final || p.scenario?.draft?.length) && (
                <>
                  <dt>시나리오</dt>
                  <dd className="pre">{p.scenario.final || (p.scenario.draft ?? []).join('\n')}</dd>
                </>
              )}
            </dl>
          )}
          {view === 3 && (
            <ol className="mirror-scenes">
              {scenes.map((sc, i) => {
                const gs = gens.filter((g) => g.sceneId === sc.id);
                const b = sc.builder ?? ({} as any);
                return (
                  <li key={sc.id} className="mirror-scene">
                    <strong>
                      #{i + 1} {sc.line}
                    </strong>
                    <p className="tiny">
                      {b.mode === 'free'
                        ? `직접 쓰기: ${b.free || '—'}`
                        : [b.who, b.when, b.where, b.what, b.how, b.why, b.extra].filter(Boolean).join(' · ') || '아직 안 썼어요'}
                    </p>
                    <div className="mirror-gens">
                      {gs.length === 0 && <span className="tiny muted">아직 만든 결과 없음</span>}
                      {gs.map((g) => (
                        <figure key={g.id}>
                          {g.status === 'succeeded' ? <GenMedia g={g} label={sc.line} size="sm" badge={g.kind === 'final' ? '확정' : g.kind === 'edit' ? '수정본' : '초안'} /> : <div className="frame frame-sm empty-frame tiny">{STATUS[g.status] ?? g.status}</div>}
                          <figcaption className="tiny muted">
                            {g.editText ? `수정: ${g.editText}` : g.promptKo}
                            {g.judgement ? ` · 판단: ${g.judgement.fit === 'yes' ? '맞아요' : '아니에요'}${g.judgement.reason ? `(${g.judgement.reason})` : ''}` : ''}
                          </figcaption>
                        </figure>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
          {view === 4 && (
            <ol className="mirror-list">
              {scenes.map((sc, i) => (
                <li key={sc.id}>
                  <strong>#{i + 1}</strong> {sc.line || '—'}
                  {sc.intent && <span className="tiny muted"> · 메시지 연결: {sc.intent}</span>}
                </li>
              ))}
            </ol>
          )}
          {view === 5 && (
            <div className="mirror-edit">
              <p>
                <strong>제목:</strong> {p.intro?.caption || p.topic || '—'} · <strong>끝:</strong> {p.outro?.caption || '—'}
              </p>
              <ol className="mirror-list">
                {scenes
                  .filter((x) => !x.skip)
                  .map((sc) => (
                    <li key={sc.id}>
                      장면 {scenes.indexOf(sc) + 1} · {sc.dur}초{sc.start ? ` (앞 ${sc.start}초 자름)` : ''} · 자막: {sc.caption || '—'} · 목소리: {sc.voice}
                    </li>
                  ))}
                {uploads.map((u) => (
                  <li key={u.id}>
                    내 영상 {u.name} · {u.dur}초 · 자막: {u.caption || '—'}
                  </li>
                ))}
              </ol>
              {p.lastExport?.path ? (
                <StoredVideo path={p.lastExport.path} url={p.lastExport.url} label="저장한 영상" size="md" />
              ) : (
                <p className="tiny muted">아직 영상을 저장하지 않았어요.</p>
              )}
            </div>
          )}
          {view === 6 && (
            <dl className="kv">
              <dt>체크리스트</dt>
              <dd>{Object.values(p.checklist ?? {}).filter(Boolean).length}개 확인</dd>
              <dt>AI 사용 설명</dt>
              <dd>{p.aiNote || '—'}</dd>
              {p.reflect && (
                <>
                  <dt>되돌아보기</dt>
                  <dd>{p.reflect}</dd>
                </>
              )}
              <dt>제출</dt>
              <dd>{p.submitted ? '제출했어요' : '아직'}</dd>
            </dl>
          )}
        </div>
      )}
    </section>
  );
}

// 노트북 화면 공유 보기
function LaptopViewer({ no }: { no: number }) {
  const { s } = useStore();
  const [state, setState] = useState<ShareState | 'failed' | 'idle'>('idle');
  const videoRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    let stopWatch = () => {};
    let alive = true;
    teacherRequest(s.classId, no).then((sid) => {
      if (!alive) return;
      stopWatch = teacherWatch(s.classId, no, sid, {
        stream: (st) => {
          if (videoRef.current) videoRef.current.srcObject = st;
        },
        state: setState,
      });
    });
    return () => {
      alive = false;
      stopWatch();
      teacherStop(s.classId, no);
    };
  }, [s.classId, no]);
  const msg: Record<string, string> = {
    idle: '요청을 보내는 중…',
    requested: '학생 화면에 허락 요청이 떴어요. 학생이 “화면 공유 시작”을 누르고 공유할 화면을 고르면 보여요.',
    offer: '연결하는 중…',
    live: '',
    declined: '학생이 화면 공유를 거절했어요.',
    ended: '화면 공유가 끝났어요.',
    failed: '연결하지 못했어요. 학교 네트워크가 막고 있을 수 있어요. 잠시 뒤 다시 요청해 보세요.',
  };
  return (
    <div className="laptop">
      <video ref={videoRef} autoPlay playsInline muted className={state === 'live' ? '' : 'hidden'} />
      {state !== 'live' && <p className="muted">{msg[state]}</p>}
    </div>
  );
}
