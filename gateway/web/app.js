"use strict";

/* Drop — browser front end. Talks to depot-gw, which relays to dufs.
 *
 * The constraint that shapes the whole upload path: Cloudflare rejects any
 * request body over 100MB and a proxied record cannot opt out. So every file
 * goes up in slices — the first as PUT, the rest as PATCH with
 * `X-Update-Range: append`, which dufs stitches back together. Welcome side
 * effect: an interruption only costs the slice in flight, and pausing is free.
 */

const CHUNK = 32 * 1024 * 1024;   // comfortable margin under the 100MB cap
const PARALLEL = 2;               // beyond this, uploads just steal each other's bandwidth

const $ = (id) => document.getElementById(id);

/* ── translations ─────────────────────────────────────────────────── */

const I18N = {
  en: {
    login_sub: "Private file drop", field_user: "Username", field_password: "Password",
    pw_show: "Show password", pw_hide: "Hide password", sign_in: "Sign in", sign_out: "Sign out",
    signed_in_as: "Signed in as {0}", breadcrumb: "Path", filter: "Filter…", account: "Account",
    view: "View", view_list: "List", view_grid: "Grid",
    send_files: "Upload files", send_folder: "Upload a folder", new_folder: "New folder",
    root: "Drop", col_name: "Name", col_size: "Size", col_date: "Modified",
    empty_title: "This folder is empty",
    empty_sub: "Drop files anywhere on the page to upload them.",
    uploads: "Uploads", clear: "Clear", drop_here: "Drop to upload",
    download: "Download", rename: "Rename", delete: "Delete", cancel: "Cancel",
    pause: "Pause", resume: "Resume", retry: "Retry", close: "Close",
    quota: "{0} used of {1} · {2} free",
    n_done: "{0} done", n_of_m: "{0}/{1}", n_done_m_failed: "{0} done, {1} failed",
    up_waiting: "Waiting", up_paused: "Paused", up_done: "Done",
    up_progress: "{0}% · {1} of {2}", up_rate: "{1}/s · {0} left",
    ask_rename: "Rename", ask_new_folder: "New folder", folder_name: "Folder name",
    ask_delete: "Delete?", ask_delete_body: "“{0}” will be deleted permanently.",
    created: "Folder created", renamed: "Renamed", deleted: "Deleted",
    err_login: "Wrong username or password", err_throttled: "Too many attempts, try again in {0}s",
    err_session: "Session expired, please sign in again", err_generic: "Something went wrong",
    err_list: "Could not list this folder ({0})", err_mkdir: "Could not create the folder ({0})",
    err_delete: "Could not delete ({0})", err_rename: "Could not rename ({0})",
    err_status: "Error {0}", err_conn: "Connection lost", err_slice: "Slice rejected ({0})",
    err_aborted: "Interrupted", preview_loading: "Loading…", preview_none: "Preview unavailable.",
    preview_cut: "… (preview truncated)",
    unit_b: "B", unit_kb: "KB", unit_mb: "MB", unit_gb: "GB", unit_tb: "TB",
    dur_s: "{0}s", dur_min: "{0} min", dur_h: "{0}h {1}min", dur_unknown: "—",
    change_password: "Change password", manage_accounts: "Accounts",
    pw_current: "Current password", pw_new: "New password", pw_saved: "Password changed",
    acc_title: "Accounts", acc_add: "Add an account", acc_name: "Username",
    acc_folder: "Folder", acc_folder_hint: "leave empty for the whole drop",
    acc_admin: "Administrator", acc_whole: "whole drop", acc_you: "you",
    acc_created: "Account created", acc_updated: "Account updated", acc_deleted: "Account deleted",
    acc_reset: "Reset password", acc_move: "Change folder", acc_promote: "Make administrator",
    acc_demote: "Remove administrator",
    acc_del_body: "“{0}” loses access immediately. Their files are not deleted.",
    err_name: "Letters, digits, dot, dash or underscore, up to 32 characters",
    err_weak: "At least {0} characters", err_exists: "That name is already taken",
    err_last_admin: "This is the last administrator", err_not_yourself: "You cannot delete your own account",
    err_not_admin: "Administrator only", err_outside: "Outside your folder",
  },
  fr: {
    login_sub: "Espace de dépôt privé", field_user: "Identifiant", field_password: "Mot de passe",
    pw_show: "Afficher le mot de passe", pw_hide: "Masquer le mot de passe",
    sign_in: "Se connecter", sign_out: "Se déconnecter",
    signed_in_as: "Connecté en tant que {0}", breadcrumb: "Chemin", filter: "Filtrer…",
    account: "Compte", view: "Affichage", view_list: "Liste", view_grid: "Grille",
    send_files: "Envoyer des fichiers", send_folder: "Envoyer un dossier", new_folder: "Nouveau dossier",
    root: "Dépôt", col_name: "Nom", col_size: "Taille", col_date: "Modifié",
    empty_title: "Ce dossier est vide",
    empty_sub: "Glissez des fichiers n’importe où sur la page pour les envoyer.",
    uploads: "Envois", clear: "Effacer", drop_here: "Déposez pour envoyer",
    download: "Télécharger", rename: "Renommer", delete: "Supprimer", cancel: "Annuler",
    pause: "Suspendre", resume: "Reprendre", retry: "Reprendre", close: "Fermer",
    quota: "{0} utilisés sur {1} · {2} libres",
    n_done: "{0} terminé", n_of_m: "{0}/{1}", n_done_m_failed: "{0} terminé, {1} en échec",
    up_waiting: "En attente", up_paused: "Suspendu", up_done: "Terminé",
    up_progress: "{0}% · {1} sur {2}", up_rate: "{1}/s · {0} restantes",
    ask_rename: "Renommer", ask_new_folder: "Nouveau dossier", folder_name: "Nom du dossier",
    ask_delete: "Supprimer ?", ask_delete_body: "« {0} » sera supprimé définitivement.",
    created: "Dossier créé", renamed: "Renommé", deleted: "Supprimé",
    err_login: "Identifiants incorrects", err_throttled: "Trop de tentatives, réessayez dans {0} s",
    err_session: "Session expirée, reconnectez-vous", err_generic: "Une erreur est survenue",
    err_list: "Liste indisponible ({0})", err_mkdir: "Création refusée ({0})",
    err_delete: "Suppression refusée ({0})", err_rename: "Renommage refusé ({0})",
    err_status: "Erreur {0}", err_conn: "Connexion interrompue", err_slice: "Tranche refusée ({0})",
    err_aborted: "Interrompu", preview_loading: "Chargement…", preview_none: "Aperçu impossible.",
    preview_cut: "… (aperçu tronqué)",
    unit_b: "o", unit_kb: "Ko", unit_mb: "Mo", unit_gb: "Go", unit_tb: "To",
    dur_s: "{0} s", dur_min: "{0} min", dur_h: "{0} h {1} min", dur_unknown: "—",
    change_password: "Changer mon mot de passe", manage_accounts: "Comptes",
    pw_current: "Mot de passe actuel", pw_new: "Nouveau mot de passe", pw_saved: "Mot de passe changé",
    acc_title: "Comptes", acc_add: "Ajouter un compte", acc_name: "Identifiant",
    acc_folder: "Dossier", acc_folder_hint: "vide pour tout le dépôt",
    acc_admin: "Administrateur", acc_whole: "tout le dépôt", acc_you: "vous",
    acc_created: "Compte créé", acc_updated: "Compte modifié", acc_deleted: "Compte supprimé",
    acc_reset: "Réinitialiser le mot de passe", acc_move: "Changer de dossier",
    acc_promote: "Nommer administrateur", acc_demote: "Retirer l’administration",
    acc_del_body: "« {0} » perd l’accès immédiatement. Ses fichiers ne sont pas supprimés.",
    err_name: "Lettres, chiffres, point, tiret ou tiret bas, 32 caractères au plus",
    err_weak: "Au moins {0} caractères", err_exists: "Cet identifiant est déjà pris",
    err_last_admin: "C’est le dernier administrateur", err_not_yourself: "Vous ne pouvez pas supprimer votre propre compte",
    err_not_admin: "Réservé à l’administrateur", err_outside: "Hors de votre dossier",
  },
};

