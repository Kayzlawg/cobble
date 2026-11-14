export type Stream = {
  id: string;
  label: string;
  size: number | null;
  codec: string;
  codec_name: string;
  audio_codec: string | null;
  audio_name: string | null;
};

export type Item = { title: string; url: string; duration: number | null };

export type Brief = {
  title: string;
  thumbnail: string | null;
  uploader: string | null;
  duration: number | null;
};

export type Info = {
  title: string;
  thumbnail: string | null;
  uploader: string | null;
  duration: number | null;
  videos: Stream[];
  audios: Stream[];
  entries: Item[];
};

export type Req = {
  url: string;
  title: string;
  video: string | null;
  audio: string | null;
  selector: string | null;
  vc: string | null;
  ac: string | null;
  preset: string;
  duration: number | null;
  label: string;
  template?: string;
  start?: number | null;
  end?: number | null;
  subs?: string | null;
  sub_lang?: string | null;
};

export type CReq = { path: string; preset: string; codec: string; max_height: number | null; gpu: boolean };

export type Entry = {
  id: number;
  title: string;
  format: string;
  path: string;
  size: number;
  at: number;
  req: Req | null;
  from_size: number | null;
};

export type Plan = {
  video: "copy" | "convert" | "none";
  audio: "copy" | "convert" | "none";
  video_to: string;
  audio_to: string;
  ext: string;
};

export type Progress = {
  stage: "download" | "convert" | "compress";
  percent: number;
  speed: number | null;
  eta: number | null;
};

export type Job = {
  id: number;
  kind: "download" | "compress";
  title: string;
  label: string;
  status: "queued" | "running" | "cancelling" | "done" | "failed" | "cancelled";
  progress: Progress | null;
  est?: string;
  error?: string;
  entry?: Entry;
  req?: Req;
  creq?: CReq;
  // Captured when the job is added, so the queue can show them without fetching again.
  thumb?: string | null;
  author?: string | null;
  duration?: number | null;
  // Set when the job stops being live (done, failed or cancelled), in ms.
  endedAt?: number;
  // Output lines from yt-dlp or ffmpeg while the job runs. Set when it starts, so only jobs that ran have one.
  log?: string[];
  // Whether the log panel is open. Set when a job fails, so the reason is on screen.
  logOpen?: boolean;
};

export type NewJob = Pick<Job, "kind" | "title" | "label" | "est" | "req" | "creq" | "thumb" | "author" | "duration">;
