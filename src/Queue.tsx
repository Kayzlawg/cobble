import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Icon } from "./Icon";
import { clock, size } from "./ui";
import type { Job } from "./types";

function status(j: Job) {
  const p = j.progress;
  switch (j.status) {
    case "queued":
      return "Waiting";
    case "running": {
      const verb = p?.stage === "download" ? "Downloading" : p?.stage === "compress" ? "Compressing" : p?.stage === "convert" ? "Converting" : "Starting";
      const bits = [p ? `${Math.round(p.percent)}%` : "", p?.speed ? `${(p.speed / 1e6).toFixed(1)} MB/s` : "", p?.eta != null ? `${clock(p.eta)} left` : ""];
      return [verb, ...bits.filter(Boolean)].join(", ");
    }
    case "done": {
      const e = j.entry;
      return e?.from_size ? `Done, ${size(e.from_size)} to ${size(e.size)}` : `Done, ${size(e?.size ?? null)}`;
    }
    case "cancelled":
      return "Cancelled";
    case "failed":
      return j.error || "Failed";
  }
}

export default function Queue({
  jobs,
  onRemove,
  onRetry,
  onClear,
}: {
  jobs: Job[];
  onRemove: (id: number) => void;
  onRetry: (id: number) => void;
  onClear: () => void;
}) {
  const finished = jobs.some((j) => j.status === "done" || j.status === "failed" || j.status === "cancelled");
  return (
    <>
      <div className="pagehead">
        <h1>Queue</h1>
        {finished && (
          <button className="link" onClick={onClear}>
            Clear finished
          </button>
        )}
      </div>
      {jobs.length === 0 ? (
        <p className="empty">Downloads and compressions you add show up here.</p>
      ) : (
        <div className="list">
          {jobs.map((j) => (
            <div className="row" key={j.id}>
              <div className="titles">
                <div className="t">{j.title}</div>
                <div className={`s ${j.status === "failed" ? "bad" : ""}`}>
                  {j.label}, {status(j)}
                </div>
                {j.status === "running" && (
                  <div className="bar">
                    <i style={{ width: `${j.progress?.percent ?? 0}%` }} />
                  </div>
                )}
              </div>
              {j.status === "running" && (
                <button className="ghost" onClick={() => invoke("cancel_download")}>
                  Cancel
                </button>
              )}
              {j.status === "queued" && (
                <button className="icon" aria-label="Remove from queue" onClick={() => onRemove(j.id)}>
                  <Icon name="x" />
                </button>
              )}
              {j.status === "done" && j.entry && (
                <button className="icon" aria-label="Show in folder" onClick={() => revealItemInDir(j.entry!.path)}>
                  <Icon name="folder" />
                </button>
              )}
              {(j.status === "failed" || j.status === "cancelled") && (
                <button className="icon" aria-label="Try again" onClick={() => onRetry(j.id)}>
                  <Icon name="refresh" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