let LANG = "en";

function t(key, ...args) {
  const dict = I18N[LANG] || I18N.en;
  let s = dict[key] ?? I18N.en[key] ?? key;
  args.forEach((v, i) => { s = s.split(`{${i}}`).join(v); });
  return s;
}

/** Applies the dictionary to every marked node in the static markup. */
function translateDOM() {
  document.documentElement.lang = LANG;
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
  for (const el of document.querySelectorAll("[data-i18n-aria]")) {
    el.setAttribute("aria-label", t(el.dataset.i18nAria));
  }
  for (const el of document.querySelectorAll("[data-i18n-title]")) el.title = t(el.dataset.i18nTitle);
}

const state = {
  path: "/",
  // A confined account is served a subfolder as its whole world. `base` is that
  // folder; every path stays inside it. The server enforces this on every
  // request too — this is only so the interface does not offer a door that
  // would be refused anyway.
  root: "",
  base: "/",
  admin: false,
  entries: [],
  sort: { key: "name", dir: 1 },
  grid: localStorage.getItem("drop.view") === "grid",
  filter: "",
  user: null,
};

/* ── API ──────────────────────────────────────────────────────────── */

const api = {
  url(p, query = "") {
    // The trailing slash matters: without it dufs answers a redirect to the
    // slashed form, and that Location points outside /api/fs.
    const trailing = p.endsWith("/");
    const clean = p.split("/").filter(Boolean).map(encodeURIComponent).join("/");
    return "/api/fs/" + clean + (trailing && clean ? "/" : "") + query;
  },

  async json(p) {
    const dir = p.endsWith("/") ? p : p + "/";
    const r = await fetch(api.url(dir, "?json"), { headers: { Accept: "application/json" } });
    if (r.status === 401) throw new SessionLost();
    if (!r.ok) throw new Error(t("err_list", r.status));
    return r.json();
  },

  async mkdir(p) {
    const r = await fetch(api.url(p), { method: "MKCOL", headers: { "X-Depot": "1" } });
    // 405 means it already exists, which suits us fine.
    if (!r.ok && r.status !== 405) throw new Error(t("err_mkdir", r.status));
  },

  async remove(p) {
    const r = await fetch(api.url(p), { method: "DELETE", headers: { "X-Depot": "1" } });
    if (r.status === 401) throw new SessionLost();
    if (!r.ok) throw new Error(t("err_delete", r.status));
  },

  async move(from, to) {
    const r = await fetch(api.url(from), {
      method: "MOVE",
      headers: { "X-Depot": "1", Destination: location.origin + api.url(to) },
    });
    if (r.status === 401) throw new SessionLost();
    if (!r.ok) throw new Error(t("err_rename", r.status));
  },

  async size(p) {
    const r = await fetch(api.url(p), { method: "HEAD" });
    if (!r.ok) return 0;
    return parseInt(r.headers.get("content-length") || "0", 10) || 0;
  },

  async quota() {
    const r = await fetch("/api/quota");
    return r.ok ? r.json() : { available: false };
  },
};

class SessionLost extends Error {
  constructor() {
    super("session_expired");
  }
}

/* ── formatting ───────────────────────────────────────────────────── */

