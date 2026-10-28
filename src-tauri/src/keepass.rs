//! Detección y lanzamiento de KeePassXC. Todo el código específico de SO vive aquí.

use std::env;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::error::{AppError, Result};
use crate::model::{Executable, Vault};

/// Primer candidato que existe como fichero.
pub fn first_existing(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates.iter().find(|p| p.is_file()).cloned()
}

/// Busca `name` en las carpetas de `path_var` (formato de la variable PATH).
#[cfg_attr(windows, allow(dead_code))]
pub fn find_in_path(name: &str, path_var: &std::ffi::OsStr) -> Option<PathBuf> {
    env::split_paths(path_var)
        .map(|d| d.join(name))
        .find(|p| p.is_file())
}

#[cfg(windows)]
fn candidates() -> Vec<PathBuf> {
    let mut v = Vec::new();
    for var in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
        if let Some(base) = env::var_os(var) {
            v.push(Path::new(&base).join("KeePassXC").join("KeePassXC.exe"));
        }
    }
    if let Some(base) = env::var_os("LOCALAPPDATA") {
        v.push(Path::new(&base).join("Programs").join("KeePassXC").join("KeePassXC.exe"));
    }
    v.extend(registry_candidates());
    v
}

#[cfg(windows)]
fn registry_candidates() -> Vec<PathBuf> {
    use winreg::{RegKey, enums::*};
    let mut out = Vec::new();
    let uninstall = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";
    for hive in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        let Ok(root) = RegKey::predef(hive).open_subkey(uninstall) else { continue };
        for name in root.enum_keys().flatten() {
            let Ok(key) = root.open_subkey(&name) else { continue };
            let display: String = key.get_value("DisplayName").unwrap_or_default();
            if display.starts_with("KeePassXC") {
                if let Ok(loc) = key.get_value::<String, _>("InstallLocation") {
                    out.push(Path::new(&loc).join("KeePassXC.exe"));
                }
            }
        }
    }
    out
}

#[cfg(target_os = "macos")]
fn candidates() -> Vec<PathBuf> {
    let mut v = vec![PathBuf::from("/Applications/KeePassXC.app/Contents/MacOS/KeePassXC")];
    if let Some(home) = env::var_os("HOME") {
        v.push(Path::new(&home).join("Applications/KeePassXC.app/Contents/MacOS/KeePassXC"));
    }
    v
}

#[cfg(all(unix, not(target_os = "macos")))]
fn candidates() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = Vec::new();
    if let Some(p) = env::var_os("PATH").and_then(|p| find_in_path("keepassxc", &p)) {
        v.push(p);
    }
    v.extend(["/usr/bin/keepassxc", "/usr/local/bin/keepassxc", "/snap/bin/keepassxc"].map(PathBuf::from));
    if let Some(home) = env::var_os("HOME") {
        let apps = Path::new(&home).join("Applications");
        if let Ok(rd) = std::fs::read_dir(&apps) {
            v.extend(rd.flatten().map(|e| e.path()).filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("KeePassXC") && n.ends_with(".AppImage"))
            }));
        }
    }
    v
}

#[cfg(all(unix, not(target_os = "macos")))]
fn flatpak() -> Option<Executable> {
    let ok = Command::new("flatpak")
        .args(["info", "org.keepassxc.KeePassXC"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success());
    ok.then(|| Executable {
        program: PathBuf::from("flatpak"),
        args_prefix: vec!["run".into(), "org.keepassxc.KeePassXC".into()],
    })
}

#[cfg(not(all(unix, not(target_os = "macos"))))]
fn flatpak() -> Option<Executable> {
    None
}

/// Autodetecta KeePassXC en el sistema operativo actual.
pub fn detect() -> Option<Executable> {
    first_existing(&candidates()).map(Executable::from_program).or_else(flatpak)
}

#[cfg(windows)]
fn detach(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
}

#[cfg(unix)]
fn detach(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    // Nueva sesión: KeePassXC sobrevive al cierre de la app.
    unsafe {
        cmd.pre_exec(|| {
            if libc_setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

#[cfg(unix)]
unsafe extern "C" {
    #[link_name = "setsid"]
    fn libc_setsid() -> i32;
}

/// Argumentos (sin el prefijo del ejecutable) para abrir `vault`.
pub fn build_args(vault: &Vault) -> Vec<std::ffi::OsString> {
    let mut args: Vec<std::ffi::OsString> = Vec::new();
    if vault.password.as_ref().is_some_and(|p| !p.is_empty()) {
        args.push("--pw-stdin".into());
    }
    if let Some(kf) = &vault.keyfile {
        args.push("--keyfile".into());
        args.push(kf.into());
    }
    args.push(vault.path.clone().into());
    args
}

/// Lanza KeePassXC con el vault. La contraseña viaja por stdin, nunca por la línea de comandos.
pub fn open(exe: &Executable, vault: &Vault) -> Result<()> {
    if !Path::new(&vault.path).is_file() {
        return Err(AppError::msg_arg("fileMissing", vault.path.display().to_string()));
    }
    let mut cmd = Command::new(&exe.program);
    cmd.args(&exe.args_prefix).args(build_args(vault));
    cmd.stdout(Stdio::null()).stderr(Stdio::null());
    let password = vault.password.as_ref().filter(|p| !p.is_empty());
    cmd.stdin(if password.is_some() { Stdio::piped() } else { Stdio::null() });
    detach(&mut cmd);

    let mut child = cmd.spawn()?;
    if let (Some(pw), Some(mut stdin)) = (password, child.stdin.take()) {
        let mut line = zeroize::Zeroizing::new(Vec::with_capacity(pw.len() + 1));
        line.extend_from_slice(pw.as_bytes());
        line.push(b'\n');
        // Si KeePassXC cierra stdin antes (instancia ya abierta), no es un error fatal.
        let _ = stdin.write_all(&line);
    }
    // Recoge el proceso hijo para no dejar zombis en Unix.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use zeroize::Zeroizing;

    fn vault(pw: Option<&str>, kf: Option<&str>) -> Vault {
        Vault {
            id: "1".into(),
            client: "c".into(),
            path: "a.kdbx".into(),
            keyfile: kf.map(Into::into),
            password: pw.map(|p| Zeroizing::new(p.to_string())),
            ..Default::default()
        }
    }

    #[test]
    fn args_never_contain_password() {
        let args = build_args(&vault(Some("secreto"), Some("k.key")));
        let s: Vec<_> = args.iter().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(s, ["--pw-stdin", "--keyfile", "k.key", "a.kdbx"]);
    }

    #[test]
    fn args_without_credentials() {
        let s = build_args(&vault(None, None));
        assert_eq!(s, vec![std::ffi::OsString::from("a.kdbx")]);
    }

    #[test]
    fn first_existing_picks_real_file() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("kp");
        std::fs::write(&f, b"").unwrap();
        let got = first_existing(&[dir.path().join("nope"), f.clone()]);
        assert_eq!(got, Some(f));
        assert_eq!(first_existing(&[dir.path().join("nope")]), None);
    }

    #[test]
    fn find_in_path_works() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("tool"), b"").unwrap();
        let var = env::join_paths([dir.path()]).unwrap();
        assert!(find_in_path("tool", &var).is_some());
        assert!(find_in_path("otro", &var).is_none());
    }
}
