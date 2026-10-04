import React from 'react';
import { getDownloadURL, ref as sref } from 'firebase/storage';
import { storage } from './firebase';

// 저장된 결과가 없을 때(가짜 모드, 생성 중) 보여 주는 움직이는 그림판.
export function MediaFrame({
  hue,
  label,
  still,
  badge,
  caption,
  size = 'md',
}: {
  hue: number;
  label: string;
  still?: boolean;
  badge?: string;
  caption?: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const style = { ['--h' as any]: hue } as React.CSSProperties;
  return (
    <div className={`frame frame-${size} ${still ? 'still' : ''}`} style={style} role="img" aria-label={`AI가 만든 장면: ${label}`}>
      <div className="frame-sky" />
      <div className="frame-sun" />
      <div className="frame-hill" />
      <div className="frame-blob" />
      {badge && <span className="frame-badge">{badge}</span>}
      <span className="frame-label">{label}</span>
      {caption && <span className="frame-caption">{caption}</span>}
    </div>
  );
}

// 실제 생성 결과. 저장된 파일이 있으면 재생하고, 가짜(mock) 결과면 그림판으로 보여 준다.

const urlCache = new Map<string, string>();

export function GenMedia({
  g,
  label,
  caption,
  badge,
  size = 'md',
  still,
  controls,
  autoPlay,
}: {
  g?: { hue: number; img: boolean; storagePath?: string; url?: string; mimeType?: string; mock?: boolean };
  label: string;
  caption?: string;
  badge?: string;
  size?: 'sm' | 'md' | 'lg';
  still?: boolean;
  controls?: boolean;
  autoPlay?: boolean;
}) {
  // 서버가 저장해 둔 주소(g.url)를 먼저 쓰고, 없으면 Storage 에서 주소를 받아 온다
  const [url, setUrl] = React.useState<string | undefined>(g?.url ?? (g?.storagePath ? urlCache.get(g.storagePath) : undefined));
  const [err, setErr] = React.useState('');
  React.useEffect(() => {
    if (g?.url) return void setUrl(g.url);
    const p = g?.storagePath;
    if (!p || urlCache.has(p)) return void (p && setUrl(urlCache.get(p)));
    getDownloadURL(sref(storage, p)).then((u) => (urlCache.set(p, u), setUrl(u)), (e: any) => (setUrl(undefined), setErr(String(e?.code ?? e))));
  }, [g?.storagePath, g?.url]);
  if (!g) return null;
  if (g.mock || !g.storagePath) return <MediaFrame hue={g.hue} label={label} still={still || g.img} badge={g.mock ? '연습 모드 가짜 결과' : badge} caption={caption} size={size} />;
  if (!url)
    return (
      <div className={`frame frame-${size} video-frame`} role="img" aria-label={label}>
        <span className="no-preview">{err ? `영상을 불러오지 못했어요 (${err}). 새로고침해 보세요.` : '불러오는 중…'}</span>
      </div>
    );
  const isImage = g.img || (g.mimeType ?? '').startsWith('image/');
  return (
    <div className={`frame frame-${size} video-frame`} role="img" aria-label={`AI가 만든 장면: ${label}`}>
      {isImage ? (
        <img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      ) : (
        <video key={`${url}-${autoPlay ? 'p' : ''}`} src={url} controls={controls && size !== 'sm'} autoPlay={autoPlay} muted={size === 'sm' || autoPlay} loop={size === 'sm'} playsInline preload="metadata" />
      )}
      {badge && <span className="frame-badge">{badge}</span>}
      {caption && <span className="frame-caption">{caption}</span>}
    </div>
  );
}

// Storage 에 저장된 영상·소리를 재생한다 (완성 영상, 녹음)
export function useStorageUrl(path?: string) {
  const [url, setUrl] = React.useState<string | undefined>(path ? urlCache.get(path) : undefined);
  React.useEffect(() => {
    if (!path) return void setUrl(undefined);
    if (urlCache.has(path)) return void setUrl(urlCache.get(path));
    getDownloadURL(sref(storage, path)).then((u) => (urlCache.set(path, u), setUrl(u)), () => setUrl(undefined));
  }, [path]);
  return url;
}

export function StoredVideo({ path, url: direct, label, size = 'md' }: { path: string; url?: string; label: string; size?: 'sm' | 'md' | 'lg' }) {
  const fetched = useStorageUrl(direct ? undefined : path);
  const url = direct ?? fetched;
  return (
    <div className={`frame frame-${size} video-frame`} aria-label={label}>
      {url ? <video src={url} controls playsInline preload="metadata" /> : <span className="no-preview">불러오는 중…</span>}
    </div>
  );
}
