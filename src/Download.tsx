import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Icon } from "./Icon";
import { QUALITY, Seg, clock, looksLikeLink, size, type Prefs } from "./ui";
import type { Brief, Info, NewJob, Plan, Req, Stream } from "./types";

const PRESETS = [
  { id: "ae", name: "After Effects ready", sub: "H.264 MP4" },
  { id: "prores", name: "ProRes 422", sub: "MOV" },
  { id: "keep", name: "Keep original", sub: "No conversion" },
  { id: "mp3", name: "MP3", sub: "Audio only" },
];

const NOT_A_LINK = "That doesn't look like a link. It should start with https://";

const heightOf =(s: Stream) => s.label.split(" ")[0];

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

export default function Download({
  dir,
  onChangeDir,
  onAdd,
  incoming,
  onLink,
  prefs,
}: {
  prefs: Prefs;
  dir: string;
  onChangeDir: () => void;
  onAdd: (jobs: NewJob[]) => void;
  // A link handed in from outside (clipboard, Ctrl+V). `n` changes on every send, so the same link can arrive twice.
  incoming: { url: string; n: number } | null;
  onLink: (url: string) => void;
}) {
  const [tab, setTab] = useState<"formats" | "advanced">("formats");
  const [merge, setMerge] = useState(false);
  const [url, setUrl] = useState("");
  const [info, setInfo] = useState<Info | null>(null);
  const [vid, setVid] = useState<string | null>(null);
  const [aid, setAid] = useState<string | null>(null);
  const [preset, setPreset] = useState("ae");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState("");
  const [quality, setQuality] = useState("best");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [check, setCheck] = useState<"idle" | "checking" | "ok" | "bad">("idle");
  const [brief, setBrief] = useState<Brief | null>(null);
  const latest = useRef("");

  const isList = !!info && info.entries.length > 0;
  const vs = info?.videos.find((s) => s.id === vid) ?? null;
  const as = info?.audios.find((s) => s.id === aid) ?? null;
  const vc = vs?.codec ?? null;
  const ac = vs ? vs.audio_codec : (as?.codec ?? null);
  const defAudio = info?.audios.find((s) => s.codec === "aac") ?? info?.audios[0] ?? null;
  const heights = info?.videos.filter((s, i, a) => a.findIndex((x) => heightOf(x) === heightOf(s)) === i) ?? [];
  const mixedList = /[?&]list=/.test(url) && /[?&]v=/.test(url);
  const listOnly = /[?&]list=/.test(url) && !/[?&]v=/.test(url);
  const head = info ?? (listOnly ? null : brief);

  useEffect(() => {
    if (!info || isList || (!vid && !aid)) return;
    invoke<Plan>("convert_plan", { preset, vc, ac }).then(setPlan);
  }, [preset, vc, ac, vid, aid, info, isList]);

  // Any edit drops the previous result and check, so what is on screen always matches the box.
  function edit(v: string) {
    latest.current = v;
    onLink(v);
    setUrl(v);
    setInfo(null);
    setBrief(null);
    setError("");
    setCheck("idle");
  }

  // Confirms the link is readable by yt-dlp and loads name, duration and thumbnail; formats load on submit.
  async function checkLink(link: string) {
    if (!looksLikeLink(link)) {
      setCheck("bad");
      setError(NOT_A_LINK);
      return false;
    }
    setCheck("checking");
    try {
      const b = await invoke<Brief>("check_link", { url: link });
      if (latest.current !== link) return false;
      setBrief(b);
      setCheck("ok");
      return true;
    } catch (e) {
      if (latest.current === link) {
        setCheck("bad");
        setError(String(e));
      }
      return false;
    }
  }

  useEffect(() => {
    if (!incoming) return;
    edit(incoming.url);
    checkLink(incoming.url);
  }, [incoming]);

  // Enter and the button wait for the check: blocked while it runs or after it failed, and run it first if the link was typed.
  // Enter again once the formats are loaded adds the download.
  async function submit() {
    const link = url.trim();
    if (!link || fetching || check === "checking" || check === "bad") return;
    if (info) return isList ? addList() : addSingle();
    if (check === "idle" && !(await checkLink(link))) return;
    fetchInfo();
  }

  // The default quality picks the tallest video at or under the chosen height, preferring H.264. "Audio only" picks none.
  function defaultVideo(i: Info) {
    if (prefs.quality === "audio" && i.audios.length) return null;
    const max = Number(prefs.quality);
    const h = (s: Stream) => parseInt(heightOf(s));
    const fit = max ? i.videos.filter((s) => h(s) <= max) : [];
    const top = fit.length ? Math.max(...fit.map(h)) : 0;
    const pool = top ? fit.filter((s) => h(s) === top) : i.videos;
    return pool.find((s) => s.codec === "h264") ?? pool[0] ?? null;
  }

  async function fetchInfo(playlist = false) {
    const link = url.trim();
    if (!link || fetching) return;
    setError("");
    setInfo(null);
    // Reject text that is not a web link before spending seconds on yt-dlp. fetch_info then confirms the site really serves it.
    if (!looksLikeLink(link)) {
      setCheck("bad");
      setError(NOT_A_LINK);
      return;
    }
    const wantList = playlist || (/[?&]list=/.test(link) && !/[?&]v=/.test(link));
    setFetching(true);
    setMerge(false);
    try {
      const i = await invoke<Info>("fetch_info", { url: link, playlist: wantList });
      setCheck("ok");
      setInfo(i);
      if (i.entries.length > 0) {
        setPicked(new Set(i.entries.map((e) => e.url)));
        setQuality(prefs.quality);
        setPreset(prefs.quality === "audio" && prefs.preset === "prores" ? "ae" : prefs.preset);
      } else {
        const v = defaultVideo(i);
        setVid(v?.id ?? null);
        setAid(v?.audio_codec ? null : (i.audios.find((s) => s.codec === "aac") ?? i.audios[0] ?? null)?.id ?? null);
        setPreset(v ? prefs.preset : "mp3");
      }
    } catch (e) {
      setCheck("bad");
      setError(String(e));
    }
    setFetching(false);
  }

  function pickHeight(s: Stream) {
    setVid(s.id);
    setAid(s.audio_codec ? null : (defAudio?.id ?? null));
    if (preset === "mp3") setPreset("ae");
  }

  function pickVideo(id: string | null) {
    const s = info?.videos.find((x) => x.id === id);
    setVid(id);
    if (s?.audio_codec) setAid(null);
    if (id && preset === "mp3") setPreset("ae");
    if (!id && preset !== "mp3") setPreset("mp3");
  }

  function toggleMerge(on: boolean) {
    setMerge(on);
    const s = vs && heights.find((h) => heightOf(h) === heightOf(vs));
    if (!on && s) pickHeight(s);
  }

  const reset = () => edit("");

  function addSingle() {
    if (!info || !plan) return;
    const label = [vs ? heightOf(vs) : "", plan.ext ? plan.ext.toUpperCase() : (vs ?? as)?.codec_name]
      .filter(Boolean)
      .join(" ");
    const req: Req = {
      url: url.trim(),
      title: info.title,
      video: vid,
      audio: vs?.audio_codec ? null : aid,
      selector: null,
      vc,
      ac,
      preset,
      duration: info.duration,
      label,
      template: prefs.template,
    };
    onAdd([{ kind: "download", title: info.title, label, req, thumb: info.thumbnail, author: info.uploader, duration: info.duration }]);
    reset();
  }

  function addList() {
    if (!info) return;
    const audio = quality === "audio";
    const selector =
      audio ? "ba/b" : quality === "best" ? "bv*+ba/b" : `bv*[height<=${quality}]+ba/b[height<=${quality}]`;
    const ext = preset === "ae" ? (audio ? "M4A" : "MP4") : preset === "prores" ? "MOV" : preset === "mp3" ? "MP3" : "Original";
    const label = `${QUALITY.find((q) => q.value === quality)!.text} ${ext}`;
    const jobs = info.entries
      .filter((e) => picked.has(e.url))
      .map<NewJob>((e) => ({
        kind: "download",
        title: e.title,
        label,
        author: info.uploader,
        duration: e.duration,
        req: {
          url: e.url,
          title: e.title,
          video: null,
          audio: null,
          selector,
          vc: null,
          ac: null,
          preset,
          duration: e.duration,
          label,
          template: prefs.template,
        },
      }));
    if (jobs.length) {
      onAdd(jobs);
      reset();
    }
  }

  function setQ(q: string) {
    setQuality(q);
    if (q === "audio" && (preset === "prores")) setPreset("ae");
    if (q !== "audio" && preset === "mp3") setPreset("ae");
  }

  // Total of the picked tracks. A combined video stream already carries its audio. Blank if any needed size is unknown.
  const parts = [vid ? vs?.size : undefined, aid && !vs?.audio_codec ? as?.size : undefined];
  const needed = [!!vid, !!aid && !vs?.audio_codec];
  const total = needed.some((n, i) => n && parts[i] == null) ? null : parts.reduce<number>((a, p) => a + (p ?? 0), 0);

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

  const outOptions =
    quality === "audio"
      ? [
          { value: "ae", text: "M4A" },
          { value: "mp3", text: "MP3" },
          { value: "keep", text: "Original" },
        ]
      : [
          { value: "ae", text: "After Effects ready" },
          { value: "prores", text: "ProRes 422" },
          { value: "keep", text: "Keep original" },
        ];

  return (
    <>
      <form
        className="url"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Icon name="link" size={17} />
        <input
          value={url}
          onChange={(e) => edit(e.target.value)}
          onPaste={(e) => {
            e.preventDefault();
            const t = e.clipboardData.getData("text").trim();
            edit(t);
            checkLink(t);
          }}
          placeholder="Paste a link or playlist"
          spellCheck={false}
          autoFocus
        />
        {/* Two fixed slots, always rendered, so the spinner, the check and the button never move. */}
        <span className="slot">
          {check === "checking" && <span className="spin" aria-label="Checking link" />}
          {check === "ok" && (
            <span className="state ok" title="Link works">
              <Icon name="circleCheck" size={16} />
            </span>
          )}
          {check === "bad" && (
            <span className="state no" title="Link can't be loaded">
              <Icon name="alert" size={16} />
            </span>
          )}
        </span>
        <span className="slot">
          {fetching ? (
            <span className="spin" aria-label="Loading" />
          ) : (
            <button type="submit" className="submit" aria-label="Load link" disabled={!url.trim() || check === "checking" || check === "bad"}>
              <Icon name="arrow" size={16} />
            </button>
          )}
        </span>
      </form>

      {error && (
        <p className="error">
          <Icon name="alert" />
          {error}
        </p>
      )}

      {info && mixedList && !isList && (
        <button className="link" onClick={() => fetchInfo(true)}>
          This link is part of a playlist. Load the whole playlist
        </button>
      )}

      {fetching && !head && (
        <div className="head" aria-hidden="true">
          <div className="thumb skel" />
          <div className="titles">
            <div className="skel line" style={{ width: "60%" }} />
            <div className="skel line" style={{ width: "30%" }} />
          </div>
        </div>
      )}

      {head && (
        <div className="head">
          <div className="thumb">
            {head.thumbnail ? <img src={head.thumbnail} alt="" /> : <Icon name="play" size={20} />}
          </div>
          <div className="titles">
            <div className="t">{head.title}</div>
            <div className="s">
              {isList
                ? `${info!.entries.length} videos`
                : [head.uploader, head.duration ? clock(head.duration) : null].filter(Boolean).join(", ")}
            </div>
          </div>
        </div>
      )}

      {info && isList && (
        <>
          <div className="settings">
            <Seg label="Quality" options={QUALITY} value={quality} onChange={setQ} />
            <Seg label="Output" options={outOptions} value={preset} onChange={setPreset} />
          </div>
          <div className="listhead">
            <span>
              {picked.size} of {info.entries.length} selected
            </span>
            <button
              className="link"
              onClick={() => setPicked(picked.size ? new Set() : new Set(info.entries.map((e) => e.url)))}
            >
              {picked.size ? "Select none" : "Select all"}
            </button>
          </div>
          <div className="list entries">
            {info.entries.map((e) => (
              <label className="row pick" key={e.url}>
                <input
                  type="checkbox"
                  checked={picked.has(e.url)}
                  onChange={() => {
                    const n = new Set(picked);
                    n.has(e.url) ? n.delete(e.url) : n.add(e.url);
                    setPicked(n);
                  }}
                />
                <span className="n ell">{e.title}</span>
                <small>{e.duration ? clock(e.duration) : ""}</small>
              </label>
            ))}
          </div>
          <div className="foot">
            <button className="dest" onClick={onChangeDir} title="Change folder">
              <Icon name="folder" />
              {dir.split("\\").pop()}
            </button>
            <button className="go" onClick={addList} disabled={picked.size === 0}>
              Add {picked.size} to queue
            </button>
          </div>
        </>
      )}

      {info && !isList && (
        <>
          <div className="tabs" role="tablist">
            {(["formats", "advanced"] as const).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
                {t === "formats" ? "Formats" : "Advanced"}
              </button>
            ))}
            {tab === "formats" && (
              <label className="merge">
                <input type="checkbox" checked={merge} onChange={(e) => toggleMerge(e.target.checked)} />
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
                    onClick={() => pickHeight(s)}
                  >
                    <Icon name={on ? "circleCheck" : "circle"} size={18} />
                    <span className="n">{heightOf(s)}</span>
                    <small>{size(s.size == null ? null : s.size + (s.audio_codec ? 0 : (defAudio?.size ?? 0)))}</small>
                  </button>
                );
              })}
              {defAudio && (
                <button
                  className="fmt"
                  role="radio"
                  aria-checked={!vid}
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
              <Pick title="Video" items={info.videos} value={vid} onChange={pickVideo} />
              <Pick
                title="Audio"
                items={info.audios}
                value={vs?.audio_codec ? null : aid}
                onChange={setAid}
                disabled={!!vs?.audio_codec}
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
            <button className="dest" onClick={onChangeDir} title="Change folder">
              <Icon name="folder" />
              {dir.split("\\").pop()}
            </button>
            <small className="sum">
              {total ? <b>{size(total)}</b> : null}
              {total && summary ? ", " : ""}
              {summary}
            </small>
            <button className="go" onClick={addSingle} disabled={!vid && !aid}>
              Download
            </button>
          </div>
        </>
      )}
    </>
  );
}
