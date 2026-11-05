import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Icon, type IconName } from "./Icon";
import Download from "./Download";
import Compress from "./Compress";
import Queue from "./Queue";
import TitleBar from "./TitleBar";
import { QUALITY, Seg, Thumb, day, loadPrefs, looksLikeLink, savePrefs, size, useLeave, type Prefs } from "./ui";
import type { Entry, Job, NewJob, Progress } from "./types";
import "./App.css";

type Toast = { id: number; closing?: boolean; icon: IconName; text: string; action?: { label: string; run: () => void } };

type Page = "download" | "compress" | "queue" | "history" | "settings";

export default function App() {
  const [page, setPage] = useState<Page>("download");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [history, setHistory] = useState<Entry[]>([]);
  const [dir, setDir] = useState("");
  const [version, setVersion] = useState("");
  const [updating, setUpdating] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [leaving, leave] = useLeave();
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const setPref = (p: Partial<Prefs>) => {
    const n = { ...prefs, ...p };
    setPrefs(n);
    savePrefs(n);
  };
  const [incoming, setIncoming] = useState<{ url: string; n: number } | null>(null);
  // The last link the Download box held or the clipboard offered, so the same one is not offered twice.
  const seen = useRef("");
  const nextId = useRef(1);
  const nextToast = useRef(1);

  // Marks the toast as closing so it can fade out, then removes it once the animation has run.
  const dismiss = useCallback((id: number) => {
    setToasts((ts) => ts.map((t) => (t.id === id ? { ...t, closing: true } : t)));
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 180);
  }, []);
  const toast = useCallback((t: Omit<Toast, "id">, ms = 5000) => {
    const id = nextToast.current++;
    setToasts((ts) => [...ts, { ...t, id }]);
    setTimeout(() => dismiss(id), ms);
  }, [dismiss]);

  const live = (j: Job) => j.status === "running" || j.status === "cancelling";
  const patchRunning = (f: (j: Job) => Job) => setJobs((js) => js.map((j) => (live(j) ? f(j) : j)));

  useEffect(() => {
    invoke<Entry[]>("get_history").then(setHistory);
    invoke<string>("get_download_dir").then(setDir);
    invoke<string>("ytdlp_version").then(async (v) => {
      setVersion(v);
      // Release tags are dates (2026.03.17), so a plain string compare orders them. A failed check stays silent.
      try {
        const latest: string = (await (await fetch("https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest")).json()).tag_name;
        if (latest > v) toast({ icon: "download", text: `yt-dlp ${latest} is available`, action: { label: "Update", run: update } }, 15000);
      } catch {}
    });
    // App update. No update, no network or a failed install all stay silent.
    (async () => {
      try {
        const u = await check();
        if (!u) return;
        const notes = u.body ? `\n\n${u.body}` : "";
        if (!(await ask(`Cobble ${u.version} is available.${notes}`, { title: "Update available", okLabel: "Update", cancelLabel: "Later" }))) return;
        await u.downloadAndInstall();
        await relaunch();
      } catch {}
    })();
    const off = [
      listen<Progress>("progress", (e) =>
        patchRunning((j) => (j.status === "cancelling" ? j : { ...j, progress: e.payload })),
      ),
      listen<Entry>("done", (e) => {
        patchRunning((j) => ({ ...j, status: "done", entry: e.payload, progress: null, endedAt: Date.now() }));
        setHistory((h) => [e.payload, ...h]);
        toast({
          icon: "circleCheck",
          text: `Finished: ${e.payload.title}`,
          action: { label: "Show", run: () => revealItemInDir(e.payload.path) },
        });
      }),
      listen<string>("failed", (e) =>
        patchRunning((j) =>
          e.payload === "Cancelled"
            ? { ...j, status: "cancelled", progress: null, endedAt: Date.now() }
            : { ...j, status: "failed", error: e.payload, progress: null, endedAt: Date.now() },
        ),
      ),
    ];
    return () => off.forEach((p) => p.then((f) => f()));
  }, []);

  const loadLink = useCallback((url: string) => {
    setPage("download");
    setIncoming((i) => ({ url, n: (i?.n ?? 0) + 1 }));
  }, []);

  // Offer a copied link when the window gets focus. A blocked or empty clipboard stays silent.
  useEffect(() => {
    const onFocus = async () => {
      try {
        // The native plugin, because the webview's own clipboard API asks for permission every launch.
        const t = ((await readText()) ?? "").trim();
        if (!looksLikeLink(t) || t === seen.current) return;
        seen.current = t;
        toast({ icon: "link", text: "Load the link you copied?", action: { label: "Load", run: () => loadLink(t) } }, 10000);
      } catch {}
    };
    // Ctrl+V outside a text field loads the link. Ctrl+1 to 5 switch pages.
    const onPaste = (e: ClipboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest("input, textarea")) return;
      const t = e.clipboardData?.getData("text").trim() ?? "";
      if (looksLikeLink(t)) loadLink(t);
    };
    const pages: Page[] = ["download", "compress", "queue", "history", "settings"];
    const onKey = (e: KeyboardEvent) => {
      const p = pages[Number(e.key) - 1];
      if (e.ctrlKey && !e.shiftKey && !e.altKey && p) {
        e.preventDefault();
        setPage(p);
      }
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("paste", onPaste);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("paste", onPaste);
      window.removeEventListener("keydown", onKey);
    };
  }, [toast, loadLink]);

  // The backend runs one job at a time, so the queue hands it the next one whenever nothing is running.
  useEffect(() => {
    if (jobs.some(live)) return;
    const next = jobs.find((j) => j.status === "queued");
    if (!next) return;
    setJobs((js) => js.map((j) => (j.id === next.id ? { ...j, status: "running", progress: null } : j)));
    invoke(next.kind === "download" ? "start_download" : "start_compress", { req: next.kind === "download" ? next.req : next.creq }).catch(
      (e) => setJobs((js) => js.map((j) => (j.id === next.id ? { ...j, status: "failed", error: String(e), endedAt: Date.now() } : j))),
    );
  }, [jobs]);

  function add(list: NewJob[]) {
    setJobs((js) => [...js, ...list.map((n) => ({ ...n, id: nextId.current++, status: "queued" as const, progress: null }))]);
    setPage("queue");
  }

  const retry = (id: number) => setJobs((js) => js.map((j) => (j.id === id ? { ...j, status: "queued", error: undefined } : j)));
  const clearFinished = () => setJobs((js) => js.filter((j) => j.status === "queued" || live(j)));
  // Shows "Cancelling" at once. The backend answers with a "failed: Cancelled" event once the process tree is gone.
  const cancel = (id: number) => {
    setJobs((js) => js.map((j) => (j.id === id ? { ...j, status: "cancelling", progress: null } : j)));
    invoke("cancel_download");
  };
  const removeJob = (id: number) => setJobs((js) => js.filter((j) => j.id !== id));
  // Waiting jobs are cancelled outright; the running one goes through the normal cancel.
  const cancelAll = () => {
    const running = jobs.some((j) => j.status === "running");
    setJobs((js) =>
      js.map((j) =>
        j.status === "queued"
          ? { ...j, status: "cancelled", endedAt: Date.now() }
          : j.status === "running"
            ? { ...j, status: "cancelling", progress: null }
            : j,
      ),
    );
    if (running) invoke("cancel_download");
  };
  // Moves a waiting job in front of the other waiting jobs.
  const runNext = (id: number) =>
    setJobs((js) => {
      const j = js.find((x) => x.id === id)!;
      const rest = js.filter((x) => x.id !== id);
      const i = rest.findIndex((x) => x.status === "queued");
      rest.splice(i < 0 ? rest.length : i, 0, j);
      return rest;
    });

  async function changeDir() {
    const d = await open({ directory: true, defaultPath: dir });
    if (typeof d === "string") {
      await invoke("set_download_dir", { dir: d });
      setDir(d);
    }
  }

  async function update() {
    setUpdating(true);
    const v = await invoke<string>("update_ytdlp");
    setVersion(v);
    setUpdating(false);
    toast({ icon: "circleCheck", text: `yt-dlp updated to ${v}` });
  }

  const removeHistory = async (id: number) => setHistory(await invoke<Entry[]>("remove_history", { id }));
  const again = (e: Entry) => {
    if (!e.req) return;
    add([{ kind: "download", title: e.title, label: e.format, req: e.req }]);
  };

  const active = jobs.filter((j) => j.status === "queued" || live(j)).length;

  // When a batch of two or more finishes, say so once and point at the last file.
  const batch = useRef({ active: 0, start: 0 });
  useEffect(() => {
    const b = batch.current;
    if (active > 0 && b.active === 0) b.start = Date.now();
    if (active === 0 && b.active > 0) {
      const done = jobs.filter((j) => j.status === "done" && j.entry && (j.endedAt ?? 0) >= b.start);
      if (done.length > 1)
        toast({
          icon: "circleCheck",
          text: `All ${done.length} finished`,
          action: { label: "Show", run: () => revealItemInDir(done[done.length - 1].entry!.path) },
        });
    }
    b.active = active;
  }, [active]);

  const nav = (p: Page, label: string, icon: IconName, count = 0) => (
    <button className={`nav ${page === p ? "on" : ""}`} onClick={() => setPage(p)}>
      <Icon name={icon} />
      {label}
      {count > 0 && <em>{count}</em>}
    </button>
  );

  return (
    <div className="app">
      <TitleBar />
      <div className="body">
      <aside>
        <div className="brand">Cobble</div>
        {nav("download", "Download", "download")}
        {nav("compress", "Compress", "compress")}
        {nav("queue", "Queue", "list", active)}
        {nav("history", "History", "history", history.length)}
        <div className="spacer" />
        {nav("settings", "Settings", "sliders")}
      </aside>

      <main>
        {/* Kept mounted so a fetched link or picked files survive a trip to another page. */}
        <div hidden={page !== "download"}>
          <Download
            dir={dir}
            onChangeDir={changeDir}
            onAdd={add}
            incoming={incoming}
            prefs={prefs}
            onLink={(u) => {
              if (u) seen.current = u;
            }}
          />
        </div>
        <div hidden={page !== "compress"}>
          <Compress dir={dir} onChangeDir={changeDir} onAdd={add} />
        </div>

        {page === "queue" && (
          <Queue
            jobs={jobs}
            onCancel={cancel}
            onCancelAll={cancelAll}
            onRemove={removeJob}
            onRetry={retry}
            onRunNext={runNext}
            onClear={clearFinished}
          />
        )}

        {page === "history" && (
          <>
            <h1>History</h1>
            {history.length === 0 ? (
              <p className="empty">Finished downloads show up here.</p>
            ) : (
              <div className="list">
                {history.map((h) => (
                  <div className={`row ${leaving.has(h.id) ? "leaving" : ""}`} key={h.id}>
                    <Thumb path={h.path} />
                    <div className="titles">
                      <div className="t">{h.title}</div>
                      <div className="s">
                        {h.format}, {h.from_size ? `${size(h.from_size)} to ${size(h.size)}` : size(h.size)},{" "}
                        {day(h.at)}
                      </div>
                    </div>
                    {h.req && (
                      <button className="icon" aria-label="Download again" onClick={() => again(h)}>
                        <Icon name="refresh" />
                      </button>
                    )}
                    <button className="icon" aria-label="Show in folder" onClick={() => revealItemInDir(h.path)}>
                      <Icon name="folder" />
                    </button>
                    <button className="icon" aria-label="Remove from history" onClick={() => leave(h.id, () => removeHistory(h.id))}>
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
                  <div className="s">{version || <span className="spin" aria-label="Loading" />}</div>
                </div>
                <button className="ghost" onClick={update} disabled={updating}>
                  {updating ? "Updating..." : "Update"}
                </button>
              </div>
            </div>
            <div className="settings">
              <Seg
                label="Default output"
                value={prefs.preset}
                onChange={(preset) => setPref({ preset })}
                options={[
                  { value: "ae", text: "After Effects ready" },
                  { value: "prores", text: "ProRes 422" },
                  { value: "keep", text: "Keep original" },
                ]}
              />
              <Seg label="Default quality" value={prefs.quality} onChange={(quality) => setPref({ quality })} options={QUALITY} />
              <div className="setting">
                <div className="colhead">Filename</div>
                <div className="url tpl">
                  <input
                    value={prefs.template}
                    onChange={(e) => setPref({ template: e.target.value })}
                    placeholder="{title}"
                    spellCheck={false}
                    aria-label="Filename template"
                  />
                </div>
                <small className="hint">Use {"{title}"}, {"{uploader}"} and {"{date}"}. Without {"{title}"}, the video id is added.</small>
              </div>
            </div>
          </>
        )}
      </main>
      </div>

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div className={`toast ${t.closing ? "out" : ""}`} key={t.id}>
            <Icon name={t.icon} />
            <span>{t.text}</span>
            {t.action && (
              <button
                className="ghost"
                onClick={() => {
                  t.action!.run();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            <button className="icon" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              <Icon name="x" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
