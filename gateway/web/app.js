"use strict";

/* Interface du dépôt. Parle à depot-gw, qui relaie vers dufs.
 *
 * La contrainte qui gouverne tout l'envoi : Cloudflare refuse tout corps de
 * requête au-delà de 100 Mo, et on ne peut pas s'y soustraire. Chaque fichier
 * part donc en tranches, la première en PUT, les suivantes en PATCH avec
 * `X-Update-Range: append`. Effet de bord bienvenu : une coupure ne coûte que
 * la tranche en cours, et la pause devient gratuite.
 */

const CHUNK = 32 * 1024 * 1024;   // marge confortable sous les 100 Mo
const PARALLEL = 2;               // au-delà, les envois se volent la bande

const $ = (id) => document.getElementById(id);

const state = {
  path: "/",
  entries: [],
  sort: { key: "name", dir: 1 },
  grid: localStorage.getItem("depot.view") === "grid",
  filter: "",
  user: null,
};

/* ── API ──────────────────────────────────────────────────────────── */

const api = {
  url(p, query = "") {
    // Le slash final compte: sans lui dufs renvoie une redirection vers la
    // version avec slash, et ce Location pointe hors de /api/fs.
    const trailing = p.endsWith("/");
    const clean = p.split("/").filter(Boolean).map(encodeURIComponent).join("/");
    return "/api/fs/" + clean + (trailing && clean ? "/" : "") + query;
  },

  async json(p) {
    const dir = p.endsWith("/") ? p : p + "/";
    const r = await fetch(api.url(dir, "?json"), {
      headers: { Accept: "application/json" },
    });
    if (r.status === 401) throw new SessionLost();
    if (!r.ok) throw new Error(`liste indisponible (${r.status})`);
    return r.json();
  },

  async mkdir(p) {
    const r = await fetch(api.url(p), { method: "MKCOL", headers: { "X-Depot": "1" } });
    // 405 = déjà là, ce qui nous convient parfaitement.
    if (!r.ok && r.status !== 405) throw new Error(`création refusée (${r.status})`);
  },

  async remove(p) {
    const r = await fetch(api.url(p), { method: "DELETE", headers: { "X-Depot": "1" } });
    if (r.status === 401) throw new SessionLost();
    if (!r.ok) throw new Error(`suppression refusée (${r.status})`);
  },

  async move(from, to) {
    const r = await fetch(api.url(from), {
      method: "MOVE",
      headers: { "X-Depot": "1", Destination: location.origin + api.url(to) },
    });
    if (r.status === 401) throw new SessionLost();
    if (!r.ok) throw new Error(`renommage refusé (${r.status})`);
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
    super("session expirée");
  }
}

/* ── formatage ────────────────────────────────────────────────────── */

const UNITS = ["o", "Ko", "Mo", "Go", "To"];

function bytes(n) {
  if (!n) return "0 o";
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), UNITS.length - 1);
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${UNITS[i]}`;
}

function when(ms) {
  const d = new Date(ms);
  const days = (Date.now() - ms) / 86400000;
  if (days < 1) return d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  if (days < 300) return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });
}

function duration(sec) {
  if (!isFinite(sec) || sec < 0) return "—";
  if (sec < 60) return `${Math.ceil(sec)} s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  return `${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min`;
}

// Comparaison indifférente aux accents et à la casse : « Été » se classe
// avec « ete », ce qu'un tri brut sur les codes UTF-16 ne fait pas.
const collator = new Intl.Collator("fr", { numeric: true, sensitivity: "base" });

function fold(s) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/* ── icônes ───────────────────────────────────────────────────────── */

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

/* ── notifications ────────────────────────────────────────────────── */

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

/* Remplace confirm() et prompt(), dont l'apparence est imposée par le
 * navigateur. Résout avec la valeur saisie, ou null si on annule. */
