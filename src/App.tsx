import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Icon, type IconName } from "./Icon";
import Download from "./Download";
import Compress from "./Compress";
import Queue from "./Queue";
import { size } from "./ui";
import type { Entry, Job, NewJob, Progress } from "./types";
import "./App.css";

type Page = "download" | "compress" | "queue" | "history" | "settings";

export default function App() {
  const [page, setPage] = useState<Page>("download");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [history, setHistory] = useState<Entry[]>([]);
  const [dir, setDir] = useState("");
  const [version, setVersion] = useState("");
  const [updating, setUpdating] = useState(false);
  const nextId = useRef(1);

  const patchRunning = (f: (j: Job) => Job) => setJobs((js) => js.map((j) => (j.status === "running" ? f(j) : j)));

  useEffect(() => {
    invoke<Entry[]>("get_history").then(setHistory);
    invoke<string>("get_download_dir").then(setDir);
    invoke<string>("ytdlp_version").then(setVersion);
    const off = [
      listen<Progress>("progress", (e) => patchRunning((j) => ({ ...j, progress: e.payload }))),
      listen<Entry>("done", (e) => {
        patchRunning((j) => ({ ...j, status: "done", entry: e.payload, progress: null }));
        setHistory((h) => [e.payload, ...h]);
      }),
      listen<string>("failed", (e) =>
        patchRunning((j) =>
          e.payload === "Cancelled"
            ? { ...j, status: "cancelled", progress: null }
            : { ...j, status: "failed", error: e.payload, progress: null },
        ),
      ),
    ];
    return () => off.forEach((p) => p.then((f) => f()));
  }, []);

  // The backend runs one job at a time, so the queue hands it the next one whenever nothing is running.
  useEffect(() => {
    if (jobs.some((j) => j.status === "running")) return;
    const next = jobs.find((j) => j.status === "queued");
    if (!next) return;
    setJobs((js) => js.map((j) => (j.id === next.id ? { ...j, status: "running", progress: null } : j)));
    invoke(next.kind === "download" ? "start_download" : "start_compress", { req: next.kind === "download" ? next.req : next.creq }).catch(
      (e) => setJobs((js) => js.map((j) => (j.id === next.id ? { ...j, status: "failed", error: String(e) } : j))),
    );
  }, [jobs]);

  function add(list: NewJob[]) {
    setJobs((js) => [...js, ...list.map((n) => ({ ...n, id: nextId.current++, status: "queued" as const, progress: null }))]);
    setPage("queue");
  }

  const retry = (id: number) => setJobs((js) => js.map((j) => (j.id === id ? { ...j, status: "queued", error: undefined } : j)));
  const clearFinished = () => setJobs((js) => js.filter((j) => j.status === "queued" || j.status === "running"));
  const removeJob = (id: number) => setJobs((js) => js.filter((j) => j.id !== id));

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

  const removeHistory = async (id: number) => setHistory(await invoke<Entry[]>("remove_history", { id }));
  const again = (e: Entry) => {
    if (!e.req) return;
    add([{ kind: "download", title: e.title, label: e.format, req: e.req }]);
  };

  const active = jobs.filter((j) => j.status === "queued" || j.status === "running").length;
  const nav = (p: Page, label: string, icon: IconName, count = 0) => (
    <button className={`nav ${page === p ? "on" : ""}`} onClick={() => setPage(p)}>
      <Icon name={icon} />
      {label}
      {count > 0 && <em>{count}</em>}
    </button>
  );

  return (
    <div className="app">
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
          <Download dir={dir} onChangeDir={changeDir} onAdd={add} />
        </div>
        <div hidden={page !== "compress"}>
          <Compress dir={dir} onChangeDir={changeDir} onAdd={add} />
        </div>

        {page === "queue" && <Queue jobs={jobs} onRemove={removeJob} onRetry={retry} onClear={clearFinished} />}

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
                        {h.format}, {h.from_size ? `${size(h.from_size)} to ${size(h.size)}` : size(h.size)},{" "}
                        {new Date(h.at).toLocaleDateString()}
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
                    <button className="icon" aria-label="Remove from history" onClick={() => removeHistory(h.id)}>
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
