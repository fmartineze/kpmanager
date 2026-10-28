import { FormEvent, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, errMsg, Vault } from "../api";
import { useT } from "../i18n";
import { Modal } from "./Modal";
import { IconEdit, IconKey, IconPlus, IconTrash } from "./Icons";
import { Alert, Check, Note } from "./ui";

interface Props {
  vault: Vault | null;
  onClose: () => void;
  onSaved: (msg: string) => void;
}

export function VaultForm({ vault, onClose, onSaved }: Props) {
  const t = useT();
  const [client, setClient] = useState(vault?.client ?? "");
  const [path, setPath] = useState(vault?.path ?? "");
  const [keyfile, setKeyfile] = useState(vault?.keyfile ?? "");
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [defaultKeyfile, setDefaultKeyfile] = useState<string | null>(null);

  // Un vault nuevo arranca con la keyfile predeterminada; en uno existente solo se ofrece.
  useEffect(() => {
    api.getSettings().then((s) => {
      setDefaultKeyfile(s.defaultKeyfile);
      if (!vault && s.defaultKeyfile) setKeyfile((k) => k || s.defaultKeyfile!);
    });
  }, [vault]);

  async function pick(setter: (s: string) => void, kdbx: boolean) {
    const sel = await open({
      multiple: false,
      directory: false,
      filters: kdbx ? [{ name: "KeePass", extensions: ["kdbx"] }] : undefined,
    });
    if (typeof sel === "string") setter(sel);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const input = { client, path, keyfile: keyfile || null, password: password || null, clearPassword };
    setBusy(true);
    try {
      if (vault) await api.updateVault(vault.id, input);
      else await api.addVault(input);
      onSaved(vault ? t("toast.saved") : t("toast.added"));
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  }

  async function remove() {
    if (!vault) return;
    try {
      await api.deleteVault(vault.id);
      onSaved(t("toast.removed", { name: vault.client }));
    } catch (err) {
      setError(errMsg(err));
    }
  }

  const footer = confirmDelete ? (
    <div className="confirm">
      <div className="confirm-row">
        <span className="confirm-q"><IconTrash className="s16" /> {t("form.confirmQ", { name: vault?.client ?? "" })}</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(false)}>{t("form.no")}</button>
        <button type="button" className="btn btn-danger-solid btn-sm" onClick={remove}>{t("form.yesDelete")}</button>
      </div>
      <div className="note">{t("form.deleteNote")}</div>
    </div>
  ) : (
    <>
      {vault && (
        <button type="button" className="btn btn-danger" onClick={() => setConfirmDelete(true)}>
          <IconTrash className="s16" /> {t("form.delete")}
        </button>
      )}
      <span className="grow" />
      <button type="button" className="btn btn-ghost" onClick={onClose}>{t("common.cancel")}</button>
      <button type="submit" form="vault-form" className="btn btn-primary" disabled={busy || !client.trim() || !path.trim()}>
        {t("common.save")}
      </button>
    </>
  );

  return (
    <Modal
      title={vault ? t("form.titleEdit") : t("form.titleNew")}
      subtitle={vault ? vault.client : t("form.subNew")}
      icon={vault ? <IconEdit className="s16" /> : <IconPlus className="s16" />}
      onClose={onClose}
      footer={footer}
    >
      <form id="vault-form" onSubmit={submit} style={{ display: "contents" }}>
        <div className="field">
          <label className="label" htmlFor="v-client">{t("form.client")}</label>
          <div className="input"><input id="v-client" className="input-el" autoFocus value={client} onChange={(e) => setClient(e.target.value)} /></div>
        </div>
        <div className="field">
          <label className="label" htmlFor="v-path">{t("form.file")}</label>
          <div className="input-row">
            <div className="input"><input id="v-path" className="input-el mono" value={path} onChange={(e) => setPath(e.target.value)} /></div>
            <button type="button" className="btn btn-secondary" onClick={() => pick(setPath, true)}>{t("common.browse")}</button>
          </div>
        </div>
        <div className="field">
          <label className="label" htmlFor="v-key">{t("form.keyfile")} <em>{t("common.optional")}</em></label>
          <div className="input-row">
            <div className="input"><input id="v-key" className="input-el mono" value={keyfile} onChange={(e) => setKeyfile(e.target.value)} /></div>
            <button type="button" className="btn btn-secondary" onClick={() => pick(setKeyfile, false)}>{t("common.browse")}</button>
          </div>
          {defaultKeyfile && keyfile !== defaultKeyfile && (
            <button type="button" className="btn btn-link suggest" onClick={() => setKeyfile(defaultKeyfile)} title={defaultKeyfile}>
              <IconKey className="s14" /> {t("form.useDefaultKey")}
            </button>
          )}
        </div>
        <div className="field">
          <label className="label" htmlFor="v-pw">{t("form.password")} <em>{t("common.optional")}</em></label>
          <div className={`input ${clearPassword ? "is-disabled" : ""}`}>
            <IconKey className="s16" />
            <input
              id="v-pw"
              className="input-el"
              type="password"
              autoComplete="off"
              value={password}
              disabled={clearPassword}
              placeholder={vault?.hasPassword ? t("form.pwSaved") : ""}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {vault?.hasPassword && (
            <Check checked={clearPassword} onChange={setClearPassword}>{t("form.clearPw")}</Check>
          )}
        </div>
        {!vault && <Note>{t("form.note")}</Note>}
        {error && <Alert kind="err">{error}</Alert>}
      </form>
    </Modal>
  );
}
