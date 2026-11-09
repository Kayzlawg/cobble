use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    cmp::Reverse,
    collections::BTreeMap,
    fs,
    io::{BufRead, BufReader, Read},
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    thread,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};

const NO_WINDOW: u32 = 0x0800_0000;

// One job at a time. The frontend owns the queue and starts the next job when this one finishes.
#[derive(Default)]
struct Running {
    child: Mutex<Option<Child>>,
    cancelled: AtomicBool,
    busy: AtomicBool,
}

#[derive(Serialize, Clone)]
struct Stream {
    id: String,
    label: String,
    size: Option<u64>,
    codec: String,
    codec_name: String,
    audio_codec: Option<String>,
    audio_name: Option<String>,
}

#[derive(Serialize)]
struct Item {
    title: String,
    url: String,
    duration: Option<f64>,
}

#[derive(Serialize)]
struct Brief {
    title: String,
    thumbnail: Option<String>,
    uploader: Option<String>,
    duration: Option<f64>,
}

#[derive(Serialize)]
struct Info {
    title: String,
    thumbnail: Option<String>,
    uploader: Option<String>,
    duration: Option<f64>,
    videos: Vec<Stream>,
    audios: Vec<Stream>,
    entries: Vec<Item>,
}

#[derive(Serialize, Deserialize, Clone)]
struct Request {
    url: String,
    title: String,
    video: Option<String>,
    audio: Option<String>,
    // A yt-dlp format selector, used instead of video/audio ids (playlists pick by quality, not by stream).
    #[serde(default)]
    selector: Option<String>,
    vc: Option<String>,
    ac: Option<String>,
    preset: String,
    duration: Option<f64>,
    label: String,
    // Filename template with {title}, {uploader} and {date}. Empty or missing means the title.
    #[serde(default)]
    template: Option<String>,
    // Clip in seconds. Either end may be missing: no start means the beginning, no end means the end.
    #[serde(default)]
    start: Option<f64>,
    #[serde(default)]
    end: Option<f64>,
    // "embed" puts subtitles in the video, "file" saves an .srt next to it. Ignored for audio presets and clips.
    #[serde(default)]
    subs: Option<String>,
    #[serde(default)]
    sub_lang: Option<String>,
}

// Turns the filename template into a yt-dlp output name, without the extension.
// Characters Windows or yt-dlp would read as path or field syntax are dropped, so the template cannot leave the folder.
// Without {title}, the video id is added so different videos do not overwrite each other.
fn out_name(template: Option<&str>) -> String {
    let t: String = template.unwrap_or("").chars().filter(|c| !"/\\%:*?\"<>|".contains(*c)).collect();
    let t = t.trim();
    if t.is_empty() {
        return "%(title).150B".into();
    }
    let mut n = t
        .replace("{title}", "%(title).150B")
        .replace("{uploader}", "%(uploader).60B")
        .replace("{date}", "%(upload_date)s");
    if !t.contains("{title}") {
        n.push_str(" %(id)s");
    }
    n
}

#[derive(Deserialize)]
struct CompressReq {
    path: String,
    preset: String,
    codec: String,
    max_height: Option<u32>,
    #[serde(default)]
    gpu: bool,
}

#[derive(Serialize, Deserialize, Clone)]
struct Entry {
    id: u64,
    title: String,
    format: String,
    path: String,
    size: u64,
    at: u64,
    #[serde(default)]
    req: Option<Request>,
    #[serde(default)]
    from_size: Option<u64>,
}

#[derive(Serialize, Clone)]
struct Progress {
    stage: &'static str,
    percent: f64,
    speed: Option<f64>,
    eta: Option<u64>,
}

#[derive(Serialize)]
struct Plan {
    video: &'static str,
    audio: &'static str,
    video_to: &'static str,
    audio_to: &'static str,
    ext: &'static str,
}

