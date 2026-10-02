// Receipt Ledger — getting receipts in: PDF (pdf.js), HEIC (heic2any) and Google Drive (Picker + Google Identity).
// Libraries load only when needed. Exposes window.Imports (and module.exports for tests).
(function (root) {
  const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
  const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  const HEIC2ANY = "https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js";
  const GAPI = "https://apis.google.com/js/api.js";

  const loaded = {};
  function loadScript(src) {
    if (!loaded[src]) loaded[src] = new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = src; s.async = true; s.onload = res;
      s.onerror = () => { delete loaded[src]; rej(new Error("Could not load " + src.split("/")[2])); };
      document.head.appendChild(s);
    });
    return loaded[src];
  }

  const isPdf = (f) => /pdf/i.test(f.type || "") || /\.pdf$/i.test(f.name || "");
  const isHeic = (f) => /hei[cf]/i.test(f.type || "") || /\.hei[cf]$/i.test(f.name || "");
  const isImage = (f) => /^image\//i.test(f.type || "") || /\.(jpe?g|png|webp|gif|hei[cf])$/i.test(f.name || "");
  const accepted = (f) => isPdf(f) || isImage(f);

  // ---------- PDF ----------
  // Rebuild lines from pdf.js text items: group by baseline (y), order by x.
  function linesFromTextItems(items) {
    const rows = [];
    for (const it of items) {
      const str = String(it.str || ""); if (!str.trim()) continue;
      const x = it.transform ? it.transform[4] : 0, y = it.transform ? it.transform[5] : 0;
      const h = Math.abs(it.transform ? it.transform[3] : 10) || 10;
      let row = rows.find((r) => Math.abs(r.y - y) <= Math.max(2, h * 0.4));
      if (!row) rows.push((row = { y, items: [] }));
      row.items.push({ x, str, w: it.width || 0 });
    }
    rows.sort((a, b) => b.y - a.y);
    return rows.map((r) => {
      r.items.sort((a, b) => a.x - b.x);
      let out = "", end = null;
      for (const it of r.items) {
        if (end != null && it.x - end > 3) out += " ";
        out += it.str; end = it.x + it.w;
      }
      return out.trim();
    }).filter(Boolean);
  }

  // → { text, image (JPEG Blob of page 1), pages }
  async function readPdf(file) {
    await loadScript(PDFJS);
    const lib = root.pdfjsLib;
    lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    // CMaps + standard fonts are hosted on this site (needed for Japanese PDFs that use non-embedded fonts)
    const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), cMapUrl: new URL("/pdfjs/cmaps/", location.href).href, cMapPacked: true, standardFontDataUrl: new URL("/pdfjs/standard_fonts/", location.href).href }).promise;
    const texts = [];
    for (let p = 1; p <= Math.min(doc.numPages, 3); p++) {
      const page = await doc.getPage(p);
      texts.push(linesFromTextItems((await page.getTextContent()).items).join("\n"));
    }
    const page1 = await doc.getPage(1);
    const v0 = page1.getViewport({ scale: 1 });
    const scale = Math.min(4, 1600 / v0.width);
    const vp = page1.getViewport({ scale });
    const c = document.createElement("canvas"); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    await page1.render({ canvasContext: ctx, viewport: vp }).promise;
    const image = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
    return { text: texts.join("\n"), image, pages: doc.numPages };
  }

  // ---------- HEIC ----------
  async function heicToJpeg(file) {
    await loadScript(HEIC2ANY);
    const out = await root.heic2any({ blob: file, toType: "image/jpeg", quality: 0.9 });
    const blob = Array.isArray(out) ? out[0] : out;
    return new File([blob], String(file.name || "photo").replace(/\.hei[cf]$/i, "") + ".jpg", { type: "image/jpeg" });
  }
  // Can this browser decode the image itself? (Safari can read HEIC, Chrome cannot.)
  function canDecode(file) {
    return new Promise((res) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); res(true); };
      img.onerror = () => { URL.revokeObjectURL(url); res(false); };
      img.src = url;
    });
  }

  // ---------- Google Drive ----------
  // Uses the drive.file scope: the site can open only the files the user picks, nothing else in Drive.
  const SCOPE = "https://www.googleapis.com/auth/drive.file";
  const MIME = "image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf";


  async function ensureGoogle() {
    await loadScript(GAPI);
    if (!root.google || !root.google.picker) await new Promise((res, rej) => root.gapi.load("picker", { callback: res, onerror: () => rej(new Error("Google Picker failed to load")) }));
  }
  // Sign-in by full-page redirect (more reliable than pop-ups, which some browsers open as tabs
  // and then lose the connection back to this page). The token lives in sessionStorage for ~1 hour.
  const TK = "gdrive_token", ST = "gdrive_state";
  const redirectUri = () => location.origin + "/";
  function savedToken() {
    try { const o = JSON.parse(sessionStorage.getItem(TK) || "null"); if (o && Date.now() < o.exp - 60000) return o.token; } catch (e) {}
    return null;
  }
  // Call once on page load: picks up "#access_token=…" after Google sends the user back.
  function handleRedirect() {
    const h = location.hash || "";
    if (!/access_token=|error=/.test(h)) return null;
    const p = new URLSearchParams(h.slice(1));
    let expected = null; try { expected = sessionStorage.getItem(ST); sessionStorage.removeItem(ST); } catch (e) {}
    history.replaceState(null, "", location.pathname + location.search); // remove the token from the address bar
    if (!expected || p.get("state") !== expected) return { error: "state" };
    if (p.get("error")) return { error: p.get("error") };
    const granted = (p.get("scope") || "").split(/\s+/);
    if (!granted.includes(SCOPE)) return { error: "scope" };
    try { sessionStorage.setItem(TK, JSON.stringify({ token: p.get("access_token"), exp: Date.now() + (+p.get("expires_in") || 3600) * 1000 })); } catch (e) {}
    return { ok: true };
  }
  function startSignIn(clientId) {
    const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
    try { sessionStorage.setItem(ST, state); } catch (e) {}
    const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri(), response_type: "token", scope: SCOPE, include_granted_scopes: "true", state });
    location.assign("https://accounts.google.com/o/oauth2/v2/auth?" + q.toString());
  }
  function pick(cfg, accessToken, locale) {
    const P = root.google.picker;
    return new Promise((res, rej) => {
      let opened = false;
      // If Google never reports the picker as loaded, say so instead of silently doing nothing.
      const guard = setTimeout(() => { if (!opened) rej(Object.assign(new Error("Google Drive picker did not open"), { code: "picker" })); }, 20000);
      try {
      const docs = new P.DocsView(P.ViewId.DOCS).setMimeTypes(MIME).setIncludeFolders(true).setSelectFolderEnabled(false).setMode(P.DocsViewMode.LIST);
      const picker = new P.PickerBuilder()
        .addView(docs)
        .enableFeature(P.Feature.MULTISELECT_ENABLED)
        .setOAuthToken(accessToken).setDeveloperKey(cfg.googleApiKey).setAppId(cfg.googleAppId)
        // Tell the picker which site is calling: its iframe lives on docs.google.com, and without this the
        // API key's website restriction can see the wrong origin and report "developer key is invalid".
        .setOrigin(location.protocol + "//" + location.host)
        .setLocale(locale || "ja").setMaxItems(50)
        .setCallback((d) => {
          const a = d[P.Response.ACTION];
          if (a === "loaded" || a === P.Action.LOADED) { opened = true; return; }
          clearTimeout(guard); opened = true;
          if (a === P.Action.PICKED) res(d[P.Response.DOCUMENTS] || []);
          else if (a === P.Action.CANCEL) res([]);
          else if (a === "error" || a === P.Action.ERROR) rej(Object.assign(new Error("Google Drive picker error"), { code: "picker" }));
        })
        .build();
      picker.setVisible(true);
      } catch (e) { clearTimeout(guard); rej(Object.assign(e, { code: "picker" })); }
    });
  }
  async function download(doc, accessToken) {
    const id = doc.id || doc[root.google.picker.Document.ID];
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`, { headers: { Authorization: "Bearer " + accessToken } });
    if (!r.ok) throw new Error(`Drive ${r.status}`);
    const blob = await r.blob();
    const name = doc.name || doc[root.google.picker.Document.NAME] || id;
    const type = doc.mimeType || blob.type || "";
    const f = new File([blob], name, { type });
    f.driveId = id;
    return f;
  }
  // cfg: { googleClientId, googleApiKey, googleAppId }. Returns File[] (each with .driveId).
  async function pickFromDrive(cfg, opts) {
    const tk = savedToken();
    if (!tk) { startSignIn(cfg.googleClientId); return { redirecting: true }; }
    await ensureGoogle();
    const docs = await pick(cfg, tk, opts && opts.locale);
    const out = [];
    for (const d of docs) {
      if (opts && opts.skip && opts.skip(d.id)) { out.push({ skipped: true, id: d.id }); continue; }
      try { out.push(await download(d, tk)); } catch (e) { out.push({ error: e.message, name: d.name }); }
      if (opts && opts.onProgress) opts.onProgress(out.length, docs.length);
    }
    return out;
  }

  const api = { isPdf, isHeic, isImage, accepted, linesFromTextItems, readPdf, heicToJpeg, canDecode, pickFromDrive, handleRedirect, redirectUri };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Imports = api;
})(typeof window !== "undefined" ? window : globalThis);