function bytes(n) {
  const units = ["unit_b", "unit_kb", "unit_mb", "unit_gb", "unit_tb"];
  if (!n) return `0 ${t("unit_b")}`;
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${t(units[i])}`;
}

function when(ms) {
  const d = new Date(ms);
  const days = (Date.now() - ms) / 86400000;
  const loc = LANG === "fr" ? "fr-FR" : "en-GB";
  if (days < 1) return d.toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit" });
  if (days < 300) {
    return d.toLocaleDateString(loc, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString(loc, { day: "numeric", month: "short", year: "numeric" });
}

function duration(sec) {
  if (!isFinite(sec) || sec < 0) return t("dur_unknown");
  if (sec < 60) return t("dur_s", Math.ceil(sec));
  if (sec < 3600) return t("dur_min", Math.round(sec / 60));
  return t("dur_h", Math.floor(sec / 3600), Math.round((sec % 3600) / 60));
}

// Accent- and case-insensitive ordering, so "Été" sorts next to "ete" instead of
// wherever its UTF-16 code points happen to fall.
let collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

function fold(s) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/* ── icons ────────────────────────────────────────────────────────── */

const svg = (paths, extra = "") =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
     stroke-linecap="round" stroke-linejoin="round" ${extra}>${paths}</svg>`;

const ICON = {
  dir: svg(`<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4L10 8h9.5A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-10Z"/>`),
  file: svg(`<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"/><path d="M14 3v5h5"/>`),
  video: svg(`<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9.5 5 2.5-5 2.5v-5Z"/>`),
  image: svg(`<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m4 18 5-4.5 4 3.5 3-2.5 4 3.5"/>`),
  audio: svg(`<path d="M9 18V7l10-2v11"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>`),
  archive: svg(`<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v6M10 10h4M10 13h4"/>`),
  text: svg(`<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"/><path d="M9 13h6M9 16h4"/>`),
  download: svg(`<path d="M12 4v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M5 19h14"/>`),
  trash: svg(`<path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6 7l1 13h10l1-13"/>`),
  pencil: svg(`<path d="M4 20h4l10-10-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/>`),
  x: svg(`<path d="M6 6l12 12M18 6 6 18"/>`),
  pause: svg(`<path d="M9 5v14M15 5v14"/>`),
  play: svg(`<path d="M7 5l12 7-12 7V5Z"/>`),
  retry: svg(`<path d="M20 12a8 8 0 1 1-2.5-5.8"/><path d="M20 4v4h-4"/>`),
};

const EXT = {
  video: ["mp4", "mkv", "avi", "mov", "webm", "m4v", "wmv", "flv", "ts", "mpg", "mpeg"],
  image: ["jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "svg", "heic"],
  audio: ["mp3", "flac", "wav", "ogg", "m4a", "aac", "opus"],
  archive: ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "iso"],
  text: ["txt", "md", "log", "json", "yml", "yaml", "csv", "srt", "vtt", "nfo", "xml", "ini", "conf"],
};

function ext(name) {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

function kindOf(name) {
  const e = ext(name);
  for (const [k, list] of Object.entries(EXT)) if (list.includes(e)) return k;
  return "file";
}

/* ── notices ──────────────────────────────────────────────────────── */

function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = "toast" + (kind ? ` is-${kind}` : "");
  el.textContent = msg;
  $("toasts").append(el);
  setTimeout(() => {
    el.style.transition = "opacity .3s, transform .3s";
    el.style.opacity = "0";
    el.style.transform = "translateY(6px)";
    setTimeout(() => el.remove(), 320);
  }, kind === "bad" ? 5200 : 2600);
}

/* Stands in for confirm() and prompt(), whose appearance the browser dictates.
 * Resolves with the typed value, or null when dismissed. */
function ask({ title, message, value, placeholder, confirmLabel, danger = false }) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "sheet";
    wrap.innerHTML = `
      <form class="sheet-card">
        <h2>${escapeHTML(title)}</h2>
        ${message ? `<p class="sheet-msg">${escapeHTML(message)}</p>` : ""}
        ${value !== undefined
        ? `<input class="sheet-input" type="text" value="${escapeHTML(value)}"
                  placeholder="${escapeHTML(placeholder || "")}" spellcheck="false">`
        : ""}
        <div class="sheet-actions">
          <button type="button" class="btn btn-ghost" data-cancel>${escapeHTML(t("cancel"))}</button>
          <button type="submit" class="btn ${danger ? "btn-danger" : "btn-primary"}">
            ${escapeHTML(confirmLabel || t("sign_in"))}
          </button>
        </div>
      </form>`;

    const close = (result) => {
      document.removeEventListener("keydown", onKey);
      wrap.remove();
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); close(null); }
    };

    wrap.querySelector("[data-cancel]").onclick = () => close(null);
    wrap.onmousedown = (e) => { if (e.target === wrap) close(null); };
    wrap.querySelector("form").onsubmit = (e) => {
      e.preventDefault();
      const input = wrap.querySelector(".sheet-input");
      close(input ? input.value.trim() : true);
    };
    document.addEventListener("keydown", onKey);
    document.body.append(wrap);
    const input = wrap.querySelector(".sheet-input");
    if (input) { input.focus(); input.select(); }
  });
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ── navigation and rendering ─────────────────────────────────────── */

async function go(p, push = true) {
  let target = p.endsWith("/") ? p : p + "/";
  if (!target.startsWith(state.base)) target = state.base;
  state.path = target;
  if (push) history.pushState({ p: state.path }, "", "#" + state.path);
  document.body.classList.add("is-loading");
  try {
    const data = await api.json(state.path);
    state.entries = data.paths || [];
    renderAll();
  } catch (e) {
    if (e instanceof SessionLost) return sessionLost();
    toast(e.message, "bad");
  } finally {
    document.body.classList.remove("is-loading");
  }
}

function renderAll() {
  renderCrumbs();
  renderListing();
}

