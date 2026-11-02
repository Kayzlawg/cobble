import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Icon } from "./Icon";

// One frame per file, cached for the session. Requests run one at a time so a long history does not spawn a pile of ffmpegs.
const thumbs = new Map<string, Promise<string | null>>();
let chain: Promise<unknown> = Promise.resolve();

function loadThumb(path: string) {
  let p = thumbs.get(path);
  if (!p) {
    p = chain.then(() =>
      invoke<ArrayBuffer>("thumbnail", { path })
        .then((b) => URL.createObjectURL(new Blob([b], { type: "image/jpeg" })))
        .catch(() => null),
    );
    chain = p;
    thumbs.set(path, p);
  }
  return p;
}

export function Thumb({ path }: { path: string }) {
  // undefined while loading, null when the file has no frame (audio, missing)
  const [src, setSrc] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let on = true;
    setSrc(undefined);
    loadThumb(path).then((s) => on && setSrc(s));
    return () => {
      on = false;
    };
  }, [path]);
  return (
    <div className={`thumb sm ${src === undefined ? "skel" : ""}`}>
      {src ? <img src={src} alt="" /> : src === null && <Icon name="play" size={14} />}
    </div>
  );
}

// Runs the row's leave animation, then calls `done` to actually remove it.
export function useLeave(ms = 180) {
  const [leaving, setLeaving] = useState<Set<string | number>>(new Set());
  const leave = (key: string | number, done: () => void) => {
    setLeaving((s) => new Set(s).add(key));
    setTimeout(() => {
      done();
      setLeaving((s) => {
        const n = new Set(s);
        n.delete(key);
        return n;
      });
    }, ms);
  };
  return [leaving, leave] as const;
}

export const size = (b: number | null) =>
  b == null ? "" : b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`;

export const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function Seg<T extends string | number | null>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; text: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="setting">
      <div className="colhead">{label}</div>
      <div className="seg" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button key={String(o.value)} role="radio" aria-checked={o.value === value} onClick={() => onChange(o.value)}>
            {o.text}
          </button>
        ))}
      </div>
    </div>
  );
}
