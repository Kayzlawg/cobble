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

#[derive(Default)]
struct Running {
    child: Mutex<Option<Child>>,
    cancelled: AtomicBool,
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
struct Info {
    title: String,
    thumbnail: Option<String>,
    uploader: Option<String>,
    duration: Option<f64>,
    videos: Vec<Stream>,
    audios: Vec<Stream>,
}

#[derive(Serialize, Deserialize, Clone)]
struct Request {
    url: String,
    title: String,
    video: Option<String>,
    audio: Option<String>,
    vc: Option<String>,
    ac: Option<String>,
    preset: String,
    duration: Option<f64>,
    label: String,
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
        .args(["--no-update", "--no-warnings", "--no-playlist"])
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

#[tauri::command]
async fn fetch_info(app: AppHandle, url: String) -> Result<Info, String> {
    let mut cmd = ytdlp(&app)?;
    let out = tauri::async_runtime::spawn_blocking(move || cmd.arg("-J").arg(url).output())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(last_error(&String::from_utf8_lossy(&out.stderr)));
    }
    let v: Value = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
    let (videos, audios) = parse_streams(&v);
    Ok(Info {
        title: v["title"].as_str().unwrap_or("Untitled").into(),
        thumbnail: v["thumbnail"].as_str().map(Into::into),
        uploader: v["uploader"].as_str().map(Into::into),
        duration: v["duration"].as_f64(),
        videos,
        audios,
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
        _ => (keep(vc), keep(ac), "", "", ""),
    };
    Plan { video, audio, video_to, audio_to, ext }
}

fn format_selector(req: &Request) -> String {
    [req.video.as_deref(), req.audio.as_deref()].into_iter().flatten().collect::<Vec<_>>().join("+")
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
        _ => &["-c:a", "aac", "-b:a", "256k"],
    };
    let mut cmd = Command::new(bundled("ffmpeg"));
    cmd.creation_flags(NO_WINDOW)
        .args(["-y", "-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1", "-i"])
        .arg(src)
        .args(video)
        .args(audio);
    if matches!(plan.ext, "mp4" | "m4a") {
        cmd.args(["-movflags", "+faststart"]);
    }
    let mut child = cmd
        .arg(&tmp)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    *running.child.lock().unwrap() = Some(child);

    let err = thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });
    let total_us = req.duration.unwrap_or(0.0) * 1e6;
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        if let Some(us) = line.strip_prefix("out_time_us=").and_then(|v| v.trim().parse::<f64>().ok()) {
            if total_us > 0.0 {
                let percent = (us / total_us * 100.0).clamp(0.0, 100.0);
                let _ = app.emit("progress", Progress { stage: "convert", percent, speed: None, eta: None });
            }
        }
    }
    let status = running.child.lock().unwrap().take().and_then(|mut c| c.wait().ok());
    let err = err.join().unwrap_or_default();

    if running.cancelled.load(Ordering::SeqCst) {
        let _ = fs::remove_file(&tmp);
        return Err("Cancelled".into());
    }
    if !status.is_some_and(|s| s.success()) {
        let _ = fs::remove_file(&tmp);
        return Err(err.lines().last().unwrap_or("Conversion failed").to_string());
    }
    let dest = src.with_extension(plan.ext);
    let _ = fs::remove_file(src);
    fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
    Ok(dest)
}

#[tauri::command]
fn start_download(app: AppHandle, running: State<Running>, req: Request) -> Result<(), String> {
    if req.video.is_none() && req.audio.is_none() {
        return Err("Pick a video or audio stream".into());
    }
    let mut slot = running.child.lock().unwrap();
    if slot.is_some() {
        return Err("A download is already running".into());
    }
    let dir = download_dir(&app)?;
    running.cancelled.store(false, Ordering::SeqCst);
    let mut child = ytdlp(&app)?
        .args(["-f", &format_selector(&req)])
        .args(["--merge-output-format", "mkv", "--force-overwrites"])
        .args(["--windows-filenames", "--newline", "--progress"])
        .args([
            "--progress-template",
            "download:%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s",
            "--print",
            "after_move:filepath",
            "-o",
        ])
        .arg(dir.join("%(title).150B.%(ext)s"))
        .arg(&req.url)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    *slot = Some(child);
    drop(slot);

    thread::spawn(move || {
        let err = thread::spawn(move || {
            let mut s = String::new();
            let _ = stderr.read_to_string(&mut s);
            s
        });
        let mut path = String::new();
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let p: Vec<&str> = line.split('|').collect();
            if p.len() == 5 {
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
        let running = app.state::<Running>();
        let status = running.child.lock().unwrap().take().and_then(|mut c| c.wait().ok());
        let err = err.join().unwrap_or_default();
        if running.cancelled.load(Ordering::SeqCst) {
            let _ = app.emit("failed", "Cancelled");
            return;
        }
        if !status.is_some_and(|s| s.success()) || path.is_empty() {
            let _ = app.emit("failed", last_error(&err));
            return;
        }
        match convert(&app, &running, &req, Path::new(&path)) {
            Ok(final_path) => {
                let entry = Entry {
                    id: now(),
                    title: req.title.clone(),
                    format: req.label.clone(),
                    size: fs::metadata(&final_path).map(|m| m.len()).unwrap_or(0),
                    path: final_path.display().to_string(),
                    at: now(),
                    req: Some(req),
                };
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

#[tauri::command]
fn cancel_download(running: State<Running>) {
    running.cancelled.store(true, Ordering::SeqCst);
    if let Some(c) = running.child.lock().unwrap().as_mut() {
        let _ = c.kill();
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
        .manage(Running::default())
        .invoke_handler(tauri::generate_handler![
            fetch_info,
            convert_plan,
            start_download,
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
    }
}
