import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Icon } from "./Icon";
import "./App.css";

type Stream = {
  id: string;
  label: string;
  size: number | null;
  codec: string;
  codec_name: string;
  audio_codec: string | null;
  audio_name: string | null;
};
type Info = {
  title: string;
  thumbnail: string | null;
  uploader: string | null;
  duration: number | null;
  videos: Stream[];
  audios: Stream[];
};
type Req = {
  url: string;
  title: string;
  video: string | null;
  audio: string | null;
  vc: string | null;
  ac: string | null;
  preset: string;
  duration: number | null;
  label: string;
};
type Entry = {
  id: number;
  title: string;
  format: string;
  path: string;
  size: number;
  at: number;
  req: Req | null;
};
type Plan = {
  video: "copy" | "convert" | "none";
  audio: "copy" | "convert" | "none";
  video_to: string;
  audio_to: string;
  ext: string;
};
type Progress = { stage: "download" | "convert"; percent: number; speed: number | null; eta: number | null };
type Page = "download" | "history" | "settings";

const PRESETS = [
  { id: "ae", name: "After Effects ready", sub: "H.264 MP4" },
  { id: "prores", name: "ProRes 422", sub: "MOV" },
  { id: "keep", name: "Keep original", sub: "No conversion" },
  { id: "mp3", name: "MP3", sub: "Audio only" },
];

