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
  g?: { hue: number; img: boolean; storagePath?: string; mimeType?: string };
  label: string;
  caption?: string;
  badge?: string;
  size?: 'sm' | 'md' | 'lg';
  still?: boolean;
  controls?: boolean;
  autoPlay?: boolean;
}) {
  const [url, setUrl] = React.useState<string | undefined>(g?.storagePath ? urlCache.get(g.storagePath) : undefined);
  React.useEffect(() => {
    const p = g?.storagePath;
    if (!p || urlCache.has(p)) return void (p && setUrl(urlCache.get(p)));
    getDownloadURL(sref(storage, p)).then((u) => (urlCache.set(p, u), setUrl(u)), () => setUrl(undefined));
  }, [g?.storagePath]);
  if (!g) return null;
  if (!g.storagePath || !url) return <MediaFrame hue={g.hue} label={label} still={still || g.img} badge={badge} caption={caption} size={size} />;
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

export function StoredVideo({ path, label, size = 'md' }: { path: string; label: string; size?: 'sm' | 'md' | 'lg' }) {
  const url = useStorageUrl(path);
  return (
    <div className={`frame frame-${size} video-frame`} aria-label={label}>
      {url ? <video src={url} controls playsInline preload="metadata" /> : <span className="no-preview">불러오는 중…</span>}
    </div>
  );
}