#[derive(Serialize, Deserialize, Default)]
struct Settings {
    download_dir: Option<String>,
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn bundled(name: &str) -> PathBuf {
    let exe = std::env::current_exe().expect("current exe");
    exe.parent().expect("exe dir").join(format!("{name}.exe"))
}

// An updated copy in app data wins over the bundled one, which stays pristine.
fn ytdlp_path(app: &AppHandle) -> Result<PathBuf, String> {
    let copy = data_dir(app)?.join("yt-dlp.exe");
    Ok(if copy.exists() { copy } else { bundled("yt-dlp") })
}

fn ytdlp(app: &AppHandle) -> Result<Command, String> {
    let ffmpeg_dir = bundled("ffmpeg");
    let mut c = Command::new(ytdlp_path(app)?);
    c.creation_flags(NO_WINDOW)
        .args(["--no-update", "--no-warnings"])
        .arg("--ffmpeg-location")
        .arg(ffmpeg_dir.parent().unwrap())
        .arg("--js-runtimes")
        .arg(format!("deno:{}", bundled("deno").display()));
    Ok(c)
}

fn read_json<T: for<'a> Deserialize<'a> + Default>(path: PathBuf) -> T {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_json<T: Serialize>(path: PathBuf, v: &T) -> Result<(), String> {
    fs::write(path, serde_json::to_string_pretty(v).unwrap()).map_err(|e| e.to_string())
}

fn download_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let s: Settings = read_json(data_dir(app)?.join("settings.json"));
    match s.download_dir {
        Some(d) => Ok(PathBuf::from(d)),
        None => app.path().download_dir().map_err(|e| e.to_string()),
    }
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64
}

fn vfam(c: &str) -> &'static str {
    match c {
        c if c.starts_with("avc1") || c.starts_with("h264") => "h264",
        c if c.starts_with("vp09") || c.starts_with("vp9") => "vp9",
        c if c.starts_with("av01") => "av1",
        c if c.starts_with("hev1") || c.starts_with("hvc1") || c.starts_with("h265") => "h265",
        _ => "other",
    }
}

fn afam(c: &str) -> &'static str {
    match c {
        c if c.starts_with("mp4a") || c.starts_with("aac") => "aac",
        c if c.starts_with("opus") => "opus",
        c if c.starts_with("mp3") => "mp3",
        c if c.starts_with("flac") => "flac",
        c if c.starts_with("vorbis") => "vorbis",
        _ => "other",
    }
}

fn pretty(fam: &str, raw: &str) -> String {
    match fam {
        "h264" => "H.264".into(),
        "vp9" => "VP9".into(),
        "av1" => "AV1".into(),
        "h265" => "H.265".into(),
        "aac" => "AAC".into(),
        "opus" => "Opus".into(),
        "mp3" => "MP3".into(),
        "flac" => "FLAC".into(),
        "vorbis" => "Vorbis".into(),
        _ => raw.split('.').next().unwrap_or(raw).to_uppercase(),
    }
}

fn parse_streams(v: &Value) -> (Vec<Stream>, Vec<Stream>) {
    let dur = v["duration"].as_f64();
    let text = |f: &Value, k: &str| f[k].as_str().filter(|s| *s != "none").map(str::to_string);
    let mut vmap: BTreeMap<(u64, &str, bool), (f64, Stream)> = BTreeMap::new();
    let mut amap: BTreeMap<(&str, u64), (f64, Stream)> = BTreeMap::new();

    for f in v["formats"].as_array().into_iter().flatten() {
        let Some(id) = f["format_id"].as_str().map(str::to_string) else { continue };
        let tbr = f["tbr"].as_f64().unwrap_or(0.0);
        let size = f["filesize"]
            .as_f64()
            .or_else(|| f["filesize_approx"].as_f64())
            .or_else(|| dur.filter(|_| tbr > 0.0).map(|d| tbr * d * 125.0))
            .map(|s| s as u64);
        let (vc, ac) = (text(f, "vcodec"), text(f, "acodec"));

        if let Some(vc) = vc {
            let Some(h) = f["height"].as_u64().filter(|h| *h >= 144) else { continue };
            let fam = vfam(&vc);
            let fps = f["fps"].as_f64().unwrap_or(30.0);
            let name = pretty(fam, &vc);
            let hi = fps > 30.0;
            let s = Stream {
                id,
                label: format!("{h}p{} {name}", if hi { fps.round().to_string() } else { String::new() }),
                size,
                codec: fam.into(),
                codec_name: name,
                audio_codec: ac.as_deref().map(|c| afam(c).to_string()),
                audio_name: ac.as_deref().map(|c| pretty(afam(c), c)),
            };
            let slot = vmap.entry((h, fam, hi)).or_insert((-1.0, s.clone()));
            if tbr > slot.0 {
                *slot = (tbr, s);
            }
        } else if let Some(ac) = ac {
            let fam = afam(&ac);
            let abr = f["abr"].as_f64().unwrap_or(tbr);
            let name = pretty(fam, &ac);
            let s = Stream {
                id,
                label: if abr > 0.0 { format!("{name} {}k", abr.round()) } else { name.clone() },
                size,
                codec: fam.into(),
                codec_name: name,
                audio_codec: None,
                audio_name: None,
            };
            let slot = amap.entry((fam, abr.round() as u64)).or_insert((-1.0, s.clone()));
            if tbr > slot.0 {
                *slot = (tbr, s);
            }
        }
    }

    let rank = |c: &str| ["h264", "vp9", "av1", "h265"].iter().position(|x| *x == c).unwrap_or(4);
    let mut videos: Vec<_> = vmap.into_iter().collect();
    videos.sort_by_key(|((h, fam, hi), _)| (Reverse(*h), rank(fam), Reverse(*hi)));
    let mut audios: Vec<_> = amap.into_iter().collect();
    audios.sort_by_key(|((_, abr), _)| Reverse(*abr));
    (
        videos.into_iter().map(|(_, (_, s))| s).collect(),
        audios.into_iter().take(6).map(|(_, (_, s))| s).collect(),
    )
}

