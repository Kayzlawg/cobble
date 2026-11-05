import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Icon } from "./Icon";
import { Thumb, clock, day, size, useLeave } from "./ui";
import type { Job } from "./types";

const isLive = (j: Job) => j.status === "queued" || j.status === "running" || j.status === "cancelling";

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
    case "cancelling":
      return "Cancelling...";
    case "done": {
      const e = j.entry;
      return e?.from_size ? `${size(e.from_size)} to ${size(e.size)}` : size(e?.size ?? null);
    }
    case "cancelled":
      return "Cancelled";
    case "failed":
      return j.error || "Failed";
  }
}

// The thumbnail saved when the job was added, else a frame from the file on disk, else a play icon.
function JobThumb({ j }: { j: Job }) {
  if (j.thumb)
    return (
      <div className="thumb sm">
        <img src={j.thumb} alt="" />
      </div>
    );
  const path = j.entry?.path ?? j.creq?.path;
  if (path) return <Thumb path={path} />;
  return (
    <div className="thumb sm">
      <Icon name="play" size={14} />
    </div>
  );
}

export default function Queue({
  jobs,
  onCancel,
  onCancelAll,
  onRemove,
  onRetry,
  onRunNext,
  onClear,
}: {
  jobs: Job[];
  onCancel: (id: number) => void;
  onCancelAll: () => void;
  onRemove: (id: number) => void;
  onRetry: (id: number) => void;
  onRunNext: (id: number) => void;
  onClear: () => void;
}) {
  const [leaving, leave] = useLeave();
  const open = jobs.filter(isLive);
  // Newest first.
  const finished = jobs.filter((j) => !isLive(j)).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  const firstQueued = open.find((j) => j.status === "queued")?.id;

  const row = (j: Job) => (
    <div className={`row ${leaving.has(j.id) ? "leaving" : ""}`} key={j.id}>
      <JobThumb j={j} />
      <div className="titles">
        <div className="t">{j.title}</div>
        {(j.author || j.duration) && <div className="s">{[j.author, j.duration ? clock(j.duration) : null].filter(Boolean).join(", ")}</div>}
        <div className={`s stat ${j.status === "failed" ? "bad" : ""}`}>
          {j.status === "done" && (
            <span className="mark ok" title="Done">
              <Icon name="circleCheck" size={14} />
            </span>
          )}
          {j.status === "failed" && (
            <span className="mark no" title="Failed">
              <Icon name="alert" size={14} />
            </span>
          )}
          <span>{[j.label, status(j), (j.status === "queued" || j.status === "running") && j.est].filter(Boolean).join(", ")}</span>
        </div>
        {j.status === "running" && (
          <div className="bar">
            <i style={{ width: `${j.progress?.percent ?? 0}%` }} />
          </div>
        )}
      </div>
      <div className="acts">
        {!isLive(j) && j.endedAt && <small className="when">{day(j.endedAt)}</small>}
        {(j.status === "running" || j.status === "cancelling") && (
          <button className="ghost" disabled={j.status === "cancelling"} onClick={() => onCancel(j.id)}>
            Cancel
          </button>
        )}
        {j.status === "queued" && j.id !== firstQueued && (
          <button className="icon" aria-label="Run next" title="Run next" onClick={() => onRunNext(j.id)}>
            <Icon name="up" />
          </button>
        )}
        {j.status === "queued" && (
          <button className="icon" aria-label="Remove from queue" onClick={() => leave(j.id, () => onRemove(j.id))}>
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
    </div>
  );

  return (
    <>
      <h1>Queue</h1>
      {jobs.length === 0 && <p className="empty">Downloads and compressions you add show up here.</p>}
      {open.length > 0 && (
        <>
          <div className="listhead">
            <span>In progress</span>
            {open.length > 1 && (
              <button className="link" onClick={onCancelAll}>
                Cancel all
              </button>
            )}
          </div>
          <div className="list sec">{open.map(row)}</div>
        </>
      )}
      {finished.length > 0 && (
        <>
          <div className="listhead">
            <span>Finished</span>
            <button className="link" onClick={onClear}>
              Clear finished
            </button>
          </div>
          <div className="list sec">{finished.map(row)}</div>
        </>
      )}
    </>
  );
}