function renderCrumbs() {
  // Shown relative to the account's own root: a confined guest should not read
  // the folder name it happens to be pinned to on every screen.
  const rel = state.path.slice(state.base.length);
  const parts = rel.split("/").filter(Boolean);
  const bc = $("breadcrumb");
  bc.innerHTML = "";

  const add = (label, target, last) => {
    const b = document.createElement("button");
    b.className = "crumb" + (last ? " is-last" : "");
    b.textContent = label;
    if (!last) b.onclick = () => go(target);
    bc.append(b);
  };

  add(t("root"), state.base, parts.length === 0);
  parts.forEach((seg, i) => {
    const sep = document.createElement("span");
    sep.className = "crumb-sep";
    sep.textContent = "/";
    bc.append(sep);
    add(decodeURIComponent(seg), state.base + parts.slice(0, i + 1).join("/") + "/", i === parts.length - 1);
  });
  bc.scrollLeft = bc.scrollWidth;
}

function sorted() {
  const { key, dir } = state.sort;
  const needle = fold(state.filter);
  return state.entries
    .filter((e) => !needle || fold(e.name).includes(needle))
    .sort((a, b) => {
      const ad = a.path_type.startsWith("Dir"), bd = b.path_type.startsWith("Dir");
      if (ad !== bd) return ad ? -1 : 1;   // folders first, whatever the sort key
      if (key === "size") return (a.size - b.size) * dir;
      if (key === "date") return (a.mtime - b.mtime) * dir;
      return collator.compare(a.name, b.name) * dir;
    });
}

function renderListing() {
  const list = $("listing");
  const rows = sorted();

  list.className = "listing" + (state.grid ? " is-grid" : "");
  list.innerHTML = "";
  $("empty").hidden = rows.length > 0;
  if (rows.length && !state.grid) list.append(headerRow());

  for (const e of rows) list.append(row(e));
}

function headerRow() {
  const head = document.createElement("div");
  head.className = "list-head";
  const cols = [["", ""], ["name", t("col_name")], ["size", t("col_size")], ["date", t("col_date")]];
  head.innerHTML = cols.map(([k, label], i) => {
    if (!label) return "<span></span>";
    const on = state.sort.key === k;
    const arrow = on ? (state.sort.dir === 1 ? " ↑" : " ↓") : "";
    return `<button class="col-btn${i === 2 ? " num" : ""}${on ? " is-sorted" : ""}"
              data-sort="${k}">${escapeHTML(label)}${arrow}</button>`;
  }).join("") + "<span></span>";

  head.querySelectorAll("[data-sort]").forEach((b) => {
    b.onclick = () => {
      const k = b.dataset.sort;
      state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : 1 };
      renderListing();
    };
  });
  return head;
}

function row(e) {
  const isDir = e.path_type.startsWith("Dir");
  const full = state.path + e.name;
  const kind = isDir ? "dir" : kindOf(e.name);

  const el = document.createElement("div");
  el.className = "row";
  el.tabIndex = 0;
  el.innerHTML = `
    <span class="row-icon${isDir ? " is-dir" : ""}">${ICON[kind] || ICON.file}</span>
    <span class="row-name">${escapeHTML(e.name)}</span>
    <span class="row-size">${isDir ? "—" : bytes(e.size)}</span>
    <span class="row-date">${when(e.mtime)}</span>
    <span class="row-actions">
      <a href="${api.url(full, isDir ? "?zip" : "")}" download="${escapeHTML(e.name)}"
         title="${escapeHTML(t("download"))}" data-stop>${ICON.download}</a>
      <button title="${escapeHTML(t("rename"))}" data-rename>${ICON.pencil}</button>
      <button title="${escapeHTML(t("delete"))}" class="is-danger" data-del>${ICON.trash}</button>
    </span>`;

  const open = () => (isDir ? go(full + "/") : preview(e, full));
  el.onclick = (ev) => { if (!ev.target.closest("[data-stop],button")) open(); };
  el.onkeydown = (ev) => { if (ev.key === "Enter") open(); };

  el.querySelector("[data-rename]").onclick = async () => {
    const name = await ask({ title: t("ask_rename"), value: e.name, confirmLabel: t("rename") });
    if (!name || name === e.name) return;
    try {
      await api.move(full, state.path + name);
      toast(t("renamed"), "ok");
      go(state.path, false);
    } catch (err) {
      err instanceof SessionLost ? sessionLost() : toast(err.message, "bad");
    }
  };

  el.querySelector("[data-del]").onclick = async () => {
    const ok = await ask({
      title: t("ask_delete"), message: t("ask_delete_body", e.name),
      confirmLabel: t("delete"), danger: true,
    });
    if (!ok) return;
    try {
      await api.remove(full);
      toast(t("deleted"), "ok");
      go(state.path, false);
      refreshQuota();
    } catch (err) {
      err instanceof SessionLost ? sessionLost() : toast(err.message, "bad");
    }
  };

  return el;
}

/* ── preview ──────────────────────────────────────────────────────── */

async function preview(entry, full) {
  const kind = kindOf(entry.name);
  const url = api.url(full);

  // Nothing to show for an archive or an opaque binary: just fetch it.
  if (!["video", "image", "audio", "text"].includes(kind) && ext(entry.name) !== "pdf") {
    window.location.href = url;
    return;
  }

  $("modalName").textContent = entry.name;
  $("modalDownload").href = url;
  const stage = $("modalStage");
  stage.innerHTML = "";

  if (kind === "video") {
    const v = document.createElement("video");
    v.src = url; v.controls = true; v.autoplay = true; v.preload = "metadata";
    stage.append(v);
  } else if (kind === "audio") {
    const a = document.createElement("audio");
    a.src = url; a.controls = true; a.autoplay = true;
    stage.append(a);
  } else if (kind === "image") {
    const i = document.createElement("img");
    i.src = url; i.alt = entry.name;
    stage.append(i);
  } else if (ext(entry.name) === "pdf") {
    const f = document.createElement("iframe");
    f.src = url; f.style.cssText = "width:100%;height:100%;border:0;border-radius:10px;background:#fff";
    stage.append(f);
  } else {
    const pre = document.createElement("pre");
    pre.textContent = t("preview_loading");
    stage.append(pre);
    try {
      // A 2GB .log must not land in memory: read the head of it only.
      const r = await fetch(url, { headers: { Range: "bytes=0-524287" } });
      const text = await r.text();
      pre.textContent = text + (entry.size > 524288 ? `\n\n${t("preview_cut")}` : "");
    } catch {
      pre.textContent = t("preview_none");
    }
  }
  $("modal").hidden = false;
}

