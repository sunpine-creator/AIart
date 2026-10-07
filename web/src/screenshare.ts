// 노트북 화면 공유 (교사 요청 → 학생 허락 → 학생 화면을 교사에게 실시간 영상으로)
// 신호 교환은 Firestore 문서 classes/{classId}/screens/{no} 와 그 아래 후보(cands) 목록으로 한다.
// 영상 자체는 서버를 거치지 않고 학생 브라우저 → 교사 브라우저로 바로 간다(WebRTC).
import { addDoc, collection, doc, onSnapshot, query, serverTimestamp, setDoc, updateDoc, where } from 'firebase/firestore';
import { db } from './firebase';

const ICE: RTCConfiguration = { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }] };

export type ShareState = 'requested' | 'offer' | 'live' | 'declined' | 'ended';

const screenDoc = (classId: string, no: number) => doc(db, 'classes', classId, 'screens', String(no));
const candCol = (classId: string, no: number) => collection(db, 'classes', classId, 'screens', String(no), 'cands');

// ───── 교사 ─────
export function teacherRequest(classId: string, no: number) {
  const sid = `${Date.now()}`;
  return setDoc(screenDoc(classId, no), { state: 'requested', sid, offer: null, answer: null, at: serverTimestamp() }).then(() => sid);
}

export function teacherStop(classId: string, no: number) {
  return updateDoc(screenDoc(classId, no), { state: 'ended' }).catch(() => {});
}

// 학생이 보낸 offer 를 받아 연결하고, 받은 영상을 onStream 으로 넘긴다. 되돌려 주는 함수로 정리한다.
export function teacherWatch(
  classId: string,
  no: number,
  sid: string,
  on: { stream: (s: MediaStream) => void; state: (s: ShareState | 'failed') => void },
): () => void {
  let pc: RTCPeerConnection | null = null;
  const unsubs: (() => void)[] = [];
  unsubs.push(
    onSnapshot(screenDoc(classId, no), async (d) => {
      const x = d.data();
      if (!x || x.sid !== sid) return;
      on.state(x.state);
      if (x.state === 'offer' && x.offer && !pc) {
        pc = new RTCPeerConnection(ICE);
        pc.ontrack = (e) => on.stream(e.streams[0]);
        pc.onicecandidate = (e) => e.candidate && addDoc(candCol(classId, no), { sid, from: 't', c: e.candidate.toJSON() }).catch(() => {});
        pc.onconnectionstatechange = () => pc && ['failed'].includes(pc.connectionState) && on.state('failed');
        await pc.setRemoteDescription(x.offer);
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        await updateDoc(screenDoc(classId, no), { answer: { type: ans.type, sdp: ans.sdp }, state: 'live' });
        unsubs.push(
          onSnapshot(query(candCol(classId, no), where('sid', '==', sid)), (q) =>
            q.docChanges().forEach((ch) => {
              const c = ch.doc.data();
              if (ch.type === 'added' && c.from === 's') pc?.addIceCandidate(c.c).catch(() => {});
            }),
          ),
        );
      }
      if (x.state === 'ended' || x.state === 'declined') {
        pc?.close();
        pc = null;
      }
    }),
  );
  return () => {
    unsubs.forEach((u) => u());
    pc?.close();
  };
}

// ───── 학생 ─────
// 선생님 요청이 오면 onRequest 를 부른다(허락 창을 띄우기 위해).
export function studentListen(classId: string, no: number, onChange: (x: { state: ShareState; sid: string } | null) => void) {
  return onSnapshot(
    screenDoc(classId, no),
    (d) => {
      const x = d.data();
      onChange(x ? { state: x.state, sid: x.sid } : null);
    },
    () => onChange(null),
  );
}

export function studentDecline(classId: string, no: number) {
  return updateDoc(screenDoc(classId, no), { state: 'declined' }).catch(() => {});
}

// 학생이 허락하면 화면을 골라 공유를 시작한다. 그만두는 함수를 돌려준다.
export async function studentShare(classId: string, no: number, sid: string, onEnd: () => void): Promise<() => void> {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 10 }, audio: false });
  const pc = new RTCPeerConnection(ICE);
  stream.getTracks().forEach((t) => pc.addTrack(t, stream));
  pc.onicecandidate = (e) => e.candidate && addDoc(candCol(classId, no), { sid, from: 's', c: e.candidate.toJSON() }).catch(() => {});
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await updateDoc(screenDoc(classId, no), { offer: { type: offer.type, sdp: offer.sdp }, state: 'offer' });
  let done = false;
  const unsubs: (() => void)[] = [];
  // 교사 답(answer)이 오기 전에 도착한 연결 후보는 모아 두었다가 넣는다
  const pending: RTCIceCandidateInit[] = [];
  const addCand = (c: RTCIceCandidateInit) => (pc.currentRemoteDescription ? pc.addIceCandidate(c).catch(() => {}) : pending.push(c));
  const stop = () => {
    if (done) return;
    done = true;
    unsubs.forEach((u) => u());
    stream.getTracks().forEach((t) => t.stop());
    pc.close();
    updateDoc(screenDoc(classId, no), { state: 'ended' }).catch(() => {});
    onEnd();
  };
  // 학생이 브라우저의 "공유 중지"를 누르면 끝낸다
  stream.getVideoTracks()[0]?.addEventListener('ended', stop);
  unsubs.push(
    onSnapshot(screenDoc(classId, no), async (d) => {
      const x = d.data();
      if (!x || x.sid !== sid) return stop();
      if (x.answer && !pc.currentRemoteDescription) {
        await pc.setRemoteDescription(x.answer).catch(() => {});
        pending.splice(0).forEach((c) => pc.addIceCandidate(c).catch(() => {}));
      }
      if (x.state === 'ended') stop();
    }),
  );
  unsubs.push(
    onSnapshot(query(candCol(classId, no), where('sid', '==', sid)), (q) =>
      q.docChanges().forEach((ch) => {
        const c = ch.doc.data();
        if (ch.type === 'added' && c.from === 't') addCand(c.c);
      }),
    ),
  );
  return stop;
}
