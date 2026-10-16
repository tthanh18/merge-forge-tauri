use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

const MAX_BYTES: usize = 10 * 1024 * 1024;
const USAGE: &str = "\
Point Fork at this app: Settings → Integration → Merge Tool → Custom.

Path:
/Applications/Merge Forge.app/Contents/MacOS/merge-forge

Arguments:
$LOCAL
$REMOTE
$BASE
$MERGED

Fork waits until you Apply (exit 0, file saved) or close the window (exit 1, conflict kept).
A single conflicted path also works — the three versions are read from the git index.";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InitPayload {
    file_path: String,
    language_id: String,
    left: String,
    base: String,
    right: String,
    labels: Labels,
    eol: EolInfo,
    settings: Settings,
}

#[derive(Clone, Serialize)]
struct Labels {
    left: String,
    right: String,
}

#[derive(Clone, Serialize)]
struct EolInfo {
    left: Eol,
    base: Eol,
    right: Eol,
    conflict: bool,
    suggested: Eol,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Eol {
    Lf,
    Crlf,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    auto_apply_non_conflicting: bool,
    font: FontSettings,
}

#[derive(Clone, Serialize)]
struct FontSettings {
    size: u32,
    family: String,
    ligatures: bool,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Boot {
    Ready { payload: InitPayload },
    Error { message: String },
}

pub struct Session {
    payload: InitPayload,
    output: PathBuf,
    had_bom: bool,
    repo_root: Option<PathBuf>,
    relative_path: Option<String>,
}

pub enum Launch {
    Ready(Session),
    Error(String),
}

impl Launch {
    pub fn boot(&self) -> Boot {
        match self {
            Launch::Ready(session) => Boot::Ready {
                payload: session.payload.clone(),
            },
            Launch::Error(message) => Boot::Error {
                message: message.clone(),
            },
        }
    }

    pub fn into_session(self) -> Option<Session> {
        match self {
            Launch::Ready(session) => Some(session),
            Launch::Error(_) => None,
        }
    }
}

impl Session {
    pub fn file_path(&self) -> &str {
        &self.payload.file_path
    }

