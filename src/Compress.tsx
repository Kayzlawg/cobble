import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Icon } from "./Icon";
import { Seg, Thumb, size, useLeave } from "./ui";
import type { NewJob } from "./types";

const VIDEO = /\.(mp4|mkv|mov|avi|webm|m4v|flv|wmv|ts|mts|m2ts)$/i;
const name = (p: string) => p.split(/[\\/]/).pop() ?? p;

type Meta = { size: number; height: number | null };

// Typical output size as a share of the source for each CRF preset. Real sizes swing with the footage, so this is a rough guide.
// ponytail: fixed ratios, replace with a short sample encode if estimates need to be tighter.
const RATIO: Record<string, Record<string, number>> = {
  h265: { small: 0.18, balanced: 0.28, high: 0.45 },
  h264: { small: 0.3, balanced: 0.45, high: 0.7 },
};

// NVENC output runs larger than x264/x265 at the same quality setting.
const GPU_FACTOR = 1.3;

function estimate(m: Meta, preset: string, codec: string, maxHeight: number | null, gpu: boolean) {
  const shrink = maxHeight && m.height && maxHeight < m.height ? (maxHeight / m.height) ** 2 : 1;
  return m.size * RATIO[codec][preset] * shrink * (gpu ? GPU_FACTOR : 1);
}

export default function Compress({ dir, onChangeDir, onAdd }: { dir: string; onChangeDir: () => void; onAdd: (jobs: NewJob[]) => void }) {
  const [files, setFiles] = useState<string[]>([]);
  const [preset, setPreset] = useState("balanced");
  const [codec, setCodec] = useState("h265");
  const [maxHeight, setMaxHeight] = useState<number | null>(null);
  const [over, setOver] = useState(false);
  const [encoder, setEncoder] = useState("cpu");
  const [gpuOk, setGpuOk] = useState(false);
  const gpu = gpuOk && encoder === "gpu";
  // A path is missing while its size is being read, and null if reading it failed.
  const [meta, setMeta] = useState<Record<string, Meta | null>>({});

  const add = (paths: string[]) => {
    setFiles((f) => [...f, ...paths.filter((p) => VIDEO.test(p) && !f.includes(p))]);
    paths.filter((p) => VIDEO.test(p)).forEach((p) =>
      invoke<Meta>("probe_video", { path: p })
        .then((m) => setMeta((s) => ({ ...s, [p]: m })))
        .catch(() => setMeta((s) => ({ ...s, [p]: null }))),
    );
  };
  const [leaving, leave] = useLeave();
  const out = (p: string) => estimate(meta[p]!, preset, codec, maxHeight, gpu);
  const est = (p: string) => (meta[p] ? `${size(meta[p].size)} to ~${size(out(p))}` : "");
  const known = files.filter((p) => meta[p]);
  const calculating = files.some((p) => !(p in meta));
  const total = known.length
    ? `${size(known.reduce((a, p) => a + meta[p]!.size, 0))} to ~${size(known.reduce((a, p) => a + out(p), 0))}`
    : "";

  useEffect(() => {
    invoke<boolean>("gpu_available").then(setGpuOk);
  }, []);

  useEffect(() => {
    const off = getCurrentWebview().onDragDropEvent((e) => {
      const t = e.payload.type;
      if (t === "over") setOver(true);
      else if (t === "drop") {
        setOver(false);
        add(e.payload.paths);
      } else setOver(false);
    });
    return () => {
      off.then((f) => f());
    };
  }, []);

  async function browse() {
    const r = await open({ multiple: true, filters: [{ name: "Video", extensions: ["mp4", "mkv", "mov", "avi", "webm", "m4v", "ts"] }] });
    if (Array.isArray(r)) add(r);
  }

  function start() {
    const label = `${codec === "h265" ? "H.265" : "H.264"} ${preset}${maxHeight ? ` ${maxHeight}p` : ""}${gpu ? " GPU" : ""}`;
    onAdd(
      files.map((path) => ({
        kind: "compress",
        title: name(path),
        label,
        est: est(path),
        creq: { path, preset, codec, max_height: maxHeight, gpu },
      })),
    );
    setFiles([]);
  }

  return (
    <>
      <h1>Compress</h1>
      <button className={`drop ${over ? "over" : ""}`} onClick={browse}>
        <Icon name="compress" size={22} />
        <span>Drop videos here or click to browse</span>
      </button>

      {files.length > 0 && (
        <div className="list entries">
          {files.map((p) => (
            <div className={`row ${leaving.has(p) ? "leaving" : ""}`} key={p}>
              <Thumb path={p} />
              <span className="n ell" title={p}>
                {name(p)}
              </span>
              <span className="cell">
                {p in meta ? <small>{size(meta[p]?.size ?? null)}</small> : <span className="spin" aria-label="Calculating size" />}
              </span>
              <button className="icon" aria-label="Remove" onClick={() => leave(p, () => setFiles((f) => f.filter((x) => x !== p)))}>
                <Icon name="x" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="settings">
        <Seg
          label="Quality"
          value={preset}
          onChange={setPreset}
          options={[
            { value: "small", text: "Small file" },
            { value: "balanced", text: "Balanced" },
            { value: "high", text: "High quality" },
          ]}
        />
        <Seg
          label="Codec"
          value={codec}
          onChange={setCodec}
          options={[
            { value: "h265", text: "H.265 (smaller)" },
            { value: "h264", text: "H.264 (compatible)" },
          ]}
        />
        <Seg
          label="Max resolution"
          value={maxHeight}
          onChange={setMaxHeight}
          options={[
            { value: null, text: "Original" },
            { value: 1080, text: "1080p" },
            { value: 720, text: "720p" },
            { value: 480, text: "480p" },
          ]}
        />
        {gpuOk && (
          <Seg
            label="Encoder"
            value={encoder}
            onChange={setEncoder}
            options={[
              { value: "cpu", text: "CPU (smaller)" },
              { value: "gpu", text: "GPU (faster)" },
            ]}
          />
        )}
      </div>

      <div className="foot">
        <button className="dest" onClick={onChangeDir} title="Change folder">
          <Icon name="folder" />
          {dir.split("\\").pop()}
        </button>
        <small className="sum">
          {calculating ? (
            <>
              <span className="spin" />
              Calculating size
            </>
          ) : (
            total
          )}
        </small>
        <button className="go" onClick={start} disabled={files.length === 0}>
          Compress {files.length > 1 ? `${files.length} files` : ""}
        </button>
      </div>
    </>
  );
}
