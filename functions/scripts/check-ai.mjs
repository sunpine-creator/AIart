// 실제 AI 연결 점검: node scripts/check-ai.mjs [video]
//  1) Vertex AI 로그인·권한  2) 검사·번역용 텍스트 모델  3) (video 를 붙이면) Gemini Omni 3초 영상 1개 (약 $0.09)
import { GoogleGenAI } from '@google/genai';
import { readFileSync, writeFileSync } from 'node:fs';

const env = Object.fromEntries(
  ['.env', '.env.local']
    .flatMap((f) => { try { return readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').split('\n'); } catch { return []; } })
    .filter((l) => /^\w+=/.test(l))
    .map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1).trim()]),
);
const project = process.env.GOOGLE_CLOUD_PROJECT || JSON.parse(readFileSync(new URL('../../.firebaserc', import.meta.url), 'utf8')).projects.default;
const location = env.GENAI_LOCATION || 'global';
const ok = (m) => console.log(`✅ ${m}`);
const bad = (m, e) => console.log(`❌ ${m}\n   → ${String(e?.message ?? e).slice(0, 400)}`);

console.log(`프로젝트: ${project} · 위치: ${location}`);
console.log(`SDK: @google/genai ${JSON.parse(readFileSync(new URL('../node_modules/@google/genai/package.json', import.meta.url), 'utf8')).version}`);
const ai = new GoogleGenAI({ vertexai: true, enterprise: true, project, location });

try {
  const r = await ai.models.generateContent({ model: env.TEXT_MODEL, contents: '한 단어로 답해: 하늘 색은?' });
  ok(`텍스트 모델 ${env.TEXT_MODEL} 응답: ${r.text?.trim()}`);
} catch (e) { bad(`텍스트 모델 ${env.TEXT_MODEL} 실패`, e); }

console.log(`interactions API: ${typeof ai.interactions?.create === 'function' ? '있음' : '없음 (SDK 업데이트 필요)'}`);

if (process.argv[2] === 'video') {
  // 모델 ID × 해상도 조합을 차례로 시험한다. 성공하면 멈춘다.
  const candidates = [...new Set([process.argv[3], env.OMNI_MODEL, 'gemini-omni-1.1-flash', 'gemini-omni-flash', 'gemini-omni-flash-preview'].filter(Boolean))];
  const summarize = (it) => JSON.stringify({ status: it.status, error: it.error, steps: (it.steps ?? []).map((s) => ({ type: s.type, content: (s.content ?? []).map((c) => ({ type: c.type, text: c.text?.slice?.(0, 300), mime: c.mime_type, data: !!c.data, uri: c.uri })) })) }, null, 1).slice(0, 2500);
  let done = false;
  for (const model of candidates) {
    for (const resolution of ['360p', '720p']) {
      if (done) break;
      try {
        console.log(`\nOmni(${model}, ${resolution})로 3초 영상 1개 만드는 중… (1~5분)`);
        const it0 = await ai.interactions.create({
          model,
          input: 'A child smiling at a smart speaker in a cozy living room. Bright, gentle picture-book animation, safe for children.',
          background: true,
          generation_config: { video_config: { task: 'text_to_video' } },
          response_format: { type: 'video', delivery: 'inline', aspect_ratio: '16:9', duration: '3s', resolution },
        });
        let it = it0;
        while (!['completed', 'failed', 'cancelled'].includes(it.status)) {
          await new Promise((r) => setTimeout(r, 10000));
          it = await ai.interactions.get(it0.id);
          console.log(`  상태: ${it.status}`);
        }
        if (it.status !== 'completed') {
          console.log(`❌ 실패 (${model}, ${resolution}) 자세한 응답:\n${summarize(it)}`);
          continue;
        }
        const parts = [...(it.steps ?? []).filter((s) => s.type === 'model_output').flatMap((s) => s.content ?? []), ...(it.outputs ?? [])];
        const m = parts.find((c) => c?.data || c?.uri);
        console.log('  응답 구조:', JSON.stringify(parts.map((p) => ({ type: p.type, mime: p.mime_type ?? p.mimeType, data: !!p.data, uri: p.uri }))));
        if (m?.data) { writeFileSync('omni-test.mp4', Buffer.from(m.data, 'base64')); ok(`영상 저장: functions/omni-test.mp4 (모델 ID: ${model}, ${resolution})`); }
        else if (m?.uri) ok(`영상 주소: ${m.uri} (모델 ID: ${model}, ${resolution})`);
        else console.log(`❌ 응답에서 영상을 찾지 못함:\n${summarize(it)}`);
        console.log(`👉 OMNI_MODEL=${model} · 되는 해상도: ${resolution}`);
        done = true;
      } catch (e) {
        const msg = String(e?.message ?? e);
        bad(`Omni(${model}, ${resolution}) 요청 오류`, e);
        if (/not.?found|404|does not exist|unknown model|invalid model/i.test(msg)) break; // 이 모델은 없음 → 다음 모델
      }
    }
    if (done) break;
  }
}