// A playlist URL comes back as a list of entries and no formats. With `playlist` false a watch URL that also has
// a list= parameter is treated as just that one video.
#[tauri::command]
async fn fetch_info(app: AppHandle, url: String, playlist: Option<bool>) -> Result<Info, String> {
    let mut cmd = ytdlp(&app)?;
    if playlist != Some(true) {
        cmd.arg("--no-playlist");
    }
    let out = tauri::async_runtime::spawn_blocking(move || cmd.args(["--flat-playlist", "-J"]).arg(url).output())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(last_error(&String::from_utf8_lossy(&out.stderr)));
    }
    let v: Value = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
    let entries: Vec<Item> = if v["_type"] == "playlist" {
        v["entries"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|e| {
                Some(Item {
                    title: e["title"].as_str().unwrap_or("Untitled").into(),
                    url: e["url"].as_str().or_else(|| e["webpage_url"].as_str())?.into(),
                    duration: e["duration"].as_f64(),
                })
            })
            .collect()
    } else {
        vec![]
    };
    let (videos, audios) = parse_streams(&v);
    Ok(Info {
        title: v["title"].as_str().unwrap_or("Untitled").into(),
        thumbnail: v["thumbnail"].as_str().map(Into::into),
        uploader: v["uploader"].as_str().or_else(|| v["channel"].as_str()).map(Into::into),
        duration: v["duration"].as_f64(),
        videos,
        audios,
        entries,
    })
}

