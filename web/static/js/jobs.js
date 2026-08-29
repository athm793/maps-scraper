/* Maps Scraper — jobs dashboard: search, filter, sort, paginate, live progress. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Number(n).toLocaleString("en-US");
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const STATUS_RANK = { working: 0, pending: 1, ok: 2, failed: 3 };
  const STATUS_LABEL = { pending: "Pending", working: "Working", ok: "Completed", failed: "Failed" };

  const st = {
    rows: [],
    search: "",
    status: "",
    sortKey: "date",
    sortDir: "desc",
    page: 1,
    pageSize: 15,
    loaded: false,
  };

  function fmtDate(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return "—";
    return d.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" }) +
      " " + d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  }

  async function fetchSummary() {
    try {
      const r = await fetch("/api/v1/jobs/summary");
      if (!r.ok) return;
      const data = await r.json();
      st.rows = Array.isArray(data) ? data : [];
      st.loaded = true;
      render();
    } catch (e) { /* keep last good data */ }
  }

  function filtered() {
    const q = st.search.trim().toLowerCase();
    let rows = st.rows.filter((j) => {
      if (st.status && j.status !== st.status) return false;
      if (q && !(j.name || "").toLowerCase().includes(q) && !(j.id || "").toLowerCase().includes(q)) return false;
      return true;
    });
    const dir = st.sortDir === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      let av, bv;
      switch (st.sortKey) {
        case "name": av = (a.name || "").toLowerCase(); bv = (b.name || "").toLowerCase(); break;
        case "status": av = STATUS_RANK[a.status] ?? 9; bv = STATUS_RANK[b.status] ?? 9; break;
        case "results": av = a.results || 0; bv = b.results || 0; break;
        default: av = new Date(a.date).getTime() || 0; bv = new Date(b.date).getTime() || 0;
      }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
    return rows;
  }

  function progressCell(j) {
    const total = j.searches_total || j.keywords || 0;
    if (j.status === "pending") return '<span class="prog-muted">Queued · ' + fmt(total) + " searches</span>";
    if (j.status === "failed") return '<span class="prog-muted">—</span>';
    if (j.status === "ok") {
      return '<div class="prog"><div><b>' + fmt(j.results) + "</b> results " +
        '<span class="prog-muted">· ' + fmt(total) + " searches</span></div></div>";
    }
    // working: real progress = searches completed / total
    const done = j.searches_done || 0;
    const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
    const started = done > 0 || j.results > 0;
    const line = '<div><b>' + fmt(done) + "</b> / " + fmt(total) + " searches " +
      '<span class="prog-muted">· ' + fmt(j.results) + " found</span></div>";
    const bar = started
      ? '<div class="pbar"><i style="width:' + pct + '%"></i></div>'
      : '<div class="ibar"><i></i></div>';
    return '<div class="prog">' + line + bar + "</div>";
  }

  function actionsCell(j) {
    let html = "";
    if (j.status === "ok") {
      html += '<button type="button" class="button" data-act="view" data-id="' + j.id + '">View</button>';
      html += '<a class="button download-button" href="/download?id=' + encodeURIComponent(j.id) + '" download>Download</a>';
    }
    html += '<button type="button" class="delete-button" data-act="delete" data-id="' + j.id + '">Delete</button>';
    return html;
  }

  function render() {
    const rows = filtered();
    $("jobs-total").textContent = fmt(st.rows.length);
    // counts by status for the statusbar
    const counts = st.rows.reduce((a, j) => { a[j.status] = (a[j.status] || 0) + 1; return a; }, {});
    $("jobs-statusbar").innerHTML = ["working", "pending", "ok", "failed"]
      .filter((k) => counts[k])
      .map((k) => '<span class="sb-item sb-' + k + '">' + fmt(counts[k]) + " " + STATUS_LABEL[k] + "</span>")
      .join("") || (st.loaded ? '<span class="sb-item">No jobs yet</span>' : "");

    const total = rows.length;
    const pages = Math.max(1, Math.ceil(total / st.pageSize));
    if (st.page > pages) st.page = pages;
    const start = (st.page - 1) * st.pageSize;
    const pageRows = rows.slice(start, start + st.pageSize);

    const body = $("jobs-body");
    if (!pageRows.length) {
      body.innerHTML = '<tr><td colspan="5"><div class="empty-state">' +
        (st.rows.length ? "No jobs match your filters." : "No jobs yet. Build one on the left to get started.") + "</div></td></tr>";
    } else {
      body.innerHTML = pageRows.map((j) =>
        "<tr>" +
        '<td class="job-name" title="' + esc(j.name) + '">' + esc(j.name) + "</td>" +
        "<td>" + fmtDate(j.date) + "</td>" +
        '<td><span class="status-indicator status-' + j.status + '">' + (STATUS_LABEL[j.status] || j.status) + "</span></td>" +
        "<td>" + progressCell(j) + "</td>" +
        '<td class="col-actions">' + actionsCell(j) + "</td>" +
        "</tr>"
      ).join("");
    }

    // sort carets
    document.querySelectorAll("#job-table th.sortable").forEach((th) => {
      const key = th.getAttribute("data-sort");
      th.setAttribute("aria-sort", st.sortKey === key ? (st.sortDir === "asc" ? "ascending" : "descending") : "none");
      let c = th.querySelector(".caret"); if (!c) { c = document.createElement("span"); c.className = "caret"; th.appendChild(c); }
      c.textContent = st.sortKey === key ? (st.sortDir === "asc" ? " ▲" : " ▼") : "";
    });

    renderPagination(total, pages);
  }

  function renderPagination(total, pages) {
    const p = $("jobs-pagination");
    if (!st.loaded || total === 0) { p.innerHTML = ""; return; }
    const start = (st.page - 1) * st.pageSize + 1;
    const end = Math.min(total, st.page * st.pageSize);
    p.innerHTML =
      '<span class="pg-info">' + fmt(start) + "–" + fmt(end) + " of " + fmt(total) + "</span>" +
      '<div class="pg-controls">' +
      '<button class="btn btn-sm" data-pg="first" ' + (st.page <= 1 ? "disabled" : "") + ">«</button>" +
      '<button class="btn btn-sm" data-pg="prev" ' + (st.page <= 1 ? "disabled" : "") + ">‹ Prev</button>" +
      '<span class="pg-page">Page ' + fmt(st.page) + " of " + fmt(pages) + "</span>" +
      '<button class="btn btn-sm" data-pg="next" ' + (st.page >= pages ? "disabled" : "") + ">Next ›</button>" +
      '<button class="btn btn-sm" data-pg="last" ' + (st.page >= pages ? "disabled" : "") + ">»</button>" +
      "</div>" +
      '<label class="pg-size">Rows <select id="jobs-pagesize">' +
      [15, 25, 50, 100].map((n) => '<option value="' + n + '"' + (st.pageSize === n ? " selected" : "") + ">" + n + "</option>").join("") +
      "</select></label>";
  }

  function openMap(id) {
    fetch("/view?id=" + encodeURIComponent(id)).then((r) => r.text()).then((html) => {
      const c = $("map-modal-container");
      c.innerHTML = html;
      // re-execute the inline script (innerHTML does not run scripts)
      c.querySelectorAll("script").forEach((old) => {
        const s = document.createElement("script");
        if (old.src) s.src = old.src; else s.textContent = old.textContent;
        old.replaceWith(s);
      });
    }).catch(() => {});
  }

  async function deleteJob(id) {
    if (!confirm("Delete this job?")) return;
    try {
      await fetch("/api/v1/jobs/" + encodeURIComponent(id), { method: "DELETE" });
      st.rows = st.rows.filter((j) => j.id !== id);
      render();
      fetchSummary();
    } catch (e) {}
  }

  function bind() {
    $("jobs-search").addEventListener("input", (e) => { st.search = e.target.value; st.page = 1; render(); });
    $("jobs-status").addEventListener("change", (e) => { st.status = e.target.value; st.page = 1; render(); });
    document.querySelectorAll("#job-table th.sortable").forEach((th) => th.addEventListener("click", () => {
      const key = th.getAttribute("data-sort");
      if (st.sortKey === key) st.sortDir = st.sortDir === "asc" ? "desc" : "asc";
      else { st.sortKey = key; st.sortDir = key === "date" || key === "results" ? "desc" : "asc"; }
      render();
    }));
    $("jobs-body").addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]"); if (!b) return;
      const id = b.getAttribute("data-id");
      if (b.getAttribute("data-act") === "view") openMap(id);
      else if (b.getAttribute("data-act") === "delete") deleteJob(id);
    });
    $("jobs-pagination").addEventListener("click", (e) => {
      const b = e.target.closest("[data-pg]"); if (!b) return;
      const pages = Math.max(1, Math.ceil(filtered().length / st.pageSize));
      const a = b.getAttribute("data-pg");
      if (a === "first") st.page = 1; else if (a === "prev") st.page = Math.max(1, st.page - 1);
      else if (a === "next") st.page = Math.min(pages, st.page + 1); else if (a === "last") st.page = pages;
      render();
    });
    $("jobs-pagination").addEventListener("change", (e) => {
      if (e.target.id === "jobs-pagesize") { st.pageSize = +e.target.value; st.page = 1; render(); }
    });
    document.body.addEventListener("refresh-jobs", fetchSummary);
  }

  function init() {
    bind();
    fetchSummary();
    setInterval(fetchSummary, 5000);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
