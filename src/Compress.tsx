import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Icon } from "./Icon";
import { Seg } from "./ui";
import type { NewJob } from "./types";

const VIDEO = /\.(mp4|mkv|mov|avi|webm|m4v|flv|wmv|ts|mts|m2ts)$/i;
const name = (p: string) => p.split(/[\\/]/).pop() ?? p;

export default function Compress({ dir, onChangeDir, onAdd }: { dir: string; onChangeDir: () => void; onAdd: (jobs: NewJob[]) => void }) {
  const [files, setFiles] = useState<string[]>([]);
  const [preset, setPreset] = useState("balanced");
  const [codec, setCodec] = useState("h265");
  const [maxHeight, setMaxHeight] = useState<number | null>(null);
  const [over, setOver] = useState(false);

  const add = (paths: string[]) =>
    setFiles((f) => [...f, ...paths.filter((p) => VIDEO.test(p) && !f.includes(p))]);

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
    const label = `${codec === "h265" ? "H.265" : "H.264"} ${preset}${maxHeight ? ` ${maxHeight}p` : ""}`;
    onAdd(
      files.map((path) => ({
        kind: "compress",
        title: name(path),
        label,
        creq: { path, preset, codec, max_height: maxHeight },
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
            <div className="row" key={p}>
              <span className="n ell" title={p}>
                {name(p)}
              </span>
              <button className="icon" aria-label="Remove" onClick={() => setFiles(files.filter((f) => f !== p))}>
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
      </div>

      <div className="foot">
        <button className="dest" onClick={onChangeDir} title="Change folder">
          <Icon name="folder" />
          {dir.split("\\").pop()}
        </button>
        <button className="go" onClick={start} disabled={files.length === 0}>
          Compress {files.length > 1 ? `${files.length} files` : ""}
        </button>
      </div>
    </>
  );
}