// Fast first pass: confirms yt-dlp can read the link and returns name, duration and thumbnail before the slower
// format listing. Skipping the YouTube player JS drops the format list but saves a second or more.
#[tauri::command]
async fn check_link(app: AppHandle, url: String) -> Result<Brief, String> {
    let mut cmd = ytdlp(&app)?;
    let out = tauri::async_runtime::spawn_blocking(move || {
        cmd.args([
            "--no-playlist",
            "--flat-playlist",
            "--playlist-items",
            "1",
            "--skip-download",
            "--socket-timeout",
            "6",
            "--extractor-args",
            "youtube:player_skip=js,configs",
            "--print",
            "%(.{title,thumbnail,uploader,channel,duration})j",
        ])
        .arg(url)
        .output()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(last_error(&String::from_utf8_lossy(&out.stderr)));
    }
    let line = String::from_utf8_lossy(&out.stdout).lines().next().unwrap_or("").to_string();
    let v: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
    Ok(Brief {
        title: v["title"].as_str().unwrap_or("Untitled").into(),
        thumbnail: v["thumbnail"].as_str().map(Into::into),
        uploader: v["uploader"].as_str().or_else(|| v["channel"].as_str()).map(Into::into),
        duration: v["duration"].as_f64(),
    })
}

fn last_error(stderr: &str) -> String {
    stderr
        .lines()
        .rev()
        .find(|l| l.starts_with("ERROR:"))
        .map(|l| l.trim_start_matches("ERROR:").trim().to_string())
        .unwrap_or_else(|| "Download failed".into())
}

// What to do with each track for a preset. "copy" means the codec already matches, so it is not re-encoded.
#[tauri::command]
fn convert_plan(preset: &str, vc: Option<&str>, ac: Option<&str>) -> Plan {
    let act = |have: Option<&str>, want: &str| match have {
        None => "none",
        Some(c) if c == want => "copy",
        _ => "convert",
    };
    let keep = |have: Option<&str>| if have.is_some() { "copy" } else { "none" };
    let conv = |have: Option<&str>| if have.is_some() { "convert" } else { "none" };
    let (video, audio, video_to, audio_to, ext) = match (preset, vc.is_some()) {
        ("ae", true) => (act(vc, "h264"), act(ac, "aac"), "H.264", "AAC", "mp4"),
        ("ae", false) => ("none", act(ac, "aac"), "", "AAC", "m4a"),
        ("prores", true) => (conv(vc), conv(ac), "ProRes 422", "PCM", "mov"),
        ("prores", false) => ("none", conv(ac), "", "WAV", "wav"),
        ("mp3", _) => ("none", act(ac, "mp3"), "", "MP3", "mp3"),
        ("wav", _) => ("none", conv(ac), "", "WAV", "wav"),
        ("flac", _) => ("none", act(ac, "flac"), "", "FLAC", "flac"),
        ("aac", _) => ("none", act(ac, "aac"), "", "AAC", "m4a"),
        _ => (keep(vc), keep(ac), "", "", ""),
    };
    Plan { video, audio, video_to, audio_to, ext }
}

// yt-dlp --download-sections value for a clip, or None for the whole video.
fn trim_section(start: Option<f64>, end: Option<f64>) -> Option<String> {
    if start.is_none() && end.is_none() {
        return None;
    }
    let s = start.filter(|s| s.is_finite() && *s >= 0.0).unwrap_or(0.0);
    let e = end.filter(|e| e.is_finite() && *e > s).map_or("inf".to_string(), |e| e.to_string());
    Some(format!("*{s}-{e}"))
}

fn is_clip(req: &Request) -> bool {
    req.start.is_some() || req.end.is_some()
}

fn wants_subs(req: &Request) -> Option<&str> {
    let audio = matches!(req.preset.as_str(), "mp3" | "wav" | "flac" | "aac");
    match req.subs.as_deref() {
        Some(m @ ("embed" | "file")) if !audio && !is_clip(req) => Some(m),
        _ => None,
    }
}

// Language codes only, so the value cannot become another yt-dlp option or a regex. Defaults to English.
fn sub_langs(lang: Option<&str>) -> String {
    let l: String = lang.unwrap_or("").chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
    let l = l.trim_matches('-');
    format!("{}.*,-live_chat", if l.is_empty() { "en" } else { l })
}

fn format_selector(req: &Request) -> String {
    req.selector.clone().unwrap_or_else(|| {
        [req.video.as_deref(), req.audio.as_deref()].into_iter().flatten().collect::<Vec<_>>().join("+")
    })
}

// yt-dlp spawns ffmpeg and deno. Killing only the parent leaves them holding the output pipes open, so the job never ends.
fn kill_tree(c: &mut Child) {
    let _ = Command::new("taskkill")
        .creation_flags(NO_WINDOW)
        .args(["/T", "/F", "/PID"])
        .arg(c.id().to_string())
        .output();
    let _ = c.kill();
}

// Stores the running child so cancel can reach it. A cancel that landed before this point is honoured here.
fn register(running: &Running, mut child: Child) {
    if running.cancelled.load(Ordering::SeqCst) {
        kill_tree(&mut child);
    }
    *running.child.lock().unwrap() = Some(child);
}

// Runs ffmpeg on `input` into `out`, reporting progress. Removes `out` if it fails or is cancelled.
fn run_ffmpeg(
    app: &AppHandle,
    running: &Running,
    stage: &'static str,
    input: &Path,
    out: &Path,
    mid: &[&str],
    duration: Option<f64>,
) -> Result<(), String> {
    let mut child = Command::new(bundled("ffmpeg"))
        .creation_flags(NO_WINDOW)
        .args(["-y", "-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1", "-i"])
        .arg(input)
        .args(mid)
        .arg(out)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    register(running, child);

    let err = thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });
    let total_us = duration.unwrap_or(0.0) * 1e6;
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        if let Some(us) = line.strip_prefix("out_time_us=").and_then(|v| v.trim().parse::<f64>().ok()) {
            if total_us > 0.0 {
                let percent = (us / total_us * 100.0).clamp(0.0, 100.0);
                let _ = app.emit("progress", Progress { stage, percent, speed: None, eta: None });
            }
        }
    }
    let status = running.child.lock().unwrap().take().and_then(|mut c| c.wait().ok());
    let err = err.join().unwrap_or_default();

    if running.cancelled.load(Ordering::SeqCst) {
        let _ = fs::remove_file(out);
        return Err("Cancelled".into());
    }
    if !status.is_some_and(|s| s.success()) {
        let _ = fs::remove_file(out);
        return Err(err.lines().last().unwrap_or("ffmpeg failed").to_string());
    }
    Ok(())
}