    pub fn write_result(&self, content: &str, eol: &str) -> Result<(), String> {
        let bytes = encode_result(content, eol, self.had_bom);
        if let Some(parent) = self.output.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::write(&self.output, bytes)
            .map_err(|error| format!("could not write the result: {error}"))?;
        if let (Some(root), Some(relative)) = (&self.repo_root, &self.relative_path) {
            stage_if_conflicted(root, relative)?;
        }
        Ok(())
    }
}

pub fn load_from_env() -> Launch {
    load_from_args(std::env::args().skip(1))
}

pub fn load_from_args<I>(args: I) -> Launch
where
    I: IntoIterator<Item = String>,
{
    match parse_positionals(args) {
        Parsed::Usage => Launch::Error(USAGE.to_string()),
        Parsed::Invalid(message) => Launch::Error(message),
        Parsed::Files {
            local,
            remote,
            base,
            merged,
        } => load_files(&local, &remote, &base, &merged),
        Parsed::Git { merged } => load_git(&merged),
    }
}

enum Parsed {
    Usage,
    Invalid(String),
    Git {
        merged: PathBuf,
    },
    Files {
        local: PathBuf,
        remote: PathBuf,
        base: PathBuf,
        merged: PathBuf,
    },
}

fn parse_positionals<I>(args: I) -> Parsed
where
    I: IntoIterator<Item = String>,
{
    let paths: Vec<String> = args
        .into_iter()
        .filter(|arg| !arg.starts_with('-'))
        .map(|arg| strip_quotes(&arg).to_string())
        .filter(|arg| !arg.is_empty())
        .collect();
    match paths.as_slice() {
        [] => Parsed::Usage,
        [merged] => Parsed::Git {
            merged: PathBuf::from(merged),
        },
        [local, remote, base, merged] => Parsed::Files {
            local: PathBuf::from(local),
            remote: PathBuf::from(remote),
            base: PathBuf::from(base),
            merged: PathBuf::from(merged),
        },
        other => Parsed::Invalid(format!(
            "Expected 4 paths ($LOCAL $REMOTE $BASE $MERGED) or 1 conflicted file.\n\nReceived:\n{}",
            other.join("\n")
        )),
    }
}

fn strip_quotes(value: &str) -> &str {
    value
        .strip_prefix('"')
        .and_then(|inner| inner.strip_suffix('"'))
        .unwrap_or(value)
}

fn load_files(local: &Path, remote: &Path, base: &Path, merged: &Path) -> Launch {
    let local_bytes = match read_required(local, "local") {
        Ok(bytes) => bytes,
        Err(message) => return Launch::Error(message),
    };
    let remote_bytes = match read_required(remote, "remote") {
        Ok(bytes) => bytes,
        Err(message) => return Launch::Error(message),
    };
    let base_bytes = if base.as_os_str().is_empty() || !base.exists() {
        Vec::new()
    } else {
        match fs::read(base) {
            Ok(bytes) => bytes,
            Err(error) => {
                return Launch::Error(format!("could not read base {}: {error}", base.display()))
            }
        }
    };
    let repo = repo_root(merged);
    let relative = repo.as_ref().and_then(|root| relative_to(root, merged));
    let labels = repo
        .as_ref()
        .map(|root| branch_labels(root))
        .unwrap_or_else(|| Labels {
            left: "Yours".into(),
            right: "Theirs".into(),
        });
    finish(
        merged,
        repo,
        relative,
        &local_bytes,
        &base_bytes,
        &remote_bytes,
        labels,
    )
}

fn load_git(merged: &Path) -> Launch {
    if !merged.is_file() {
        return Launch::Error(format!("file not found: {}", merged.display()));
    }
    let Some(root) = repo_root(merged) else {
        return Launch::Error(format!(
            "{} is not inside a git repository.\n\n{USAGE}",
            merged.display()
        ));
    };
    let Some(relative) = relative_to(&root, merged) else {
        return Launch::Error(format!(
            "could not locate {} in the repository",
            merged.display()
        ));
    };
    let stages = match read_stages(&root, &relative) {
        Ok(stages) => stages,
        Err(message) => return Launch::Error(message),
    };
    let operation = detect_operation(&root);
    let (yours, theirs) = if operation.swap {
        (stages.theirs, stages.ours)
    } else {
        (stages.ours, stages.theirs)
    };
    let Some(yours) = yours else {
        return Launch::Error(format!(
            "{relative} was deleted on your side. Keep or delete it in Fork — there is no three-pane merge."
        ));
    };
    let Some(theirs) = theirs else {
        return Launch::Error(format!(
            "{relative} was deleted on their side. Keep or delete it in Fork — there is no three-pane merge."
        ));
    };
    let base = stages.base.unwrap_or_default();
    let labels = branch_labels_for(&root, &operation);
    finish(
        merged,
        Some(root),
        Some(relative),
        &yours,
        &base,
        &theirs,
        labels,
    )
}

struct Stages {
    base: Option<Vec<u8>>,
    ours: Option<Vec<u8>>,
    theirs: Option<Vec<u8>>,
}

fn read_stages(root: &Path, relative: &str) -> Result<Stages, String> {
    let listing = git_text(root, &["ls-files", "-u", "--", relative])?;
    if listing.trim().is_empty() {
        return Err(format!(
            "{relative} is not conflicted.\n\nOpen it from Fork while a merge, rebase, or cherry-pick is in progress."
        ));
    }
    let mut stages = Stages {
        base: None,
        ours: None,
        theirs: None,
    };
    for line in listing.lines() {
        let Some((meta, _)) = line.split_once('\t') else {
            continue;
        };
        let mut parts = meta.split_whitespace();
        let sha = parts.nth(1);
        let stage = parts.next();
        let (Some(sha), Some(stage)) = (sha, stage) else {
            continue;
        };
        let blob = git_bytes(root, &["cat-file", "blob", sha])?;
        match stage {
            "1" => stages.base = Some(blob),
            "2" => stages.ours = Some(blob),
            "3" => stages.theirs = Some(blob),
            _ => {}
        }
    }
    Ok(stages)
}

struct Operation {
    kind: &'static str,
    swap: bool,
}

fn detect_operation(root: &Path) -> Operation {
    if git_path_exists(root, "rebase-merge") || git_path_exists(root, "rebase-apply") {
        Operation {
            kind: "rebase",
            swap: true,
        }
    } else if git_path_exists(root, "CHERRY_PICK_HEAD") {
        Operation {
            kind: "cherry-pick",
            swap: true,
        }
    } else if git_path_exists(root, "MERGE_HEAD") {
        Operation {
            kind: "merge",
            swap: false,
        }
    } else {
        Operation {
            kind: "unknown",
            swap: false,
        }
    }
}

fn branch_labels(root: &Path) -> Labels {
    branch_labels_for(root, &detect_operation(root))
}

fn branch_labels_for(root: &Path, operation: &Operation) -> Labels {
    if operation.kind == "rebase" {
        let yours = read_git_file(root, "rebase-merge/head-name")
            .or_else(|| read_git_file(root, "rebase-apply/head-name"))
            .map(|name| ref_to_branch(&name))
            .unwrap_or_else(|| "Yours".into());
        let theirs = read_git_file(root, "rebase-merge/onto")
            .and_then(|onto| git_text(root, &["name-rev", "--name-only", &onto]).ok())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| "upstream".into());
        return Labels {
            left: yours,
            right: theirs,
        };
    }
    let yours = git_text(root, &["branch", "--show-current"])
        .ok()
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Yours".into());
    let incoming = if operation.kind == "cherry-pick" {
        "CHERRY_PICK_HEAD"
    } else {
        "MERGE_HEAD"
    };
    let theirs = git_text(root, &["name-rev", "--name-only", incoming])
        .ok()
        .filter(|name| !name.is_empty() && name != "undefined")
        .unwrap_or_else(|| "Theirs".into());
    Labels {
        left: yours,
        right: ref_to_branch(&theirs),
    }
}

fn finish(
    merged: &Path,
    repo_root: Option<PathBuf>,
    relative_path: Option<String>,
    local: &[u8],
    base: &[u8],
    remote: &[u8],
    labels: Labels,
) -> Launch {
    let local = match decode_side(local, "local") {
        Ok(text) => text,
        Err(message) => return Launch::Error(message),
    };
    let remote = match decode_side(remote, "remote") {
        Ok(text) => text,
        Err(message) => return Launch::Error(message),
    };
    let base = match decode_side(base, "base") {
        Ok(text) => text,
        Err(message) => return Launch::Error(message),
    };
    let left_eol = detect_eol(&local.text);
    let base_eol = detect_eol(&base.text);
    let right_eol = detect_eol(&remote.text);
    let file_path = relative_path
        .clone()
        .unwrap_or_else(|| merged.display().to_string());
    Launch::Ready(Session {
        output: merged.to_path_buf(),
        had_bom: local.had_bom,
        repo_root,
        relative_path,
        payload: InitPayload {
            language_id: language_id(merged),
            file_path,
            left: normalize_eol(&local.text),
            base: normalize_eol(&base.text),
            right: normalize_eol(&remote.text),
            labels,
            eol: EolInfo {
                conflict: !(left_eol == base_eol && base_eol == right_eol),
                suggested: left_eol,
                left: left_eol,
                base: base_eol,
                right: right_eol,
            },
            settings: Settings {
                auto_apply_non_conflicting: false,
                font: FontSettings {
                    size: 13,
                    family: "Menlo, ui-monospace, SF Mono, monospace".into(),
                    ligatures: false,
                },
            },
        },
    })
}

struct Decoded {
    text: String,
    had_bom: bool,
}

fn decode_side(bytes: &[u8], label: &str) -> Result<Decoded, String> {
    if looks_binary(bytes) {
        return Err(format!(
            "the {label} side is binary — Merge Forge only opens text files"
        ));
    }
    if bytes.len() > MAX_BYTES {
        return Err(format!("the {label} side is over 10 MB"));
    }
    let had_bom = bytes.starts_with(&[0xEF, 0xBB, 0xBF]);
    let raw = if had_bom { &bytes[3..] } else { bytes };
    let text =
        String::from_utf8(raw.to_vec()).map_err(|_| format!("the {label} side is not UTF-8"))?;
    Ok(Decoded { text, had_bom })
}

fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8000).any(|byte| *byte == 0)
}

