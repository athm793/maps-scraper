/* Maps Scraper — builder UI logic (vanilla JS, no framework). */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const CHK = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
  const TWIST = '<svg class="twist" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';

  const state = {
    categories: [],
    selectedCats: new Set(),
    countries: [],
    locCache: new Map(),   // cc -> doc {c,n,a:[{n,c,ct:[[city,[zips]]]}]}
    scopes: [],            // {key,type,cc,cn,rc,rn,city,cities,zips}
    gran: "city",
  };

  /* ---------- theme ---------- */
  function initTheme() {
    const saved = localStorage.getItem("ms-theme");
    if (saved) document.documentElement.setAttribute("data-theme", saved);
    $("theme-toggle").addEventListener("click", () => {
      const cur = document.documentElement.getAttribute("data-theme");
      const isDark = cur ? cur === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
      const next = isDark ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try { localStorage.setItem("ms-theme", next); } catch (e) {}
    });
  }

  /* ---------- data ---------- */
  async function loadJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(url + " -> " + r.status);
    return r.json();
  }
  async function ensureLoc(cc) {
    if (state.locCache.has(cc)) return state.locCache.get(cc);
    const doc = await loadJSON("/static/data/loc/" + cc + ".json");
    state.locCache.set(cc, doc);
    return doc;
  }
  const fmt = (n) => n.toLocaleString("en-US");
  const rname = (rn) => (rn && rn !== "_" ? rn : "Other / unspecified");

  /* ---------- categories ---------- */
  function renderCatList() {
    const q = $("cat-search").value.trim().toLowerCase();
    const ul = $("cat-list");
    let matches = q ? state.categories.filter((c) => c.toLowerCase().includes(q)) : state.categories;
    const cap = 400;
    const shown = matches.slice(0, cap);
    ul.innerHTML = shown.map((c) => {
      const sel = state.selectedCats.has(c);
      return '<li class="' + (sel ? "sel" : "") + '" data-v="' + esc(c) + '"><span class="chk">' + (sel ? CHK : "") + "</span>" + esc(c) + "</li>";
    }).join("");
    if (matches.length > cap) ul.innerHTML += '<li class="more-note">+' + fmt(matches.length - cap) + " more — refine your search or use “Add all shown”.</li>";
  }
  function renderCatChips() {
    const box = $("cat-chips");
    const arr = [...state.selectedCats];
    $("cat-count").textContent = fmt(arr.length);
    if (!arr.length) { box.innerHTML = '<span class="empty">No categories selected</span>'; syncSummary(); return; }
    const cap = 24;
    box.innerHTML = arr.slice(0, cap).map((c) =>
      '<span class="chip"><span>' + esc(c) + '</span><button data-v="' + esc(c) + '" aria-label="remove">✕</button></span>'
    ).join("") + (arr.length > cap ? '<span class="chip"><span>+' + fmt(arr.length - cap) + " more</span></span>" : "");
    syncSummary();
  }
  function bindCategories() {
    $("cat-search").addEventListener("input", renderCatList);
    $("cat-list").addEventListener("click", (e) => {
      const li = e.target.closest("li[data-v]");
      if (!li) return;
      const v = li.getAttribute("data-v");
      if (state.selectedCats.has(v)) state.selectedCats.delete(v); else state.selectedCats.add(v);
      renderCatList(); renderCatChips();
    });
    $("cat-chips").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-v]");
      if (!b) return;
      state.selectedCats.delete(b.getAttribute("data-v"));
      renderCatList(); renderCatChips();
    });
    $("cat-add-shown").addEventListener("click", () => {
      const q = $("cat-search").value.trim().toLowerCase();
      const matches = q ? state.categories.filter((c) => c.toLowerCase().includes(q)) : state.categories;
      matches.forEach((c) => state.selectedCats.add(c));
      renderCatList(); renderCatChips();
    });
    $("cat-clear").addEventListener("click", () => {
      state.selectedCats.clear(); renderCatList(); renderCatChips();
    });
  }

  /* ---------- locations ---------- */
  function scopeKey(s) { return [s.type, s.cc, s.rc || "", s.city || ""].join("|"); }
  function countryCounts(cc) {
    const c = state.countries.find((x) => x.c === cc);
    return c ? { cities: c.cities, zips: c.zips } : { cities: 0, zips: 0 };
  }
  function regionCounts(cc, rc) {
    const doc = state.locCache.get(cc); if (!doc) return { cities: 0, zips: 0 };
    const r = doc.a.find((x) => x.c === rc); if (!r) return { cities: 0, zips: 0 };
    return { cities: r.ct.length, zips: r.ct.reduce((a, x) => a + x[1].length, 0) };
  }
  function scopeUnits(s) {
    const useCity = state.gran === "city";
    if (s.type === "country") { const c = countryCounts(s.cc); return useCity ? c.cities : c.zips; }
    if (s.type === "region") { const c = regionCounts(s.cc, s.rc); return useCity ? c.cities : c.zips; }
    return useCity ? 1 : (s.zips ? s.zips.length : 0);
  }
  function hasCountryScope(cc) { return state.scopes.some((s) => s.type === "country" && s.cc === cc); }
  function hasRegionScope(cc, rc) { return state.scopes.some((s) => s.type === "region" && s.cc === cc && s.rc === rc); }
  function isScoped(s) {
    if (hasCountryScope(s.cc)) return true;
    if (s.type === "city" || s.type === "region") if (hasRegionScope(s.cc, s.rc)) return s.type !== "region";
    return state.scopes.some((x) => scopeKey(x) === scopeKey(s));
  }
  function addScope(s) {
    // ignore redundant adds already covered by a broader scope
    if (s.type !== "country" && hasCountryScope(s.cc)) return;
    if (s.type === "city" && hasRegionScope(s.cc, s.rc)) return;
    if (s.type === "country") state.scopes = state.scopes.filter((x) => x.cc !== s.cc || x.type === "country");
    if (s.type === "country") state.scopes = state.scopes.filter((x) => !(x.cc === s.cc && x.type !== "country"));
    if (s.type === "region") state.scopes = state.scopes.filter((x) => !(x.cc === s.cc && x.rc === s.rc && x.type === "city"));
    if (!state.scopes.some((x) => scopeKey(x) === scopeKey(s))) state.scopes.push(s);
    renderCountryTree(); renderLocChips();
  }
  function removeScopeKey(key) {
    state.scopes = state.scopes.filter((x) => scopeKey(x) !== key);
    renderCountryTree(); renderLocChips();
  }
  function toggleScope(s) {
    const existing = state.scopes.find((x) => scopeKey(x) === scopeKey(s));
    if (existing) removeScopeKey(scopeKey(s)); else addScope(s);
  }

  function renderLocChips() {
    const box = $("loc-chips");
    $("loc-count").textContent = fmt(state.scopes.length);
    if (!state.scopes.length) { box.innerHTML = '<span class="empty">No locations selected</span>'; syncSummary(); return; }
    box.innerHTML = state.scopes.map((s) => {
      let label = s.type === "country" ? "🌐 " + s.cn
        : s.type === "region" ? rname(s.rn) + ", " + s.cn
        : s.city + ", " + s.cn;
      return '<span class="chip"><span>' + esc(label) + '</span><button data-k="' + esc(scopeKey(s)) + '" aria-label="remove">✕</button></span>';
    }).join("");
    syncSummary();
  }

  function chkbox(sel, extra) { return '<span class="chk' + (sel ? " on" : "") + (extra ? " " + extra : "") + '">' + (sel ? CHK : "") + "</span>"; }

  function renderCountryTree() {
    const q = $("country-search").value.trim().toLowerCase();
    const tree = $("country-tree");
    const list = q ? state.countries.filter((c) => c.n.toLowerCase().includes(q) || c.c.toLowerCase() === q) : state.countries;
    // preserve expanded state
    const open = new Set([...tree.querySelectorAll(".country-node.open")].map((n) => n.getAttribute("data-cc")));
    tree.innerHTML = list.map((c) => {
      const sel = hasCountryScope(c.c);
      const isOpen = open.has(c.c);
      let html = '<div class="country-node ' + (isOpen ? "open" : "") + '" data-cc="' + c.c + '">';
      html += '<div class="tree-row country">' +
        chkbox(sel, "sel-country") +
        TWIST +
        '<span class="ctry-label" style="font-weight:550">' + esc(c.n) + "</span>" +
        '<span class="meta">' + fmt(c.cities) + " cities</span></div>";
      html += '<div class="country-children" style="' + (isOpen ? "" : "display:none") + '"></div></div>';
      return html;
    }).join("");
    // repopulate open countries
    open.forEach((cc) => { const node = tree.querySelector('.country-node[data-cc="' + cc + '"]'); if (node) fillCountry(node, cc); });
  }

  async function fillCountry(node, cc) {
    const children = node.querySelector(".country-children");
    children.innerHTML = '<div class="tree-loading">Loading…</div>';
    let doc;
    try { doc = await ensureLoc(cc); } catch (e) { children.innerHTML = '<div class="tree-loading">Failed to load.</div>'; return; }
    const cnts = countryCounts(cc);
    let html = '<div class="tree-hint">Tick a box to select the whole country or a whole state; click a name to open it.</div>';
    html += '<div class="tree-search"><input type="text" placeholder="Filter cities in ' + esc(doc.n) + '…" data-cc="' + cc + '"></div>';
    html += doc.a.map((r, ri) => {
      const rsel = hasRegionScope(cc, r.c) || hasCountryScope(cc);
      return '<div class="region-node" data-rc="' + esc(r.c) + '" data-ri="' + ri + '">' +
        '<div class="tree-row region">' + chkbox(rsel, "sel-region") + TWIST +
        '<span>' + esc(rname(r.n)) + '</span>' +
        '<span class="meta">' + fmt(r.ct.length) + "</span></div>" +
        '<div class="region-children" style="display:none"></div></div>';
    }).join("");
    children.innerHTML = html;
  }

  function fillRegion(regionNode, cc, ri, filter) {
    const doc = state.locCache.get(cc); if (!doc) return;
    const r = doc.a[ri]; const box = regionNode.querySelector(".region-children");
    let cities = r.ct;
    if (filter) cities = cities.filter((x) => x[0].toLowerCase().includes(filter));
    const cap = 400;
    const shown = cities.slice(0, cap);
    box.innerHTML = shown.map((x) => {
      const s = { type: "city", cc, cn: doc.n, rc: r.c, rn: r.n, city: x[0], zips: x[1] };
      const sel = isScoped(s);
      return '<div class="tree-row city" data-city="' + esc(x[0]) + '">' + chkbox(sel) +
        '<span>' + esc(x[0]) + '</span><span class="meta">' + x[1].length + " zip" + (x[1].length === 1 ? "" : "s") + "</span></div>";
    }).join("");
    if (cities.length > cap) box.innerHTML += '<div class="tree-loading">+' + fmt(cities.length - cap) + " more — use the filter box above.</div>";
  }

  function bindLocations() {
    $("country-search").addEventListener("input", renderCountryTree);
    document.querySelectorAll("#granularity button").forEach((b) => b.addEventListener("click", () => {
      document.querySelectorAll("#granularity button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active"); state.gran = b.getAttribute("data-g");
      $("s-gran").textContent = "(" + (state.gran === "city" ? "city" : "postal code") + ")";
      renderCountryTree(); syncSummary();
    }));
    $("loc-chips").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-k]"); if (!b) return;
      removeScopeKey(b.getAttribute("data-k"));
    });
    $("loc-all-countries").addEventListener("click", () => {
      if (state.countries.length > 30 && !confirm("Select all " + state.countries.length + " countries? This makes a very large search set — scope it down with categories."))
        return;
      state.scopes = state.countries.map((c) => ({ type: "country", cc: c.c, cn: c.n }));
      renderCountryTree(); renderLocChips();
    });
    $("loc-clear").addEventListener("click", () => {
      state.scopes = []; renderCountryTree(); renderLocChips();
    });

    const tree = $("country-tree");
    tree.addEventListener("input", (e) => {
      const inp = e.target.closest(".tree-search input"); if (!inp) return;
      const cc = inp.getAttribute("data-cc"); const node = tree.querySelector('.country-node[data-cc="' + cc + '"]');
      const f = inp.value.trim().toLowerCase();
      node.querySelectorAll(".region-node").forEach((rn) => {
        if (!f) { rn.style.display = ""; rn.querySelector(".region-children").style.display = "none"; rn.querySelector(".region-children").innerHTML = ""; rn.querySelector(".tree-row.region").classList.remove("open"); return; }
        const ri = +rn.getAttribute("data-ri");
        const doc = state.locCache.get(cc); const r = doc.a[ri];
        const hit = r.ct.some((x) => x[0].toLowerCase().includes(f));
        rn.style.display = hit ? "" : "none";
        if (hit) { rn.querySelector(".region-children").style.display = ""; rn.querySelector(".tree-row.region").classList.add("open"); fillRegion(rn, cc, ri, f); }
      });
    });

    tree.addEventListener("click", (e) => {
      const inp = e.target.closest(".tree-search"); if (inp) return;
      // whole-country select
      const selC = e.target.closest(".sel-country");
      if (selC) {
        e.stopPropagation();
        const cc = selC.closest(".country-node").getAttribute("data-cc");
        const c = state.countries.find((x) => x.c === cc);
        toggleScope({ type: "country", cc, cn: c.n });
        return;
      }
      // region select-all
      const selR = e.target.closest(".sel-region");
      if (selR) {
        e.stopPropagation();
        const cc = selR.closest(".country-node").getAttribute("data-cc");
        const rn = selR.closest(".region-node"); const ri = +rn.getAttribute("data-ri");
        const doc = state.locCache.get(cc); const r = doc.a[ri];
        toggleScope({ type: "region", cc, cn: doc.n, rc: r.c, rn: r.n });
        return;
      }
      // city toggle
      const cityRow = e.target.closest(".tree-row.city");
      if (cityRow) {
        const cc = cityRow.closest(".country-node").getAttribute("data-cc");
        const rn = cityRow.closest(".region-node"); const ri = +rn.getAttribute("data-ri");
        const doc = state.locCache.get(cc); const r = doc.a[ri];
        const city = cityRow.getAttribute("data-city");
        const entry = r.ct.find((x) => x[0] === city);
        toggleScope({ type: "city", cc, cn: doc.n, rc: r.c, rn: r.n, city, zips: entry[1] });
        return;
      }
      // region expand
      const regRow = e.target.closest(".region-node > .tree-row.region");
      if (regRow) {
        const rn = regRow.closest(".region-node"); const cc = rn.closest(".country-node").getAttribute("data-cc");
        const ri = +rn.getAttribute("data-ri"); const box = rn.querySelector(".region-children");
        const opening = box.style.display === "none";
        regRow.classList.toggle("open", opening);
        box.style.display = opening ? "" : "none";
        if (opening) fillRegion(rn, cc, ri, "");
        return;
      }
      // country expand
      const ctryRow = e.target.closest(".tree-row.country");
      if (ctryRow) {
        const node = ctryRow.closest(".country-node"); const cc = node.getAttribute("data-cc");
        const opening = !node.classList.contains("open");
        node.classList.toggle("open", opening);
        const children = node.querySelector(".country-children");
        children.style.display = opening ? "" : "none";
        if (opening && !children.dataset.filled) { fillCountry(node, cc); children.dataset.filled = "1"; }
      }
    });
  }

  /* ---------- summary ---------- */
  function totalLocationUnits() { return state.scopes.reduce((a, s) => a + scopeUnits(s), 0); }
  function syncSummary() {
    const cats = state.selectedCats.size;
    const locs = totalLocationUnits();
    const total = cats * locs;
    $("s-cats").textContent = fmt(cats);
    $("s-locs").textContent = fmt(locs);
    $("s-total").textContent = fmt(total);
    const chunk = Math.max(1, parseInt($("chunk").value, 10) || 1000);
    $("s-jobs").textContent = fmt(total ? Math.ceil(total / chunk) : 0);
  }

  /* ---------- query generation ---------- */
  function locLabel(cc, cn, rn, city, zip) {
    if (state.gran === "city") {
      const parts = [city];
      if (rn && rn !== "_" ) parts.push(rn);
      parts.push(cn);
      return parts.join(", ");
    }
    return zip + ", " + cn; // postal
  }
  // returns an array of location label strings for a scope (loads data if needed)
  async function expandScopeLabels(s) {
    const out = [];
    const useCity = state.gran === "city";
    if (s.type === "city") {
      if (useCity) out.push(locLabel(s.cc, s.cn, s.rn, s.city));
      else s.zips.forEach((z) => out.push(locLabel(s.cc, s.cn, s.rn, s.city, z)));
      return out;
    }
    const doc = await ensureLoc(s.cc);
    const regions = s.type === "region" ? doc.a.filter((r) => r.c === s.rc) : doc.a;
    for (const r of regions) for (const [city, zips] of r.ct) {
      if (useCity) out.push(locLabel(s.cc, doc.n, r.n, city));
      else zips.forEach((z) => out.push(locLabel(s.cc, doc.n, r.n, city, z)));
    }
    return out;
  }
  function queryFor(cat, label) {
    return state.gran === "city" ? cat + " in " + label : cat + " " + label;
  }
  // async generator over all queries
  async function* queryStream() {
    const cats = [...state.selectedCats];
    for (const s of state.scopes) {
      const labels = await expandScopeLabels(s);
      for (const label of labels) for (const cat of cats) yield queryFor(cat, label);
    }
  }

  async function preview() {
    const ta = $("preview"); ta.value = "Generating sample…";
    const out = []; const gen = queryStream();
    for (let i = 0; i < 200; i++) { const n = await gen.next(); if (n.done) break; out.push(n.value); }
    ta.value = out.join("\n") || "Select categories and locations first.";
  }

  /* ---------- job creation ---------- */
  function showError(msg) { const e = $("error-container"); e.textContent = msg; e.classList.add("show"); e.scrollIntoView({ behavior: "smooth", block: "nearest" }); }
  function clearError() { $("error-container").classList.remove("show"); }

  function settings() {
    return {
      lang: $("lang").value,
      zoom: parseInt($("zoom").value, 10) || 15,
      lat: $("latitude").value || "0",
      lon: $("longitude").value || "0",
      fast_mode: $("fastmode").checked,
      radius: parseInt($("radius").value, 10) || 10000,
      depth: parseInt($("depth").value, 10) || 20,
      email: $("email").checked,
      extra_reviews: false,
      max_time: Math.max(3, parseInt($("maxtime").value, 10) || 30) * 60,
      proxies: $("proxies").value.split("\n").map((p) => p.trim()).filter(Boolean),
    };
  }

  async function postJob(name, keywords, cfg) {
    const body = Object.assign({ name, keywords }, cfg);
    const r = await fetch("/api/v1/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) { let m = "HTTP " + r.status; try { m = (await r.json()).message || m; } catch (e) {} throw new Error(m); }
    return r.json();
  }

  async function createJobs() {
    clearError();
    const name = $("job-name").value.trim();
    if (!name) return showError("Enter a job name.");
    if (!state.selectedCats.size) return showError("Select at least one category.");
    if (!state.scopes.length) return showError("Select at least one location.");

    const cfg = settings();
    if (cfg.fast_mode && (cfg.lat === "0" && cfg.lon === "0"))
      return showError("Fast mode needs a real latitude/longitude in Geo & advanced.");

    const total = state.selectedCats.size * totalLocationUnits();
    const chunk = Math.max(1, parseInt($("chunk").value, 10) || 1000);
    const jobCount = Math.ceil(total / chunk);
    if (total === 0) return showError("Nothing to scrape.");
    if (jobCount > 500 && !confirm("This will create " + fmt(jobCount) + " jobs (" + fmt(total) + " searches). Continue?")) return;
    else if (total > 50000 && jobCount <= 500 && !confirm("This will create " + fmt(total) + " searches across " + fmt(jobCount) + " job(s). Continue?")) return;

    const btn = $("create-btn"); btn.disabled = true; btn.textContent = "Creating jobs…";
    const prog = $("progress"); prog.classList.add("show");
    const bar = $("progress-bar"); const plabel = $("progress-label");

    let posted = 0, failed = 0, idx = 0;
    const gen = queryStream();
    let batch = [], done = false;
    try {
      while (!done) {
        // fill a batch
        while (batch.length < chunk) {
          const n = await gen.next();
          if (n.done) { done = true; break; }
          batch.push(n.value);
        }
        if (batch.length) {
          idx++;
          const jn = jobCount > 1 ? name + " (" + idx + "/" + jobCount + ")" : name;
          try { await postJob(jn, batch, cfg); posted++; }
          catch (e) { failed++; if (failed <= 3) showError("Job " + idx + " failed: " + e.message); }
          batch = [];
          bar.style.width = Math.min(100, Math.round((idx / jobCount) * 100)) + "%";
          plabel.textContent = "Created " + fmt(posted) + " / " + fmt(jobCount) + " jobs" + (failed ? " · " + failed + " failed" : "");
          if (window.htmx) htmx.trigger(document.body, "refresh-jobs");
        }
      }
      plabel.textContent = "Done — created " + fmt(posted) + " job(s)" + (failed ? ", " + failed + " failed" : "") + ".";
    } finally {
      btn.disabled = false; btn.textContent = "Create scraping jobs";
      if (window.htmx) htmx.trigger(document.body, "refresh-jobs");
      setTimeout(() => prog.classList.remove("show"), 4000);
    }
  }

  /* ---------- util ---------- */
  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

  /* ---------- init ---------- */
  async function init() {
    initTheme();
    bindCategories(); bindLocations();
    $("chunk").addEventListener("input", syncSummary);
    $("preview-btn").addEventListener("click", preview);
    $("create-btn").addEventListener("click", createJobs);
    try {
      const [cats, countries] = await Promise.all([loadJSON("/static/data/categories.json"), loadJSON("/static/data/countries.json")]);
      state.categories = cats; state.countries = countries;
      renderCatList(); renderCountryTree(); syncSummary();
    } catch (e) { showError("Failed to load data: " + e.message); }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