fn convert(app: &AppHandle, running: &Running, req: &Request, src: &Path) -> Result<PathBuf, String> {
    let plan = convert_plan(&req.preset, req.vc.as_deref(), req.ac.as_deref());
    let src_ext = src.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let untouched = plan.ext.is_empty()
        || (plan.video != "convert" && plan.audio != "convert" && src_ext == plan.ext);
    if untouched {
        return Ok(src.to_path_buf());
    }
    if running.cancelled.load(Ordering::SeqCst) {
        return Err("Cancelled".into());
    }

    let tmp = src.with_extension(format!("cobble.{}", plan.ext));
    let video: &[&str] = match (plan.video, req.preset.as_str()) {
        ("copy", _) => &["-c:v", "copy"],
        ("none", _) => &["-vn"],
        (_, "prores") => &["-c:v", "prores_ks", "-profile:v", "2", "-pix_fmt", "yuv422p10le"],
        _ => &["-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p"],
    };
    let audio: &[&str] = match (plan.audio, req.preset.as_str()) {
        ("copy", _) => &["-c:a", "copy"],
        ("none", _) => &["-an"],
        (_, "prores") => &["-c:a", "pcm_s16le"],
        (_, "mp3") => &["-c:a", "libmp3lame", "-q:a", "0"],
        (_, "wav") => &["-c:a", "pcm_s16le"],
        (_, "flac") => &["-c:a", "flac"],
        _ => &["-c:a", "aac", "-b:a", "256k"],
    };
    let mut mid: Vec<&str> = [video, audio].concat();
    // Subtitles embedded in the mkv are carried over, as text tracks mp4 and mov accept.
    if wants_subs(req) == Some("embed") && plan.video != "none" {
        mid.extend(["-map", "0:v?", "-map", "0:a?", "-map", "0:s?", "-c:s", "mov_text"]);
    }
    if matches!(plan.ext, "mp4" | "m4a") {
        mid.extend(["-movflags", "+faststart"]);
    }
    run_ffmpeg(app, running, "convert", src, &tmp, &mid, req.duration)?;

    let dest = src.with_extension(plan.ext);
    let _ = fs::remove_file(src);
    fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
    Ok(dest)
}

// Claims the runner, runs the job on its own thread, then records history and emits done or failed.
fn spawn_job(
    app: AppHandle,
    running: &Running,
    job: impl FnOnce(&AppHandle, &Running) -> Result<Entry, String> + Send + 'static,
) -> Result<(), String> {
    if running.busy.swap(true, Ordering::SeqCst) {
        return Err("A job is already running".into());
    }
    running.cancelled.store(false, Ordering::SeqCst);
    thread::spawn(move || {
        let running = app.state::<Running>();
        let mut res = job(&app, &running);
        *running.child.lock().unwrap() = None;
        // A cancel that arrived too late to stop the job still wins: the finished file is deleted.
        if running.cancelled.load(Ordering::SeqCst) {
            if let Ok(entry) = &res {
                let _ = fs::remove_file(&entry.path);
            }
            res = Err("Cancelled".into());
        }
        running.busy.store(false, Ordering::SeqCst);
        match res {
            Ok(entry) => {
                if let Ok(dir) = data_dir(&app) {
                    let file = dir.join("history.json");
                    let mut h: Vec<Entry> = read_json(file.clone());
                    h.insert(0, entry.clone());
                    let _ = write_json(file, &h);
                }
                let _ = app.emit("done", entry);
            }
            Err(e) => {
                let _ = app.emit("failed", e);
            }
        }
    });
    Ok(())
}