function closePreview() {
  $("modal").hidden = true;
  $("modalStage").innerHTML = "";   // stops whatever was playing
}

/* ── uploading ────────────────────────────────────────────────────── */

const queue = {
  items: [],
  running: 0,

  add(file, relPath, destDir) {
    const up = new Upload(file, relPath, destDir);
    this.items.push(up);
    $("uploads").hidden = false;
    $("uploadsBody").append(up.el);
    this.pump();
    this.refresh();
    return up;
  },

  pump() {
    while (this.running < PARALLEL) {
      const next = this.items.find((u) => u.status === "waiting");
      if (!next) break;
      this.running++;
      next.run().finally(() => {
        this.running--;
        this.refresh();
        this.pump();
        if (!this.items.some((u) => u.status === "running" || u.status === "waiting")) {
          go(state.path, false);
          refreshQuota();
        }
      });
    }
  },

  refresh() {
    const active = this.items.filter((u) => u.status === "running" || u.status === "waiting");
    const done = this.items.filter((u) => u.status === "done").length;
    const failed = this.items.filter((u) => u.status === "failed").length;

    $("uploadsCount").textContent = active.length
      ? t("n_of_m", done, this.items.length)
      : failed ? t("n_done_m_failed", done, failed) : t("n_done", done);

    const total = this.items.reduce((n, u) => n + u.file.size, 0);
    const sent = this.items.reduce((n, u) => n + u.sent, 0);
    $("uploadsTotalFill").style.width = total ? `${(sent / total) * 100}%` : "0";
  },

  clearFinished() {
    this.items = this.items.filter((u) => {
      const busy = u.status === "running" || u.status === "waiting" || u.status === "paused";
      if (!busy) u.el.remove();
      return busy;
    });
    this.refresh();
    if (!this.items.length) $("uploads").hidden = true;
  },
};

class Upload {
  constructor(file, relPath, destDir) {
    this.file = file;
    this.name = relPath || file.name;
    this.dest = destDir + this.name;
    this.sent = 0;
    this.status = "waiting";      // waiting | running | paused | done | failed
    this.started = false;         // true once a slice has gone out: enables resuming
    this.xhr = null;
    this.lastTick = 0;
    this.lastSent = 0;
    this.speed = 0;
    this.build();
  }

  build() {
    this.el = document.createElement("div");
    this.el.className = "up";
    this.el.innerHTML = `
      <span class="up-name">${escapeHTML(this.name)}</span>
      <span class="up-meta"><span data-state>${escapeHTML(t("up_waiting"))}</span><span data-speed></span></span>
      <span class="up-ctl">
        <button data-pause title="${escapeHTML(t("pause"))}">${ICON.pause}</button>
        <button data-cancel title="${escapeHTML(t("cancel"))}">${ICON.x}</button>
      </span>
      <span class="up-bar"><span data-fill></span></span>`;

    this.$state = this.el.querySelector("[data-state]");
    this.$speed = this.el.querySelector("[data-speed]");
    this.$fill = this.el.querySelector("[data-fill]");
    this.$pause = this.el.querySelector("[data-pause]");
    this.$cancel = this.el.querySelector("[data-cancel]");

    this.$pause.onclick = () => (this.status === "paused" ? this.resume() : this.pause());
    this.$cancel.onclick = () => this.cancel();
  }

  paint(label) {
    const pct = this.file.size ? (this.sent / this.file.size) * 100 : 100;
    this.$fill.style.width = `${pct}%`;
    this.$state.textContent = label
      ?? t("up_progress", Math.floor(pct), bytes(this.sent), bytes(this.file.size));
    this.$speed.textContent =
      this.status === "running" && this.speed > 0
        ? t("up_rate", duration((this.file.size - this.sent) / this.speed), bytes(this.speed))
        : "";
    queue.refresh();
  }

  async run() {
    if (this.status === "cancelled") return;
    this.status = "running";
    this.el.classList.remove("is-failed");
    try {
      // Dropped folders arrive with a relative path: build the tree first rather
      // than assuming the storage will do it for us.
      const dirs = this.name.split("/").slice(0, -1);
      let acc = this.dest.slice(0, this.dest.length - this.name.length);
      for (const d of dirs) {
        acc += d + "/";
        await api.mkdir(acc);
      }

      // Only resume what this very upload started. Asking the server for the
      // size of a brand-new upload would "resume" a same-named file that is
      // already there: its bytes would be kept and the result would be a silent
      // mix of the two.
      if (this.started) {
        this.sent = await api.size(this.dest);
        if (this.sent > this.file.size) this.sent = 0;
      } else {
        this.sent = 0;
      }
      this.started = true;

      while (this.sent < this.file.size) {
        if (this.status !== "running") return;
        const end = Math.min(this.sent + CHUNK, this.file.size);
        await this.sendSlice(this.file.slice(this.sent, end), this.sent);
        this.sent = end;
        this.paint();
      }
      if (this.file.size === 0) await this.sendSlice(this.file, 0);

      this.status = "done";
      this.el.classList.add("is-done");
      this.$pause.remove();
      this.$cancel.remove();
      this.paint(t("up_done"));
      this.$state.classList.add("is-ok");
    } catch (e) {
      if (this.status === "cancelled" || this.status === "paused") return;
      this.status = "failed";
      this.el.classList.add("is-failed");
      this.paint(e instanceof SessionLost ? t("err_session") : (e.message || t("err_generic")));
      this.$state.classList.add("is-bad");
      this.$pause.replaceWith(this.retryButton());
      if (e instanceof SessionLost) sessionLost();
    }
  }