function ask({ title, message, value, placeholder, confirmLabel = "Valider", danger = false }) {
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
          <button type="button" class="btn btn-ghost" data-cancel>Annuler</button>
          <button type="submit" class="btn ${danger ? "btn-danger" : "btn-primary"}">
            ${escapeHTML(confirmLabel)}
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

/* ── navigation et affichage ──────────────────────────────────────── */

async function go(p, push = true) {
  state.path = p.endsWith("/") ? p : p + "/";
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
  const parts = state.path.split("/").filter(Boolean);
  const bc = $("breadcrumb");
  bc.innerHTML = "";

  const add = (label, target, last) => {
    const b = document.createElement("button");
    b.className = "crumb" + (last ? " is-last" : "");
    b.textContent = label;
    if (!last) b.onclick = () => go(target);
    bc.append(b);
  };

  add("Dépôt", "/", parts.length === 0);
  parts.forEach((seg, i) => {
    const sep = document.createElement("span");
    sep.className = "crumb-sep";
    sep.textContent = "/";
    bc.append(sep);
    add(decodeURIComponent(seg), "/" + parts.slice(0, i + 1).join("/") + "/", i === parts.length - 1);
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
      if (ad !== bd) return ad ? -1 : 1;   // dossiers d'abord, quel que soit le tri
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
  const cols = [
    ["", ""],
    ["name", "Nom"],
    ["size", "Taille"],
    ["date", "Modifié"],
  ];
  head.innerHTML = cols.map(([k, label], i) => {
    if (!label) return "<span></span>";
    const on = state.sort.key === k;
    const arrow = on ? (state.sort.dir === 1 ? " ↑" : " ↓") : "";
    return `<button class="col-btn${i === 2 ? " num" : ""}${on ? " is-sorted" : ""}"
              data-sort="${k}">${label}${arrow}</button>`;
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
         title="Télécharger" data-stop>${ICON.download}</a>
      <button title="Renommer" data-rename>${ICON.pencil}</button>
      <button title="Supprimer" class="is-danger" data-del>${ICON.trash}</button>
    </span>`;

  const open = () => (isDir ? go(full + "/") : preview(e, full));
  el.onclick = (ev) => { if (!ev.target.closest("[data-stop],button")) open(); };
  el.onkeydown = (ev) => { if (ev.key === "Enter") open(); };

  el.querySelector("[data-rename]").onclick = async () => {
    const name = await ask({
      title: "Renommer", value: e.name, confirmLabel: "Renommer",
    });
    if (!name || name === e.name) return;
    try {
      await api.move(full, state.path + name);
      toast("Renommé", "ok");
      go(state.path, false);
    } catch (err) {
      err instanceof SessionLost ? sessionLost() : toast(err.message, "bad");
    }
  };

  el.querySelector("[data-del]").onclick = async () => {
    const ok = await ask({
      title: "Supprimer ?",
      message: `« ${e.name} » sera supprimé définitivement.`,
      confirmLabel: "Supprimer", danger: true,
    });
    if (!ok) return;
    try {
      await api.remove(full);
      toast("Supprimé", "ok");
      go(state.path, false);
      refreshQuota();
    } catch (err) {
      err instanceof SessionLost ? sessionLost() : toast(err.message, "bad");
    }
  };

  return el;
}

/* ── aperçu ───────────────────────────────────────────────────────── */

async function preview(entry, full) {
  const kind = kindOf(entry.name);
  const url = api.url(full);

  // Rien à montrer pour une archive ou un binaire : autant le télécharger.
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
    pre.textContent = "Chargement…";
    stage.append(pre);
    try {
      // Un .log de 2 Go ne doit pas partir en mémoire : on n'en lit qu'un bout.
      const r = await fetch(url, { headers: { Range: "bytes=0-524287" } });
      const text = await r.text();
      pre.textContent = text + (entry.size > 524288 ? "\n\n… (aperçu tronqué)" : "");
    } catch {
      pre.textContent = "Aperçu impossible.";
    }
  }
  $("modal").hidden = false;
}

function closePreview() {
  $("modal").hidden = true;
  $("modalStage").innerHTML = "";   // coupe la lecture en cours
}

/* ── envoi ────────────────────────────────────────────────────────── */

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
      ? `${done}/${this.items.length}`
      : failed ? `${done} terminé${done > 1 ? "s" : ""}, ${failed} en échec`
        : `${done} terminé${done > 1 ? "s" : ""}`;

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
    this.started = false;         // vrai dès qu'une tranche est partie: autorise la reprise
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
      <span class="up-meta"><span data-state>En attente</span><span data-speed></span></span>
      <span class="up-ctl">
        <button data-pause title="Suspendre">${ICON.pause}</button>
        <button data-cancel title="Annuler">${ICON.x}</button>
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
    this.$state.textContent = label ?? `${Math.floor(pct)}% · ${bytes(this.sent)} / ${bytes(this.file.size)}`;
    this.$speed.textContent =
      this.status === "running" && this.speed > 0
        ? `${bytes(this.speed)}/s · ${duration((this.file.size - this.sent) / this.speed)}`
        : "";
    queue.refresh();
  }

  async run() {
    if (this.status === "cancelled") return;
    this.status = "running";
    this.el.classList.remove("is-failed");
    try {
      // Les dossiers déposés arrivent avec un chemin relatif : on crée la
      // hiérarchie avant, sans supposer que le stockage le fera pour nous.
      const dirs = this.name.split("/").slice(0, -1);
      let acc = this.dest.slice(0, this.dest.length - this.name.length);
      for (const d of dirs) {
        acc += d + "/";
        await api.mkdir(acc);
      }

      // On ne reprend que ce que cet envoi-ci a commencé. Demander la taille
      // distante pour un envoi neuf ferait « reprendre » un homonyme déjà
      // présent : ses octets seraient conservés et le fichier obtenu serait un
      // mélange des deux, sans que rien ne le signale.
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
      this.paint("Terminé");
      this.$state.classList.add("is-ok");
    } catch (e) {
      if (this.status === "cancelled" || this.status === "paused") return;
      this.status = "failed";
      this.el.classList.add("is-failed");
      this.paint(e instanceof SessionLost ? "Session expirée" : (e.message || "Échec"));
      this.$state.classList.add("is-bad");
      this.$pause.replaceWith(this.retryButton());
      if (e instanceof SessionLost) sessionLost();
    }
  }

  retryButton() {
    const b = document.createElement("button");
    b.title = "Reprendre";
    b.innerHTML = ICON.retry;
    b.onclick = () => {
      b.remove();
      this.el.append(this.$pause);
      this.status = "waiting";
      this.$state.classList.remove("is-bad");
      this.paint("En attente");
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
        else if (xhr.status === 413) reject(new Error("tranche refusée (413)"));
        else reject(new Error(`erreur ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error("connexion interrompue"));
      xhr.onabort = () => reject(new Error("interrompu"));
      xhr.send(blob);
    });
  }

  pause() {
    if (this.status !== "running") return;
    this.status = "paused";
    this.xhr?.abort();
    this.$pause.innerHTML = ICON.play;
    this.$pause.title = "Reprendre";
    this.paint("Suspendu");
  }

  resume() {
    this.$pause.innerHTML = ICON.pause;
    this.$pause.title = "Suspendre";
    this.status = "waiting";
    this.paint("En attente");
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

/* Un dépôt peut contenir des dossiers ; l'API des entrées permet de les
 * parcourir, ce que la simple liste `files` du glisser-déposer ne donne pas. */
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
  toast("Session expirée, reconnectez-vous", "bad");
}

async function refreshQuota() {
  const q = await api.quota();
  if (!q.available) { $("quotaBox").hidden = true; return; }
  const pct = (q.used / q.total) * 100;
  const fill = $("quotaFill");
  fill.style.width = `${Math.max(pct, 1.5)}%`;
  fill.className = pct > 92 ? "is-bad" : pct > 78 ? "is-warn" : "";
  $("quotaText").textContent = `${bytes(q.used)} utilisés sur ${bytes(q.total)} · ${bytes(q.free)} libres`;
}

async function boot() {
  const r = await fetch("/api/session");
  const s = await r.json();
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
  $("userName").textContent = s.user;
  $("avatar").textContent = s.user.slice(0, 1);
  document.body.classList.add("authed");
  if (state.grid) { $("viewGrid").classList.add("is-on"); $("viewList").classList.remove("is-on"); }
  const start = decodeURIComponent(location.hash.slice(1)) || "/";
  go(start.startsWith("/") ? start : "/", false);
  refreshQuota();
}

/* ── câblage ──────────────────────────────────────────────────────── */

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
    if (!r.ok) throw new Error(data.error || "connexion refusée");
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
  $("pwToggle").setAttribute("aria-label", show ? "Masquer le mot de passe" : "Afficher le mot de passe");
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
  localStorage.setItem("depot.view", grid ? "grid" : "list");
  $("viewGrid").classList.toggle("is-on", grid);
  $("viewList").classList.toggle("is-on", !grid);
  renderListing();
}

$("pickFiles").onclick = () => $("fileInput").click();
$("pickFolder").onclick = () => $("folderInput").click();

$("fileInput").onchange = (e) => { enqueue(e.target.files); e.target.value = ""; };
$("folderInput").onchange = (e) => { enqueue(e.target.files); e.target.value = ""; };

$("newFolder").onclick = async () => {
  const name = await ask({ title: "Nouveau dossier", value: "", placeholder: "Nom du dossier", confirmLabel: "Créer" });
  if (!name) return;
  try {
    await api.mkdir(state.path + name + "/");
    toast("Dossier créé", "ok");
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
  // « / » met le curseur dans le filtre, sauf si on est déjà en train d'écrire.
  if (e.key === "/" && !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) {
    e.preventDefault();
    $("filter").focus();
  }
});

window.onpopstate = (e) => {
  if (!document.body.classList.contains("authed")) return;
  go(e.state?.p || decodeURIComponent(location.hash.slice(1)) || "/", false);
};

/* glisser-déposer sur toute la page */
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

// Un envoi en cours doit résister à une fermeture d'onglet distraite.
window.addEventListener("beforeunload", (e) => {
  if (queue.items.some((u) => u.status === "running" || u.status === "waiting")) {
    e.preventDefault();
    e.returnValue = "";
  }
});

boot();