fn run_download(app: &AppHandle, running: &Running, mut req: Request) -> Result<Entry, String> {
    let dir = download_dir(app)?;
    let mut cmd = ytdlp(app)?;
    cmd.arg("--no-playlist")
        .args(["-f", &format_selector(&req)])
        .args(["--merge-output-format", "mkv", "--force-overwrites"])
        .args(["--windows-filenames", "--newline", "--progress"]);
    if let Some(sec) = trim_section(req.start, req.end) {
        cmd.args(["--download-sections", &sec, "--force-keyframes-at-cuts"]);
    }
    if let Some(mode) = wants_subs(&req) {
        cmd.args(["--write-subs", "--write-auto-subs", "--sub-langs", &sub_langs(req.sub_lang.as_deref())]);
        cmd.args(["--convert-subs", "srt"]);
        if mode == "embed" {
            cmd.arg("--embed-subs");
        }
    }
    let mut child = cmd
        .args([
            "--progress-template",
            "download:%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s",
            "--print",
            "after_move:codecs|%(vcodec)s|%(acodec)s",
            "--print",
            "after_move:filepath",
            "-o",
        ])
        .arg(dir.join(format!("{}.%(ext)s", out_name(req.template.as_deref()))))
        .arg(&req.url)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    register(running, child);

    let err = thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });
    let mut path = String::new();
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        let p: Vec<&str> = line.split('|').collect();
        if p[0] == "codecs" && p.len() == 3 {
            // The codecs yt-dlp actually fetched win over what the format list guessed.
            let known = |c: &str| (c != "none" && c != "NA").then(|| c.to_string());
            req.vc = known(p[1]).map(|c| vfam(&c).to_string());
            req.ac = known(p[2]).map(|c| afam(&c).to_string());
        } else if p.len() == 5 {
            let n = |i: usize| p[i].trim().parse::<f64>().ok();
            let total = n(1).or(n(2)).unwrap_or(0.0);
            let percent = if total > 0.0 { n(0).unwrap_or(0.0) / total * 100.0 } else { 0.0 };
            let _ = app.emit(
                "progress",
                Progress { stage: "download", percent, speed: n(3), eta: n(4).map(|e| e as u64) },
            );
        } else if !line.trim().is_empty() {
            path = line.trim().to_string();
        }
    }
    let status = running.child.lock().unwrap().take().and_then(|mut c| c.wait().ok());
    let err = err.join().unwrap_or_default();
    if running.cancelled.load(Ordering::SeqCst) {
        return Err("Cancelled".into());
    }
    if !status.is_some_and(|s| s.success()) || path.is_empty() {
        return Err(last_error(&err));
    }

    let final_path = convert(app, running, &req, Path::new(&path))?;
    Ok(Entry {
        id: now(),
        title: req.title.clone(),
        format: req.label.clone(),
        size: fs::metadata(&final_path).map(|m| m.len()).unwrap_or(0),
        path: final_path.display().to_string(),
        at: now(),
        req: Some(req),
        from_size: None,
    })
}

#[tauri::command]
fn start_download(app: AppHandle, running: State<Running>, req: Request) -> Result<(), String> {
    if req.selector.is_none() && req.video.is_none() && req.audio.is_none() {
        return Err("Pick a video or audio stream".into());
    }
    spawn_job(app, &running, move |app, running| run_download(app, running, req))
}

// `ffmpeg -i` with no output prints the stream info to stderr and exits non-zero, which is fine here.
fn probe(path: &Path) -> String {
    Command::new(bundled("ffmpeg"))
        .creation_flags(NO_WINDOW)
        .args(["-hide_banner", "-i"])
        .arg(path)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stderr).into_owned())
        .unwrap_or_default()
}

fn probe_duration(path: &Path) -> Option<f64> {
    let text = probe(path);
    let t = text.split("Duration: ").nth(1)?.split(',').next()?;
    let mut p = t.trim().split(':').map(|x| x.parse::<f64>().ok());
    Some(p.next()?? * 3600.0 + p.next()?? * 60.0 + p.next()??)
}

// The first WxH token on the Video line. The 3 digit minimum skips hex codec tags like 0x31637661.
fn video_height(text: &str) -> Option<u32> {
    let line = text.lines().find(|l| l.contains("Video:"))?;
    line.split(|c: char| c.is_whitespace() || c == ',').find_map(|t| {
        let (w, h) = t.split_once('x')?;
        let ok = |s: &str| (3..=5).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit());
        (ok(w) && ok(h)).then(|| h.parse().ok()).flatten()
    })
}

#[derive(Serialize)]
struct VideoInfo {
    size: u64,
    height: Option<u32>,
}

// True when ffmpeg can open the NVIDIA encoder, which needs an NVIDIA card and a recent driver.
#[tauri::command]
async fn gpu_available() -> bool {
    tauri::async_runtime::spawn_blocking(|| {
        Command::new(bundled("ffmpeg"))
            .creation_flags(NO_WINDOW)
            .args(["-v", "error", "-f", "lavfi", "-i", "color=s=256x256:d=0.1", "-frames:v", "1"])
            .args(["-c:v", "h264_nvenc", "-f", "null", "-"])
            .output()
            .is_ok_and(|o| o.status.success())
    })
    .await
    .unwrap_or(false)
}