  retryButton() {
    const b = document.createElement("button");
    b.title = t("retry");
    b.innerHTML = ICON.retry;
    b.onclick = () => {
      b.remove();
      this.el.append(this.$pause);
      this.status = "waiting";
      this.$state.classList.remove("is-bad");
      this.paint(t("up_waiting"));
      queue.pump();
    };
    return b;
  }

  sendSlice(blob, offset) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      this.xhr = xhr;
      xhr.open(offset > 0 ? "PATCH" : "PUT", api.url(this.dest));
      xhr.setRequestHeader("X-Depot", "1");
      if (offset > 0) xhr.setRequestHeader("X-Update-Range", "append");

      xhr.upload.onprogress = (ev) => {
        const now = performance.now();
        if (now - this.lastTick < 250) return;
        const live = offset + ev.loaded;
        this.speed = ((live - this.lastSent) / (now - this.lastTick)) * 1000;
        this.lastTick = now;
        this.lastSent = live;
        const keep = this.sent;
        this.sent = live;
        this.paint();
        this.sent = keep;
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else if (xhr.status === 401) reject(new SessionLost());
        else if (xhr.status === 413) reject(new Error(t("err_slice", 413)));
        else reject(new Error(t("err_status", xhr.status)));
      };
      xhr.onerror = () => reject(new Error(t("err_conn")));
      xhr.onabort = () => reject(new Error(t("err_aborted")));
      xhr.send(blob);
    });
  }

  pause() {
    if (this.status !== "running") return;
    this.status = "paused";
    this.xhr?.abort();
    this.$pause.innerHTML = ICON.play;
    this.$pause.title = t("resume");
    this.paint(t("up_paused"));
  }

  resume() {
    this.$pause.innerHTML = ICON.pause;
    this.$pause.title = t("pause");
    this.status = "waiting";
    this.paint(t("up_waiting"));
    queue.pump();
  }

  cancel() {
    const was = this.status;
    this.status = "cancelled";
    this.xhr?.abort();
    this.el.remove();
    queue.items = queue.items.filter((u) => u !== this);
    queue.refresh();
    if (!queue.items.length) $("uploads").hidden = true;
    if (was === "running") queue.pump();
  }
}

function enqueue(files, dir = state.path) {
  for (const f of files) queue.add(f, f.webkitRelativePath || f.name, dir);
}

/* A drop can contain folders; the entries API walks them, which the plain
 * `files` list of a drag-and-drop does not give us. */
async function walkDataTransfer(dt) {
  const out = [];
  const entries = [...dt.items]
    .map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null))
    .filter(Boolean);

  if (!entries.length) return [...dt.files].map((f) => ({ file: f, path: f.name }));

  const visit = (entry, prefix) =>
    new Promise((resolve) => {
      if (entry.isFile) {
        entry.file((f) => { out.push({ file: f, path: prefix + entry.name }); resolve(); }, resolve);
        return;
      }
      const reader = entry.createReader();
      const batch = () =>
        reader.readEntries(async (list) => {
          if (!list.length) return resolve();
          for (const e of list) await visit(e, prefix + entry.name + "/");
          batch();
        }, resolve);
      batch();
    });

  for (const e of entries) await visit(e, "");
  return out;
}

/* ── session ──────────────────────────────────────────────────────── */

function sessionLost() {
  document.body.classList.remove("authed");
  state.user = null;
  toast(t("err_session"), "bad");
}

async function refreshQuota() {
  const q = await api.quota();
  if (!q.available) { $("quotaBox").hidden = true; return; }
  const pct = (q.used / q.total) * 100;
  const fill = $("quotaFill");
  fill.style.width = `${Math.max(pct, 1.5)}%`;
  fill.className = pct > 92 ? "is-bad" : pct > 78 ? "is-warn" : "";
  $("quotaText").textContent = t("quota", bytes(q.used), bytes(q.total), bytes(q.free));
}

function setLang(lang) {
  LANG = I18N[lang] ? lang : (navigator.language || "en").toLowerCase().startsWith("fr") ? "fr" : "en";
  collator = new Intl.Collator(LANG, { numeric: true, sensitivity: "base" });
  translateDOM();
}

async function boot() {
  const r = await fetch("/api/session");
  const s = await r.json();
  setLang(s.lang);
  if (s.title) {
    document.title = s.title;
    $("loginTitle").textContent = s.title;
  }
  document.body.classList.remove("booting");
  if (!s.authenticated) {
    $("loginUser").focus();
    return;
  }
  enterApp(s);
}

function enterApp(s) {
  state.user = s.user;
  state.admin = !!s.admin;
  state.root = s.root || "";
  state.base = state.root ? `/${state.root}/` : "/";
  $("signedInAs").innerHTML = t("signed_in_as", `<strong>${escapeHTML(s.user)}</strong>`);
  $("avatar").textContent = s.user.slice(0, 1);
  $("manageBtn").hidden = !state.admin;
  document.body.classList.add("authed");
  if (state.grid) { $("viewGrid").classList.add("is-on"); $("viewList").classList.remove("is-on"); }
  const start = decodeURIComponent(location.hash.slice(1));
  go(start.startsWith(state.base) ? start : state.base, false);
  refreshQuota();
}

/* ── accounts ─────────────────────────────────────────────────────── */

/** Bare overlay both panels below sit in. Returns a close function. */
function sheet(inner, wide = false) {
  const wrap = document.createElement("div");
  wrap.className = "sheet";
  wrap.innerHTML = `<div class="sheet-card${wide ? " is-wide" : ""}">${inner}</div>`;
  const close = () => {
    document.removeEventListener("keydown", onKey);
    wrap.remove();
  };
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
  wrap.onmousedown = (e) => { if (e.target === wrap) close(); };
  document.addEventListener("keydown", onKey);
  document.body.append(wrap);
  return { wrap, close };
}