const size = (b: number | null) =>
  b == null ? "" : b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`;
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

function Pick({
  title,
  items,
  value,
  onChange,
  disabled,
}: {
  title: string;
  items: Stream[];
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
}) {
  const row = (id: string | null, label: string, sz?: number | null) => (
    <button
      key={id ?? "none"}
      className="fmt"
      role="radio"
      aria-checked={value === id}
      disabled={disabled}
      onClick={() => onChange(id)}
    >
      <Icon name={value === id ? "circleCheck" : "circle"} size={18} />
      <span className="n">{label}</span>
      <small>{size(sz ?? null)}</small>
    </button>
  );
  return (
    <div className="col">
      <div className="colhead">{title}</div>
      <div className="fmts" role="radiogroup" aria-label={title}>
        {row(null, "None")}
        {items.map((s) => row(s.id, s.label, s.size))}
      </div>
    </div>
  );
}

export default function App() {
  const [page, setPage] = useState<Page>("download");
  const [tab, setTab] = useState<"formats" | "advanced">("formats");
  const [merge, setMerge] = useState(false);
  const [url, setUrl] = useState("");
  const [info, setInfo] = useState<Info | null>(null);
  const [vid, setVid] = useState<string | null>(null);
  const [aid, setAid] = useState<string | null>(null);
  const [preset, setPreset] = useState("ae");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [fetching, setFetching] = useState(false);
  const [job, setJob] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [saved, setSaved] = useState<Entry | null>(null);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<Entry[]>([]);
  const [dir, setDir] = useState("");
  const [version, setVersion] = useState("");
  const [updating, setUpdating] = useState(false);

  const vs = info?.videos.find((s) => s.id === vid) ?? null;
  const as = info?.audios.find((s) => s.id === aid) ?? null;
  const vc = vs?.codec ?? null;
  const ac = vs ? vs.audio_codec : (as?.codec ?? null);
  const defAudio = info?.audios.find((s) => s.codec === "aac") ?? info?.audios[0] ?? null;
  const heightOf = (s: Stream) => s.label.split(" ")[0];
  const heights = info?.videos.filter((s, i, a) => a.findIndex((x) => heightOf(x) === heightOf(s)) === i) ?? [];

  useEffect(() => {
    invoke<Entry[]>("get_history").then(setHistory);
    invoke<string>("get_download_dir").then(setDir);
    invoke<string>("ytdlp_version").then(setVersion);
    const off = [
      listen<Progress>("progress", (e) => setProgress(e.payload)),
      listen<Entry>("done", (e) => {
        setBusy(false);
        setSaved(e.payload);
        setHistory((h) => [e.payload, ...h]);
      }),
      listen<string>("failed", (e) => {
        setBusy(false);
        setProgress(null);
        setError(e.payload);
      }),
    ];
    return () => off.forEach((p) => p.then((f) => f()));
  }, []);

  useEffect(() => {
    if (!vid && preset !== "mp3" && !aid) return;
    invoke<Plan>("convert_plan", { preset, vc, ac }).then(setPlan);
  }, [preset, vc, ac, vid, aid]);

  async function fetchInfo() {
    if (!url.trim() || fetching) return;
    setFetching(true);
    setError("");
    setSaved(null);
    setInfo(null);
    setMerge(false);
    try {
      const i = await invoke<Info>("fetch_info", { url: url.trim() });
      const v = i.videos.find((s) => s.codec === "h264") ?? i.videos[0] ?? null;
      setInfo(i);
      setVid(v?.id ?? null);
      setAid(v?.audio_codec ? null : (i.audios.find((s) => s.codec === "aac") ?? i.audios[0] ?? null)?.id ?? null);
      setPreset(v ? "ae" : "mp3");
    } catch (e) {
      setError(String(e));
    }
    setFetching(false);
  }

  async function start(req: Req) {
    setError("");
    setSaved(null);
    setProgress(null);
    setJob(req.title);
    setBusy(true);
    try {
      await invoke("start_download", { req });
    } catch (e) {
      setBusy(false);
      setError(String(e));
    }
  }

  function download() {
    if (!info || !plan) return;
    const h = vs ? vs.label.split(" ")[0] : "";
    start({
      url: url.trim(),
      title: info.title,
      video: vid,
      audio: vs?.audio_codec ? null : aid,
      vc,
      ac,
      preset,
      duration: info.duration,
      label: [h, plan.ext ? plan.ext.toUpperCase() : (vs ?? as)?.codec_name].filter(Boolean).join(" "),
    });
  }

  function redownload(e: Entry) {
    if (!e.req) return;
    setPage("download");
    start(e.req);
  }

  function pickVideo(id: string | null) {
    const s = info?.videos.find((x) => x.id === id);
    setVid(id);
    if (s?.audio_codec) setAid(null);
    if (id && preset === "mp3") setPreset("ae");
    if (!id && preset !== "mp3") setPreset("mp3");
  }

  function pickHeight(s: Stream) {
    setVid(s.id);
    setAid(s.audio_codec ? null : (defAudio?.id ?? null));
    if (preset === "mp3") setPreset("ae");
  }

  function toggleMerge(on: boolean) {
    setMerge(on);
    const s = vs && heights.find((h) => heightOf(h) === heightOf(vs));
    if (!on && s) pickHeight(s);
  }

  async function changeDir() {
    const d = await open({ directory: true, defaultPath: dir });
    if (typeof d === "string") {
      await invoke("set_download_dir", { dir: d });
      setDir(d);
    }
  }

  async function update() {
    setUpdating(true);
    setVersion(await invoke<string>("update_ytdlp"));
    setUpdating(false);
  }

  const remove = async (id: number) => setHistory(await invoke<Entry[]>("remove_history", { id }));

  const summary = plan
    ? [
        plan.video !== "none" && vs
          ? plan.video === "copy"
            ? `${vs.codec_name} kept`
            : `${vs.codec_name} to ${plan.video_to || "H.264"}`
          : "",
        plan.audio !== "none" && (vs?.audio_name ?? as?.codec_name)
          ? plan.audio === "copy"
            ? `${vs?.audio_name ?? as?.codec_name} kept`
            : `${vs?.audio_name ?? as?.codec_name} to ${plan.audio_to || "AAC"}`
          : "",
      ]
        .filter(Boolean)
        .join(", ")
    : "";

  const nav = (p: Page, label: string, icon: "download" | "history" | "sliders") => (
    <button className={`nav ${page === p ? "on" : ""}`} onClick={() => setPage(p)}>
      <Icon name={icon} />
      {label}
      {p === "history" && history.length > 0 && <em>{history.length}</em>}
    </button>
  );

  return (
    <div className="app">
      <aside>
        <div className="brand">Cobble</div>
        {nav("download", "Download", "download")}
        {nav("history", "History", "history")}
        <div className="spacer" />
        {nav("settings", "Settings", "sliders")}
      </aside>

      <main>
        {page === "download" && (
          <>
            <form
              className="url"
              onSubmit={(e) => {
                e.preventDefault();
                fetchInfo();
              }}
            >
              <Icon name="link" size={17} />
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onPaste={() => setTimeout(fetchInfo, 0)}
                placeholder="Paste a link"
                spellCheck={false}
                autoFocus
              />
              {fetching && <span className="spin" aria-label="Loading" />}
            </form>

            {error && (
              <p className="error">
                <Icon name="alert" />
                {error}
              </p>
            )}

            {job && (busy || saved) && (
              <div className="job">
                <div className="titles">
                  <div className="t">{job}</div>
                  <div className="s">
                    {busy
                      ? `${progress?.stage === "convert" ? "Converting" : "Downloading"} ${Math.round(progress?.percent ?? 0)}%${
                          progress?.speed ? `, ${(progress.speed / 1e6).toFixed(1)} MB/s` : ""
                        }${progress?.eta != null ? `, ${clock(progress.eta)} left` : ""}`
                      : `Saved, ${size(saved!.size)}`}
                  </div>
                  {busy && (
                    <div className="bar">
                      <i style={{ width: `${progress?.percent ?? 0}%` }} />
                    </div>
                  )}
                </div>
                {busy ? (
                  <button className="ghost" onClick={() => invoke("cancel_download")}>
                    Cancel
                  </button>
                ) : (
                  <button className="ghost" onClick={() => revealItemInDir(saved!.path)}>
                    <Icon name="folder" /> Show file
                  </button>
                )}
              </div>
            )}

            {info && (
              <>
                <div className="head">
                  <div className="thumb">
                    {info.thumbnail ? <img src={info.thumbnail} alt="" /> : <Icon name="play" size={20} />}
                  </div>
                  <div className="titles">
                    <div className="t">{info.title}</div>
                    <div className="s">
                      {[info.uploader, info.duration ? clock(info.duration) : null].filter(Boolean).join(", ")}
                    </div>
                  </div>
                </div>

                <div className="tabs" role="tablist">
                  {(["formats", "advanced"] as const).map((t) => (
                    <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
                      {t === "formats" ? "Formats" : "Advanced"}
                    </button>
                  ))}
                  {tab === "formats" && (
                    <label className="merge">
                      <input
                        type="checkbox"
                        checked={merge}
                        disabled={busy}
                        onChange={(e) => toggleMerge(e.target.checked)}
                      />
                      Merge tracks
                    </label>
                  )}
                </div>

                {tab === "formats" && !merge ? (
                  <div className="fmts" role="radiogroup" aria-label="Quality">
                    {heights.map((s) => {
                      const on = !!vs && heightOf(vs) === heightOf(s);
                      return (
                        <button
                          key={s.id}
                          className="fmt"
                          role="radio"
                          aria-checked={on}
                          disabled={busy}
                          onClick={() => pickHeight(s)}
                        >
                          <Icon name={on ? "circleCheck" : "circle"} size={18} />
                          <span className="n">{heightOf(s)}</span>
                          <small>
                            {size(s.size == null ? null : s.size + (s.audio_codec ? 0 : (defAudio?.size ?? 0)))}
                          </small>
                        </button>
                      );
                    })}
                    {defAudio && (
                      <button
                        className="fmt"
                        role="radio"
                        aria-checked={!vid}
                        disabled={busy}
                        onClick={() => {
                          pickVideo(null);
                          setAid(defAudio.id);
                        }}
                      >
                        <Icon name={!vid ? "circleCheck" : "circle"} size={18} />
                        <span className="n">Audio only</span>
                        <small>{size(defAudio.size)}</small>
                      </button>
                    )}
                  </div>
                ) : tab === "formats" ? (
                  <div className="cols">
                    <Pick title="Video" items={info.videos} value={vid} onChange={pickVideo} disabled={busy} />
                    <Pick
                      title="Audio"
                      items={info.audios}
                      value={vs?.audio_codec ? null : aid}
                      onChange={setAid}
                      disabled={busy || !!vs?.audio_codec}
                    />
                  </div>
                ) : (
                  <div className="fmts" role="radiogroup" aria-label="Output">
                    {PRESETS.filter((p) => p.id !== "mp3" || !vid).map((p) => (
                      <button
                        key={p.id}
                        className="fmt"
                        role="radio"
                        aria-checked={preset === p.id}
                        disabled={busy}
                        onClick={() => setPreset(p.id)}
                      >
                        <Icon name={preset === p.id ? "circleCheck" : "circle"} size={18} />
                        <span className="n">{p.name}</span>
                        <small>{p.sub}</small>
                      </button>
                    ))}
                  </div>
                )}

                <div className="foot">
                  <button className="dest" onClick={changeDir} disabled={busy} title="Change folder">
                    <Icon name="folder" />
                    {dir.split("\\").pop()}
                  </button>
                  <small className="sum">{summary}</small>
                  <button className="go" onClick={download} disabled={busy || (!vid && !aid)}>
                    Download
                  </button>
                </div>
              </>
            )}
          </>
        )}

        {page === "history" && (
          <>
            <h1>History</h1>
            {history.length === 0 ? (
              <p className="empty">Finished downloads show up here.</p>
            ) : (
              <div className="list">
                {history.map((h) => (
                  <div className="row" key={h.id}>
                    <div className="titles">
                      <div className="t">{h.title}</div>
                      <div className="s">
                        {h.format}, {size(h.size)}, {new Date(h.at).toLocaleDateString()}
                      </div>
                    </div>
                    {h.req && (
                      <button className="icon" aria-label="Download again" disabled={busy} onClick={() => redownload(h)}>
                        <Icon name="refresh" />
                      </button>
                    )}
                    <button className="icon" aria-label="Show in folder" onClick={() => revealItemInDir(h.path)}>
                      <Icon name="folder" />
                    </button>
                    <button className="icon" aria-label="Remove from history" onClick={() => remove(h.id)}>
                      <Icon name="trash" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {page === "settings" && (
          <>
            <h1>Settings</h1>
            <div className="list">
              <div className="row">
                <div className="titles">
                  <div className="t">Download folder</div>
                  <div className="s">{dir}</div>
                </div>
                <button className="ghost" onClick={changeDir}>
                  Change
                </button>
              </div>
              <div className="row">
                <div className="titles">
                  <div className="t">yt-dlp</div>
                  <div className="s">{version || "..."}</div>
                </div>
                <button className="ghost" onClick={update} disabled={updating}>
                  {updating ? "Updating..." : "Update"}
                </button>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