// A small JPEG frame from a video file, sent as raw bytes. Audio files and missing files return an error.
#[tauri::command]
async fn thumbnail(path: String) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // One second in skips black intro frames. Clips shorter than that fall back to the first frame.
        for ss in ["1", "0"] {
            let out = Command::new(bundled("ffmpeg"))
                .creation_flags(NO_WINDOW)
                .args(["-v", "error", "-ss", ss, "-i"])
                .arg(&path)
                .args(["-frames:v", "1", "-vf", "scale=224:-2", "-f", "mjpeg", "pipe:1"])
                .output()
                .map_err(|e| e.to_string())?;
            if !out.stdout.is_empty() {
                return Ok(tauri::ipc::Response::new(out.stdout));
            }
        }
        Err("No frame".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn probe_video(path: String) -> Result<VideoInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(path);
        Ok(VideoInfo { size: fs::metadata(&p).map_err(|e| e.to_string())?.len(), height: video_height(&probe(&p)) })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn unique(path: PathBuf) -> PathBuf {
    let (stem, ext) = (
        path.file_stem().unwrap().to_string_lossy().to_string(),
        path.extension().unwrap().to_string_lossy().to_string(),
    );
    let mut p = path;
    let mut n = 2;
    while p.exists() {
        p = p.with_file_name(format!("{stem} ({n}).{ext}"));
        n += 1;
    }
    p
}

fn run_compress(app: &AppHandle, running: &Running, req: CompressReq) -> Result<Entry, String> {
    let src = PathBuf::from(&req.path);
    let stem = src.file_stem().ok_or("Bad file name")?.to_string_lossy().to_string();
    let out = unique(download_dir(app)?.join(format!("{stem} compressed.mp4")));
    let h265 = req.codec == "h265";
    let crf = match (h265, req.preset.as_str()) {
        (true, "small") => "30",
        (true, "high") => "21",
        (true, _) => "26",
        (false, "small") => "28",
        (false, "high") => "18",
        (false, _) => "23",
    };
    let scale = req.max_height.map(|h| format!("scale=-2:'min({h},ih)'"));
    let duration = probe_duration(&src);
    // With GPU on, a failed NVENC run (no NVIDIA card, driver too old) is retried once on the CPU.
    let mut res = Err("ffmpeg failed".to_string());
    for gpu in if req.gpu { vec![true, false] } else { vec![false] } {
        let enc = match (gpu, h265) {
            (true, true) => "hevc_nvenc",
            (true, false) => "h264_nvenc",
            (false, true) => "libx265",
            (false, false) => "libx264",
        };
        let mut mid = vec!["-c:v", enc];
        // ponytail: the same number is used as CRF and as NVENC's CQ. They are close but not identical.
        if gpu {
            mid.extend(["-rc", "vbr", "-cq", crf, "-b:v", "0", "-preset", "p5"]);
        } else {
            mid.extend(["-crf", crf, "-preset", "medium"]);
        }
        mid.extend(["-pix_fmt", "yuv420p"]);
        if h265 {
            mid.extend(["-tag:v", "hvc1"]);
        }
        if let Some(s) = &scale {
            mid.extend(["-vf", s]);
        }
        mid.extend(["-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"]);
        res = run_ffmpeg(app, running, "compress", &src, &out, &mid, duration);
        if res.is_ok() || running.cancelled.load(Ordering::SeqCst) {
            break;
        }
    }
    res?;

    Ok(Entry {
        id: now(),
        title: stem,
        format: format!("Compressed {}", if h265 { "H.265" } else { "H.264" }),
        size: fs::metadata(&out).map(|m| m.len()).unwrap_or(0),
        path: out.display().to_string(),
        at: now(),
        req: None,
        from_size: fs::metadata(&src).map(|m| m.len()).ok(),
    })
}

#[tauri::command]
fn start_compress(app: AppHandle, running: State<Running>, req: CompressReq) -> Result<(), String> {
    spawn_job(app, &running, move |app, running| run_compress(app, running, req))
}

#[tauri::command]
fn cancel_download(running: State<Running>) {
    running.cancelled.store(true, Ordering::SeqCst);
    if let Some(c) = running.child.lock().unwrap().as_mut() {
        kill_tree(c);
    }
}

#[tauri::command]
fn get_history(app: AppHandle) -> Result<Vec<Entry>, String> {
    Ok(read_json(data_dir(&app)?.join("history.json")))
}

#[tauri::command]
fn remove_history(app: AppHandle, id: u64) -> Result<Vec<Entry>, String> {
    let file = data_dir(&app)?.join("history.json");
    let mut h: Vec<Entry> = read_json(file.clone());
    h.retain(|e| e.id != id);
    write_json(file, &h)?;
    Ok(h)
}

#[tauri::command]
fn get_download_dir(app: AppHandle) -> Result<String, String> {
    Ok(download_dir(&app)?.display().to_string())
}

#[tauri::command]
fn set_download_dir(app: AppHandle, dir: String) -> Result<(), String> {
    write_json(data_dir(&app)?.join("settings.json"), &Settings { download_dir: Some(dir) })
}

#[tauri::command]
async fn ytdlp_version(app: AppHandle) -> Result<String, String> {
    let mut cmd = ytdlp(&app)?;
    let out = tauri::async_runtime::spawn_blocking(move || cmd.arg("--version").output())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[tauri::command]
async fn update_ytdlp(app: AppHandle) -> Result<String, String> {
    let copy = data_dir(&app)?.join("yt-dlp.exe");
    if !copy.exists() {
        fs::copy(bundled("yt-dlp"), &copy).map_err(|e| e.to_string())?;
    }
    tauri::async_runtime::spawn_blocking(move || {
        Command::new(&copy).creation_flags(NO_WINDOW).arg("-U").output()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    ytdlp_version(app).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(Running::default())
        .invoke_handler(tauri::generate_handler![
            fetch_info,
            check_link,
            convert_plan,
            start_download,
            start_compress,
            probe_video,
            gpu_available,
            thumbnail,
            cancel_download,
            get_history,
            remove_history,
            get_download_dir,
            set_download_dir,
            ytdlp_version,
            update_ytdlp,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skips_matching_codecs() {
        let p = convert_plan("ae", Some("h264"), Some("aac"));
        assert_eq!((p.video, p.audio, p.ext), ("copy", "copy", "mp4"));
        let p = convert_plan("ae", Some("vp9"), Some("opus"));
        assert_eq!((p.video, p.audio), ("convert", "convert"));
        let p = convert_plan("ae", Some("av1"), None);
        assert_eq!((p.video, p.audio), ("convert", "none"));
        let p = convert_plan("keep", Some("vp9"), Some("opus"));
        assert_eq!(p.ext, "");
        let p = convert_plan("mp3", None, Some("mp3"));
        assert_eq!((p.audio, p.ext), ("copy", "mp3"));
        let p = convert_plan("wav", None, Some("wav"));
        assert_eq!((p.audio, p.ext), ("convert", "wav"));
        let p = convert_plan("flac", None, Some("flac"));
        assert_eq!((p.audio, p.ext), ("copy", "flac"));
        let p = convert_plan("aac", None, Some("opus"));
        assert_eq!((p.audio, p.ext), ("convert", "m4a"));
    }

    #[test]
    fn builds_clip_and_subtitle_options() {
        assert_eq!(trim_section(None, None), None);
        assert_eq!(trim_section(Some(30.0), Some(75.5)).as_deref(), Some("*30-75.5"));
        assert_eq!(trim_section(None, Some(10.0)).as_deref(), Some("*0-10"));
        assert_eq!(trim_section(Some(5.0), None).as_deref(), Some("*5-inf"));
        assert_eq!(sub_langs(None), "en.*,-live_chat");
        assert_eq!(sub_langs(Some("--exec x")), "execx.*,-live_chat");
        assert_eq!(sub_langs(Some("pt-BR")), "pt-BR.*,-live_chat");
    }

    #[test]
    fn builds_filename_from_template() {
        assert_eq!(out_name(None), "%(title).150B");
        assert_eq!(out_name(Some("  ")), "%(title).150B");
        assert_eq!(out_name(Some("{uploader} - {title}")), "%(uploader).60B - %(title).150B");
        // No {title}: the id keeps files apart. Path and field syntax is stripped.
        assert_eq!(out_name(Some("{date}")), "%(upload_date)s %(id)s");
        assert_eq!(out_name(Some("..\\x/%(id)s {title}")), "..x(id)s %(title).150B");
    }

    #[test]
    fn reads_height_not_codec_tag() {
        let l = "  Stream #0:0: Video: h264 (High) (avc1 / 0x31637661), yuv420p, 1920x1080 [SAR 1:1 DAR 16:9], 30 fps";
        assert_eq!(video_height(l), Some(1080));
        assert_eq!(video_height("Audio: aac"), None);
    }
}