/** Turns a server error code into a sentence from the dictionary. */
function apiError(data, status) {
  switch (data?.error) {
    case "bad_name": return t("err_name");
    case "weak_password": return t("err_weak", 10);
    case "exists": return t("err_exists");
    case "last_admin": return t("err_last_admin");
    case "not_yourself": return t("err_not_yourself");
    case "not_admin": return t("err_not_admin");
    case "outside_root": return t("err_outside");
    case "bad_credentials": return t("err_login");
    case "throttled": return t("err_throttled", data.retry_after || 60);
    case "session_expired": return t("err_session");
    default: return t("err_status", status);
  }
}

async function callAPI(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: { "X-Depot": "1", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = r.status === 204 ? {} : await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(apiError(data, r.status));
  return data;
}

function openPasswordSheet() {
  const { wrap, close } = sheet(`
    <h2>${escapeHTML(t("change_password"))}</h2>
    <p class="sheet-msg" data-err hidden></p>
    <label class="field"><span>${escapeHTML(t("pw_current"))}</span>
      <input type="password" data-cur autocomplete="current-password"></label>
    <label class="field"><span>${escapeHTML(t("pw_new"))}</span>
      <input type="password" data-new autocomplete="new-password"></label>
    <div class="sheet-actions">
      <button class="btn btn-ghost" data-cancel>${escapeHTML(t("cancel"))}</button>
      <button class="btn btn-primary" data-ok>${escapeHTML(t("change_password"))}</button>
    </div>`);

  const err = wrap.querySelector("[data-err]");
  wrap.querySelector("[data-cancel]").onclick = close;
  wrap.querySelector("[data-cur]").focus();
  wrap.querySelector("[data-ok]").onclick = async () => {
    err.hidden = true;
    try {
      await callAPI("POST", "/api/password", {
        current: wrap.querySelector("[data-cur]").value,
        new: wrap.querySelector("[data-new]").value,
      });
      close();
      toast(t("pw_saved"), "ok");
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    }
  };
}

async function openAccountsSheet() {
  const { wrap, close } = sheet(`
    <h2>${escapeHTML(t("acc_title"))}</h2>
    <p class="sheet-msg" data-err hidden></p>
    <div class="acc-list" data-list></div>
    <form class="acc-new">
      <input type="text" data-name placeholder="${escapeHTML(t("acc_name"))}" spellcheck="false"
             autocapitalize="none">
      <input type="password" data-pass placeholder="${escapeHTML(t("pw_new"))}"
             autocomplete="new-password">
      <input type="text" data-root placeholder="${escapeHTML(t("acc_folder"))}" spellcheck="false">
      <label class="acc-check"><input type="checkbox" data-admin>
        <span>${escapeHTML(t("acc_admin"))}</span></label>
      <button class="btn btn-primary" type="submit">${escapeHTML(t("acc_add"))}</button>
    </form>
    <p class="sheet-hint">${escapeHTML(t("acc_folder"))} — ${escapeHTML(t("acc_folder_hint"))}</p>
    <div class="sheet-actions">
      <button class="btn btn-ghost" data-close>${escapeHTML(t("close"))}</button>
    </div>`, true);

  const err = wrap.querySelector("[data-err]");
  const list = wrap.querySelector("[data-list]");
  const fail = (e) => { err.textContent = e.message; err.hidden = false; };

  wrap.querySelector("[data-close]").onclick = close;

  const render = async () => {
    let data;
    try {
      data = await callAPI("GET", "/api/users");
    } catch (e) { return fail(e); }
    list.innerHTML = "";
    for (const u of data.users) {
      const row = document.createElement("div");
      row.className = "acc";
      row.innerHTML = `
        <span class="acc-id">
          <strong>${escapeHTML(u.name)}</strong>
          ${u.self ? `<em>${escapeHTML(t("acc_you"))}</em>` : ""}
          ${u.admin ? `<span class="tag">${escapeHTML(t("acc_admin"))}</span>` : ""}
          <span class="acc-root">${u.root ? escapeHTML(u.root) : escapeHTML(t("acc_whole"))}</span>
        </span>
        <span class="acc-act">
          <button data-reset title="${escapeHTML(t("acc_reset"))}">${ICON.pencil}</button>
          <button data-role title="${escapeHTML(u.admin ? t("acc_demote") : t("acc_promote"))}">${u.admin ? "★" : "☆"}</button>
          <button data-del class="is-danger" title="${escapeHTML(t("delete"))}">${ICON.trash}</button>
        </span>`;

      row.querySelector("[data-reset]").onclick = async () => {
        const pw = await ask({ title: t("acc_reset"), message: u.name, value: "",
                               placeholder: t("pw_new"), confirmLabel: t("acc_reset") });
        if (!pw) return;
        try {
          await callAPI("PATCH", `/api/users/${encodeURIComponent(u.name)}`, { password: pw });
          toast(t("acc_updated"), "ok");
        } catch (e) { fail(e); }
      };

      row.querySelector("[data-role]").onclick = async () => {
        try {
          await callAPI("PATCH", `/api/users/${encodeURIComponent(u.name)}`, { admin: !u.admin });
          toast(t("acc_updated"), "ok");
          render();
        } catch (e) { fail(e); }
      };

      row.querySelector("[data-del]").onclick = async () => {
        const ok = await ask({ title: t("delete"), message: t("acc_del_body", u.name),
                               confirmLabel: t("delete"), danger: true });
        if (!ok) return;
        try {
          await callAPI("DELETE", `/api/users/${encodeURIComponent(u.name)}`);
          toast(t("acc_deleted"), "ok");
          render();
        } catch (e) { fail(e); }
      };

      // The folder is shown as a button so it can be changed in place.
      row.querySelector(".acc-root").onclick = async () => {
        const root = await ask({ title: t("acc_move"), message: t("acc_folder_hint"),
                                 value: u.root, confirmLabel: t("acc_move") });
        if (root === null) return;
        try {
          await callAPI("PATCH", `/api/users/${encodeURIComponent(u.name)}`, { root });
          toast(t("acc_updated"), "ok");
          render();
        } catch (e) { fail(e); }
      };

      list.append(row);
    }
  };

  wrap.querySelector(".acc-new").onsubmit = async (e) => {
    e.preventDefault();
    err.hidden = true;
    const f = wrap.querySelector.bind(wrap);
    try {
      await callAPI("POST", "/api/users", {
        name: f("[data-name]").value.trim(),
        password: f("[data-pass]").value,
        root: f("[data-root]").value.trim(),
        admin: f("[data-admin]").checked,
      });
      f("[data-name]").value = ""; f("[data-pass]").value = "";
      f("[data-root]").value = ""; f("[data-admin]").checked = false;
      toast(t("acc_created"), "ok");
      render();
    } catch (e2) { fail(e2); }
  };

  render();
}

/* ── wiring ───────────────────────────────────────────────────────── */

$("loginForm").onsubmit = async (e) => {
  e.preventDefault();
  const btn = $("loginBtn");
  const err = $("loginError");
  btn.classList.add("is-busy");
  btn.disabled = true;
  err.hidden = true;
  try {
    const r = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: $("loginUser").value, password: $("loginPass").value }),
    });
    const data = await r.json();
    if (!r.ok) {
      // The server answers with a stable code, so the wording stays here where
      // the dictionary lives.
      throw new Error(data.error === "throttled"
        ? t("err_throttled", data.retry_after || 60)
        : data.error === "bad_credentials" ? t("err_login") : t("err_generic"));
    }
    $("loginPass").value = "";
    enterApp({ user: data.user, admin: data.admin });
  } catch (e2) {
    err.textContent = e2.message;
    err.hidden = false;
    $("loginPass").select();
  } finally {
    btn.classList.remove("is-busy");
    btn.disabled = false;
  }
};