fn detect_eol(text: &str) -> Eol {
    let mut crlf = 0;
    let mut lf = 0;
    let bytes = text.as_bytes();
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'\n' {
            if index > 0 && bytes[index - 1] == b'\r' {
                crlf += 1;
            } else {
                lf += 1;
            }
        }
    }
    if crlf > lf {
        Eol::Crlf
    } else {
        Eol::Lf
    }
}

fn normalize_eol(text: &str) -> String {
    text.replace("\r\n", "\n")
}

fn encode_result(content: &str, eol: &str, had_bom: bool) -> Vec<u8> {
    let without_bom = content.strip_prefix('\u{feff}').unwrap_or(content);
    let text = if eol.eq_ignore_ascii_case("crlf") {
        without_bom.replace('\n', "\r\n")
    } else {
        without_bom.to_string()
    };
    let mut out = Vec::with_capacity(text.len() + 3);
    if had_bom {
        out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    out.extend_from_slice(text.as_bytes());
    out
}

fn language_id(path: &Path) -> String {
    match path.extension().and_then(|ext| ext.to_str()).unwrap_or("") {
        "ts" | "tsx" | "mts" | "cts" => "typescript",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "json" => "json",
        "css" => "css",
        "scss" => "scss",
        "html" | "htm" => "html",
        "md" | "mdx" => "markdown",
        "rs" => "rust",
        "py" => "python",
        "go" => "go",
        "yml" | "yaml" => "yaml",
        "toml" => "toml",
        "sh" | "bash" | "zsh" => "shell",
        "vue" => "html",
        _ => "plaintext",
    }
    .into()
}

fn read_required(path: &Path, label: &str) -> Result<Vec<u8>, String> {
    fs::read(path)
        .map_err(|error| format!("could not read {label} file {}: {error}", path.display()))
}

fn repo_root(path: &Path) -> Option<PathBuf> {
    let start = path.parent()?;
    let text = git_text(start, &["rev-parse", "--show-toplevel"]).ok()?;
    let root = text.trim();
    if root.is_empty() {
        None
    } else {
        Some(PathBuf::from(root))
    }
}

fn relative_to(root: &Path, path: &Path) -> Option<String> {
    let absolute = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let root = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    absolute
        .strip_prefix(&root)
        .ok()
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
}

fn stage_if_conflicted(root: &Path, relative: &str) -> Result<(), String> {
    let listing = git_text(root, &["ls-files", "-u", "--", relative])?;
    if listing.trim().is_empty() {
        return Ok(());
    }
    git_text(root, &["add", "--", relative])?;
    Ok(())
}

fn git_path_exists(root: &Path, name: &str) -> bool {
    let Ok(rel) = git_text(root, &["rev-parse", "--git-path", name]) else {
        return false;
    };
    let path = PathBuf::from(rel.trim());
    let full = if path.is_absolute() {
        path
    } else {
        root.join(path)
    };
    full.exists()
}

fn read_git_file(root: &Path, name: &str) -> Option<String> {
    let rel = git_text(root, &["rev-parse", "--git-path", name]).ok()?;
    let path = PathBuf::from(rel.trim());
    let full = if path.is_absolute() {
        path
    } else {
        root.join(path)
    };
    let text = fs::read_to_string(full).ok()?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn ref_to_branch(reference: &str) -> String {
    reference
        .trim()
        .trim_start_matches("refs/heads/")
        .trim_start_matches("refs/remotes/")
        .to_string()
}

fn git_text(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let bytes = git_bytes(cwd, args)?;
    String::from_utf8(bytes)
        .map(|text| text.trim().to_string())
        .map_err(|error| error.to_string())
}

fn git_bytes(cwd: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .map_err(|error| format!("git is not available: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.trim();
        return Err(if detail.is_empty() {
            format!("git {} failed", args.join(" "))
        } else {
            detail.to_string()
        });
    }
    Ok(output.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_fork_arguments_and_ignores_flags() {
        let parsed = parse_positionals([
            "--reuse-window".into(),
            "--wait".into(),
            "\"local.ts\"".into(),
            "remote.ts".into(),
            "base.ts".into(),
            "\"merged.ts\"".into(),
        ]);
        match parsed {
            Parsed::Files {
                local,
                remote,
                base,
                merged,
            } => {
                assert_eq!(local, PathBuf::from("local.ts"));
                assert_eq!(remote, PathBuf::from("remote.ts"));
                assert_eq!(base, PathBuf::from("base.ts"));
                assert_eq!(merged, PathBuf::from("merged.ts"));
            }
            _ => panic!("expected four paths"),
        }
    }

    #[test]
    fn one_path_uses_git_mode() {
        assert!(matches!(
            parse_positionals(["--wait".into(), "/tmp/file.ts".into()]),
            Parsed::Git { .. }
        ));
    }

    #[test]
    fn round_trips_crlf_and_bom() {
        let encoded = encode_result("a\nb\n", "crlf", true);
        assert_eq!(encoded, b"\xEF\xBB\xBFa\r\nb\r\n");
        assert!(matches!(detect_eol("a\r\nb\r\n"), Eol::Crlf));
        assert_eq!(normalize_eol("a\r\nb\n"), "a\nb\n");
    }

    #[test]
    fn loads_three_temp_files() {
        let dir = std::env::temp_dir().join(format!("merge-forge-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let local = dir.join("local.ts");
        let remote = dir.join("remote.ts");
        let base = dir.join("base.ts");
        let merged = dir.join("merged.ts");
        fs::write(&local, "const a = 1;\n").unwrap();
        fs::write(&remote, "const a = 2;\n").unwrap();
        fs::write(&base, "const a = 0;\n").unwrap();
        fs::write(&merged, "<<<<<<<\n").unwrap();

        let launch = load_files(&local, &remote, &base, &merged);
        let Launch::Ready(session) = launch else {
            panic!("expected a session");
        };
        assert_eq!(session.payload.language_id, "typescript");
        assert!(session.payload.left.contains("const a = 1"));
        session.write_result("const a = 3;\n", "lf").unwrap();
        assert_eq!(fs::read_to_string(&merged).unwrap(), "const a = 3;\n");
        let _ = fs::remove_dir_all(&dir);
    }
}
