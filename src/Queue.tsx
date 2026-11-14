import { useEffect, useRef, useState, type ReactNode } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Icon } from "./Icon";
import { Thumb, clock, day, size, useLeave } from "./ui";
import type { Job } from "./types";

const isLive = (j: Job) => j.status === "queued" || j.status === "running" || j.status === "cancelling";

// Keeps the newest line in view as output arrives. The copy button puts the whole log on the clipboard.
function Log({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines]);
  const copy = async () => {
    try {
      await writeText(lines.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };
  return (
    <div className="logbox">
      <pre className="log" ref={ref}>
        {lines.length ? lines.join("\n") : "No output yet."}
      </pre>
      {lines.length > 0 && (
        <button className="icon" aria-label="Copy log" title="Copy log" onClick={copy}>
          <Icon name={copied ? "circleCheck" : "copy"} size={15} />
        </button>
      )}
    </div>
  );
}

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
  onToggleLog,
  onClear,
}: {
  jobs: Job[];
  onCancel: (id: number) => void;
  onCancelAll: () => void;
  onRemove: (id: number) => void;
  onRetry: (id: number) => void;
  onRunNext: (id: number) => void;
  onToggleLog: (id: number) => void;
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
        {j.log && (
          <button
            className="icon"
            aria-label="Show log"
            title={j.logOpen ? "Hide log" : "Show log"}
            aria-expanded={!!j.logOpen}
            onClick={() => onToggleLog(j.id)}
          >
            <Icon name="terminal" />
          </button>
        )}
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

  // Jobs share one card. An open log ends the card, shows under its job as its own panel, and a new card carries on.
  const section = (js: Job[]) => {
    const out: ReactNode[] = [];
    let cur: Job[] = [];
    const flush = () => {
      if (cur.length) out.push(<div className="list sec" key={`c${cur[0].id}`}>{cur.map(row)}</div>);
      cur = [];
    };
    for (const j of js) {
      cur.push(j);
      if (j.log && j.logOpen) {
        flush();
        out.push(<Log key={`l${j.id}`} lines={j.log} />);
      }
    }
    flush();
    return out;
  };

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
          {section(open)}
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
          {section(finished)}
        </>
      )}
    </>
  );
}