$("pwToggle").onclick = () => {
  const i = $("loginPass");
  const show = i.type === "password";
  i.type = show ? "text" : "password";
  $("pwToggle").classList.toggle("is-on", show);
  $("pwToggle").setAttribute("aria-label", show ? t("pw_hide") : t("pw_show"));
  i.focus();
};

$("userBtn").onclick = () => {
  const pop = $("userPop");
  pop.hidden = !pop.hidden;
  $("userBtn").setAttribute("aria-expanded", String(!pop.hidden));
  if (!pop.hidden) refreshQuota();
};

document.addEventListener("click", (e) => {
  if (!e.target.closest(".user-menu")) $("userPop").hidden = true;
});

$("passwordBtn").onclick = () => { $("userPop").hidden = true; openPasswordSheet(); };
$("manageBtn").onclick = () => { $("userPop").hidden = true; openAccountsSheet(); };

$("logoutBtn").onclick = async () => {
  await fetch("/api/logout", { method: "POST", headers: { "X-Depot": "1" } });
  location.hash = "";
  location.reload();
};

$("filter").oninput = (e) => { state.filter = e.target.value; renderListing(); };

$("viewList").onclick = () => setView(false);
$("viewGrid").onclick = () => setView(true);

function setView(grid) {
  state.grid = grid;
  localStorage.setItem("drop.view", grid ? "grid" : "list");
  $("viewGrid").classList.toggle("is-on", grid);
  $("viewList").classList.toggle("is-on", !grid);
  renderListing();
}

$("pickFiles").onclick = () => $("fileInput").click();
$("pickFolder").onclick = () => $("folderInput").click();

$("fileInput").onchange = (e) => { enqueue(e.target.files); e.target.value = ""; };
$("folderInput").onchange = (e) => { enqueue(e.target.files); e.target.value = ""; };

$("newFolder").onclick = async () => {
  const name = await ask({
    title: t("ask_new_folder"), value: "", placeholder: t("folder_name"), confirmLabel: t("new_folder"),
  });
  if (!name) return;
  try {
    await api.mkdir(state.path + name + "/");
    toast(t("created"), "ok");
    go(state.path, false);
  } catch (e) {
    toast(e.message, "bad");
  }
};

$("uploadsToggle").onclick = () => {
  const box = $("uploads");
  box.classList.toggle("is-collapsed");
  $("uploadsToggle").setAttribute("aria-expanded", String(!box.classList.contains("is-collapsed")));
};
$("uploadsClear").onclick = () => queue.clearFinished();

$("modalClose").onclick = closePreview;
$("modal").onmousedown = (e) => { if (e.target.id === "modal" || e.target.id === "modalStage") closePreview(); };

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("modal").hidden) closePreview();
  // "/" jumps to the filter, unless something is already being typed into.
  if (e.key === "/" && !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) {
    e.preventDefault();
    $("filter").focus();
  }
});

window.onpopstate = (e) => {
  if (!document.body.classList.contains("authed")) return;
  go(e.state?.p || decodeURIComponent(location.hash.slice(1)) || state.base, false);
};

/* full-page drag and drop */
let dragDepth = 0;

window.addEventListener("dragenter", (e) => {
  if (!document.body.classList.contains("authed")) return;
  if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
  dragDepth++;
  $("dropzone").hidden = false;
});

window.addEventListener("dragover", (e) => {
  if ($("dropzone").hidden) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
});

window.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) { dragDepth = 0; $("dropzone").hidden = true; }
});

window.addEventListener("drop", async (e) => {
  if (!document.body.classList.contains("authed")) return;
  e.preventDefault();
  dragDepth = 0;
  $("dropzone").hidden = true;
  const found = await walkDataTransfer(e.dataTransfer);
  if (!found.length) return;
  const dir = state.path;
  for (const { file, path } of found) queue.add(file, path, dir);
});

// An upload in flight should survive an absent-minded tab close.
window.addEventListener("beforeunload", (e) => {
  if (queue.items.some((u) => u.status === "running" || u.status === "waiting")) {
    e.preventDefault();
    e.returnValue = "";
  }
});

boot();
