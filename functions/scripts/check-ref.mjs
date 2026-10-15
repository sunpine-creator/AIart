// 주인공 카드 → 장면 첫 그림 → 그 그림으로 시작하는 영상, 실제로 되는지 점검 (비용 약 $0.4)
// 실행: node functions/scripts/check-ref.mjs
import { GoogleGenAI } from '@google/genai';
import { readFileSync, writeFileSync } from 'node:fs';

const env = Object.fromEntries(
  ['.env', '.env.local']
    .flatMap((f) => { try { return readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').split('\n'); } catch { return []; } })
    .filter((l) => /^\w+=/.test(l))
    .map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1).trim()]),
);
const project = JSON.parse(readFileSync(new URL('../../.firebaserc', import.meta.url), 'utf8')).projects.default;
const ai = new GoogleGenAI({ vertexai: true, enterprise: true, project, location: env.GENAI_LOCATION || 'global' });
const style = "Art style: warm children's picture-book illustration, soft rounded shapes, clean thin outlines, flat pastel colors, soft warm daylight, no photorealism.";
const img = async (parts, aspectRatio) => {
  const r = await ai.models.generateContent({ model: env.IMAGE_MODEL, contents: [{ role: 'user', parts }], config: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio } } });
  const p = r.candidates?.[0]?.content?.parts?.find((x) => x.inlineData);
  if (!p) throw new Error('그림 없음: ' + JSON.stringify(r.promptFeedback ?? r.candidates?.[0]?.finishReason));
  return Buffer.from(p.inlineData.data, 'base64');
};
try {
  console.log('1) 주인공 카드 그리는 중…');
  const card = await img([{ text: `Character reference sheet of ONE fictional 10-year-old girl with a short bob haircut, yellow raincoat and red boots. Full body, front view, plain light background, no text. ${style}` }], '1:1');
  writeFileSync('ref-card.png', card); console.log('✅ ref-card.png');
  console.log('2) 장면 첫 그림 그리는 중…');
  const key = await img([{ inlineData: { mimeType: 'image/png', data: card.toString('base64') } }, { text: `Draw ONE 16:9 frame with exactly this character and art style: she opens an umbrella at the front door of an apartment on a rainy morning. ${style}` }], '16:9');
  writeFileSync('ref-key.png', key); console.log('✅ ref-key.png');
  console.log('3) 그 그림으로 시작하는 3초 영상 만드는 중… (1~5분)');
  const it0 = await ai.interactions.create({
    model: env.OMNI_MODEL, background: true,
    input: [{ type: 'user_input', content: [{ type: 'image', data: key.toString('base64'), mime_type: 'image/png' }, { type: 'text', text: `The girl smiles and opens her umbrella, rain falling. ${style}` }] }],
    generation_config: { video_config: { task: 'image_to_video' } },
    response_format: { type: 'video', delivery: 'inline', aspect_ratio: '16:9', duration: '3s', resolution: '720p' },
  });
  let it = it0;
  while (['in_progress', 'queued', 'pending'].includes(it.status)) { await new Promise((r) => setTimeout(r, 10000)); it = await ai.interactions.get(it0.id); process.stdout.write('.'); }
  // AI가 만든 결과(model_output)에서 영상만 꺼낸다 (보낸 그림이 같이 들어 있어서 구분해야 함)
  const summary = (it.steps ?? []).map((s) => `${s.type}: ${(s.content ?? []).map((x) => x.type + (x.mime_type ? `(${x.mime_type})` : '')).join(', ')}`);
  console.log('\n응답 구성:', summary.join(' | '));
  const c = (it.steps ?? []).filter((s) => s.type === 'model_output').flatMap((s) => s.content ?? []).find((x) => x?.data && String(x.mime_type ?? '').startsWith('video'));
  if (it.status !== 'completed' || !c) throw new Error(`영상 실패: ${JSON.stringify(it.error ?? it.status)}`);
  writeFileSync('ref-video.mp4', Buffer.from(c.data, 'base64'));
  console.log('\n✅ ref-video.mp4 — 그림으로 시작하는 영상이 돼요! (앱은 이 방식을 써요)');
} catch (e) {
  console.log('\n❌', String(e?.message ?? e).slice(0, 600));
  console.log('→ 이 경우 앱은 자동으로 "글만으로" 영상을 만들어요. 이 메시지를 Claude에게 보내 주세요.');
}
