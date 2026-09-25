/*
 * app.js —— 页面操作（视图切换、标记地图、脱盐监护台渲染、筛选与JSON导出）
 * 判定规则见 desalination.js，批次存档见 batches.js。
 */
(function () {
  "use strict";

  const $ = sel => document.querySelector(sel);
  const D = window.Desal, Store = window.Store;

  // ---------- 通用 ----------
  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function fmt(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  }
  function toLocalInput(iso) {
    if (!iso) return "";
    const d = new Date(iso), p = n => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function fromLocalInput(v) {
    return v ? new Date(v).toISOString() : "";
  }
  let toastTimer = null;
  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
  }
  function download(name, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---------- 视图切换 ----------
  const tabMap = $("#tabMap"), tabDesal = $("#tabDesal");
  tabMap.onclick = () => switchView("map");
  tabDesal.onclick = () => switchView("desal");
  function switchView(name) {
    const mapOn = name === "map";
    tabMap.classList.toggle("active", mapOn);
    tabDesal.classList.toggle("active", !mapOn);
    $("#mapView").hidden = !mapOn;
    $("#desalView").hidden = mapOn;
    $("#exportBtn").textContent = mapOn ? "导出标记JSON" : "导出当前批次JSON";
    if (!mapOn) renderConsole();
  }
  $("#exportBtn").onclick = () => {
    if ($("#mapView").hidden) {
      const payload = Store.exportPayload(consoleTanks().flatMap(t => t.artifacts));
      download("desal-batches-" + Date.now() + ".json", payload);
    } else {
      download("dive-marks.json", marks);
    }
  };

  // ============================================================
  // 原有功能：沉船标记地图、编辑、时间线
  // ============================================================
  const map = $("#map");
  const form = $("#form");
  const list = $("#list");
  const filter = $("#filter");
  const view = $("#view");
  const listTitle = $("#listTitle");
  const typeNames = { ceramic: "陶片", wood: "木构件", metal: "金属件", unknown: "未知物" };
  let marks = JSON.parse(localStorage.getItem("zfl30Marks") || "[]");
  let pending = null;
  if (!marks.length) {
    marks = [
      { id: crypto.randomUUID(), code: "A-017", type: "ceramic", dive: "DIVE-01", x: 42, y: 46, depth: "17.8m", orientation: "东", condition: "边缘残缺", note: "靠近船肋" },
      { id: crypto.randomUUID(), code: "W-003", type: "wood", dive: "DIVE-02", x: 58, y: 39, depth: "18.2m", orientation: "西北", condition: "稳定", note: "疑似横梁" }
    ];
    saveMarks();
  }
  for (let i = 0; i < 7; i++) {
    const rib = document.createElement("div");
    rib.className = "rib";
    rib.style.left = 28 + i * 7 + "%";
    map.appendChild(rib);
  }
  function saveMarks() { localStorage.setItem("zfl30Marks", JSON.stringify(marks)); }
  function renderMap() {
    map.querySelectorAll(".marker").forEach(el => el.remove());
    const filtered = filter.value ? marks.filter(m => m.type === filter.value) : marks;
    filtered.forEach(mark => {
      const el = document.createElement("button");
      el.className = "marker " + mark.type + (mark.id === form.id.value ? " selected" : "");
      el.style.left = mark.x + "%";
      el.style.top = mark.y + "%";
      el.textContent = mark.code.slice(0, 2);
      el.onclick = event => { event.stopPropagation(); editMark(mark.id); };
      map.appendChild(el);
    });
    if (view.value === "timeline") renderTimeline(filtered);
    else renderList(filtered);
  }
  function renderList(data) {
    listTitle.textContent = "标记列表";
    list.className = "list";
    list.innerHTML = data.map(m => '<div class="item ' + (m.id === form.id.value ? "active" : "") + '" data-id="' + m.id + '"><b>' + esc(m.code) + '</b> <span class="pill">' + typeNames[m.type] + '</span><div class="muted">' + esc(m.dive) + ' · ' + esc(m.depth) + ' · ' + esc(m.orientation) + '</div><div>' + esc(m.condition) + '</div></div>').join("");
    list.querySelectorAll("[data-id]").forEach(el => el.onclick = () => editMark(el.dataset.id));
  }
  function renderTimeline(data) {
    listTitle.textContent = "潜次时间线";
    list.className = "timeline";
    const groups = data.reduce((g, item) => ((g[item.dive] ||= []).push(item), g), {});
    list.innerHTML = Object.entries(groups).map(([dive, items]) => '<div class="item"><b>' + esc(dive) + '</b><div class="muted">新增' + items.length + '个标记</div>' + items.map(i => '<div>' + esc(i.code) + ' · ' + typeNames[i.type] + '</div>').join("") + '</div>').join("");
  }
  function editMark(id) {
    const mark = marks.find(m => m.id === id);
    if (!mark) return;
    for (const [key, value] of Object.entries(mark)) if (form[key]) form[key].value = value;
    pending = { x: mark.x, y: mark.y };
    renderMap();
  }
  map.addEventListener("click", event => {
    const rect = map.getBoundingClientRect();
    pending = {
      x: Number(((event.clientX - rect.left) / rect.width * 100).toFixed(2)),
      y: Number(((event.clientY - rect.top) / rect.height * 100).toFixed(2))
    };
    form.reset();
    form.id.value = "";
    form.code.value = "M-" + String(marks.length + 1).padStart(3, "0");
    form.dive.value = "DIVE-01";
    renderMap();
  });
  form.onsubmit = event => {
    event.preventDefault();
    if (!pending) pending = { x: 50, y: 50 };
    const data = Object.fromEntries(new FormData(form).entries());
    if (data.id) Object.assign(marks.find(m => m.id === data.id), data, pending);
    else marks.push({ ...data, id: crypto.randomUUID(), ...pending });
    saveMarks(); renderMap();
  };
  $("#deleteBtn").onclick = () => {
    if (!form.id.value) return;
    marks = marks.filter(m => m.id !== form.id.value);
    form.reset(); pending = null; saveMarks(); renderMap();
  };
  filter.onchange = renderMap;
  view.onchange = renderMap;

  // ============================================================
  // 脱盐监护台
  // ============================================================
  const dForm = $("#dForm");
  const dMaterial = $("#dMaterial"), dSearch = $("#dSearch"), dStatus = $("#dStatus");
  const cfgThreshold = $("#cfgThreshold"), cfgMin = $("#cfgMin"), cfgMax = $("#cfgMax");

  function groupTanks() {
    const now = new Date().toISOString();
    const map = {};
    Store.activeArtifacts().forEach(a => { (map[a.tankNo] ||= []).push(a); });
    return Object.keys(map).sort().map(tankNo => {
      const artifacts = map[tankNo];
      return { tankNo, artifacts, evaluation: D.judgeTank(artifacts, Store.getConfig(), now) };
    });
  }

  // 筛选（材质 / 关键字 / 状态）后的在槽批次，页面与导出共用
  function consoleTanks() {
    const q = dSearch.value.trim().toUpperCase();
    const mat = dMaterial.value;
    const statusSel = dStatus.value;
    return groupTanks().filter(t => {
      if (mat && !t.artifacts.some(a => a.material === mat)) return false;
      if (q && !t.tankNo.toUpperCase().includes(q) && !t.artifacts.some(a => a.code.toUpperCase().includes(q))) return false;
      if (statusSel === "anomaly" && !t.evaluation.hasAnomaly) return false;
      if (statusSel === "ready" && !t.evaluation.ready) return false;
      if (statusSel === "pending" && t.evaluation.state !== "pending") return false;
      return true;
    });
  }

  function renderConsole() {
    const cfg = Store.getConfig();
    cfgThreshold.value = cfg.threshold; cfgMin.value = cfg.minHours; cfgMax.value = cfg.maxHours;

    const tanks = consoleTanks();
    const pendingTanks = tanks.filter(t => !t.evaluation.hasAnomaly);
    const anomalyTanks = tanks.filter(t => t.evaluation.hasAnomaly);

    $("#colPending").innerHTML = pendingTanks.map(tankCard).join("") || emptyHint("暂无在槽批次");
    $("#colAnomaly").innerHTML = anomalyTanks.map(tankCard).join("") || emptyHint("无异常");
    $("#countPending").textContent = "(" + pendingTanks.length + ")";
    $("#countAnomaly").textContent = "(" + anomalyTanks.length + ")";
    renderClosed();
  }

  function emptyHint(text) {
    return '<div class="muted" style="padding:14px;text-align:center">' + text + "</div>";
  }

  function verdictBlock(verdict, conflictReasons) {
    const reasons = (conflictReasons || []).concat(verdict.reasons.map(r => r.text));
    const anomalies = verdict.anomalies.map(a => a.text);
    let html = "";
    if (anomalies.length) html += '<ul class="reasons bad">' + anomalies.map(t => "<li>" + esc(t) + "</li>").join("") + "</ul>";
    if (reasons.length) html += '<ul class="reasons">' + reasons.map(t => "<li>" + esc(t) + "</li>").join("") + "</ul>";
    if (!anomalies.length && !reasons.length && !conflictReasons) html += '<div class="muted ok" style="font-size:12px;margin-top:4px">✓ 已达标，待复核结批</div>';
    return html;
  }

  function artifactRow(row) {
    const a = row.artifact, v = row.verdict;
    const reading = D.latestReading(a);
    const change = D.latestChange(a);
    const readingCls = reading && reading.value > Store.getConfig().threshold ? "bad" : "ok";
    return '<div class="art">'
      + '<div class="art-head"><b>' + esc(a.code) + '</b>'
      + '<span class="pill">' + esc(D.materialName(a.material)) + '</span>'
      + '<span class="' + readingCls + '">' + (reading ? reading.value + " μS/cm" : "无读数") + '</span>'
      + '<span class="art-actions">'
      + '<button type="button" class="ghost" data-act="reading" data-id="' + a.id + '">读数</button>'
      + '<button type="button" class="ghost" data-act="change" data-id="' + a.id + '">换水</button>'
      + '<button type="button" class="ghost" data-act="edit" data-id="' + a.id + '">编辑</button>'
      + '</span></div>'
      + '<div class="muted" style="font-size:12px;margin-top:3px">入槽 ' + fmt(a.enteredAt)
      + ' · 最近换水 ' + fmt(change ? change.at : null)
      + (change && change.note ? "（" + esc(change.note) + "）" : "") + '</div>'
      + verdictBlock(v, [])
      + '</div>';
  }

  function tankCard(t) {
    const ev = t.evaluation;
    const badge = ev.ready
      ? '<span class="badge ready">可结批</span>'
      : ev.hasAnomaly ? '<span class="badge anomaly">异常</span>'
      : '<span class="badge pending">待换水</span>';
    const mats = [...new Set(t.artifacts.map(a => D.materialName(a.material)))].join(" / ");
    const tankAnomalyHtml = ev.tankAnomalies.length
      ? '<ul class="reasons bad">' + ev.tankAnomalies.map(x => "<li>" + esc(x.text) + "</li>").join("") + "</ul>"
      : "";
    const rows = ev.artifacts.map(r => artifactRow(r)).join("");
    const closeBtn = ev.ready
      ? '<button type="button" data-act="close" data-tank="' + esc(t.tankNo) + '">复核结批</button>'
      : '<button type="button" class="secondary" data-act="close" data-tank="' + esc(t.tankNo) + '" title="存在未达标项或异常时无法结批">申请结批</button>';
    return '<div class="tank-card ' + (ev.ready ? "ready" : ev.hasAnomaly ? "anomaly" : "") + '">'
      + '<div class="tank-head"><b>槽位 ' + esc(t.tankNo) + '</b>' + badge
      + '<span class="pill">' + esc(mats) + '</span>'
      + '<span class="muted">' + t.artifacts.length + ' 件</span></div>'
      + tankAnomalyHtml
      + rows
      + '<div class="tank-foot">' + closeBtn + '</div>'
      + '</div>';
  }

  // ---------- 结批栏 ----------
  function renderClosed() {
    const batches = Store.archivedBatches();
    $("#countClosed").textContent = "(" + batches.length + ")";
    $("#colClosed").innerHTML = batches.map(batchCard).join("") || emptyHint("暂无结批记录");
  }

  function batchCard(b) {
    const voided = b.state === "void";
    const badge = voided ? '<span class="badge void">已作废</span>' : '<span class="badge ready">已结批</span>';
    return '<button type="button" class="batch-card ' + (voided ? "void" : "") + '" data-act="batch" data-id="' + b.id + '">'
      + '<div class="tank-head"><b>' + esc(b.batchNo) + ' · 槽位 ' + esc(b.tankNo) + '</b>' + badge + '</div>'
      + '<div class="muted" style="font-size:12px;margin-top:4px">'
      + "结批 " + fmt(b.closedAt) + " · 复核 " + esc(b.reviewer)
      + '<br>排水量 ' + esc(b.displacedVolume) + ' L · 余盐 ' + esc(b.residualSalt) + ' mg/L · ' + b.artifacts.length + " 件"
      + (voided ? "<br><span class='bad'>作废原因：" + esc(b.voidReason) + "</span>" : "")
      + '</div></button>';
  }

  // ---------- 槽位卡片操作委托 ----------
  $("#colPending").addEventListener("click", onCardClick);
  $("#colAnomaly").addEventListener("click", onCardClick);
  $("#colClosed").addEventListener("click", onCardClick);
  function onCardClick(e) {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === "batch") showBatch(btn.dataset.id);
    else if (act === "close") showClose(btn.dataset.tank);
    else if (act === "reading") showReading(btn.dataset.id);
    else if (act === "change") showChange(btn.dataset.id);
    else if (act === "edit") showArtifact(btn.dataset.id);
  }

  // ---------- 右侧表单各模式 ----------
  function panelHint() {
    dForm.innerHTML = '<h2>脱盐监护台</h2><div class="muted">选择左侧槽位中的遗物进行读数、换水登记；整槽达标后由复核员确认排水量与余盐并结批。历史读数更正后，原批次自动作废并回槽重判。</div>';
  }

  function showArtifact(id) {
    const a = id ? Store.getArtifact(id) : null;
    dForm.innerHTML =
      '<h2>' + (a ? "编辑遗物" : "登记遗物") + '</h2>'
      + '<input type="hidden" name="mode" value="artifact">'
      + (a ? '<input type="hidden" name="id" value="' + a.id + '">' : "")
      + '<label>槽号 *</label><input name="tankNo" required placeholder="例如 T-05" value="' + esc(a ? a.tankNo : "") + '">'
      + '<label>遗物编号 *</label><input name="code" required value="' + esc(a ? a.code : "") + '">'
      + '<label>材质 *</label><select name="material">'
      + Object.keys(D.MATERIALS).map(m => '<option value="' + m + '"' + (a && a.material === m ? " selected" : "") + '>' + D.materialName(m) + "</option>").join("")
      + '</select>'
      + '<label>入槽时刻 *</label><input name="enteredAt" type="datetime-local" required value="' + toLocalInput(a ? a.enteredAt : new Date().toISOString()) + '">'
      + '<label>关联沉船标记（可选）</label><select name="markCode"><option value="">不关联</option>'
      + markOptions(a ? a.markCode : "") + '</select>'
      + (a ? "" : '<label>入槽初始电导率 μS/cm（可选）</label><input name="reading" type="number" min="0" placeholder="例如 480">')
      + '<div class="toolbar" style="margin-top:12px"><button>' + (a ? "保存修改" : "登记入槽") + '</button>'
      + (a ? '<button type="button" class="secondary" id="dDelete">删除遗物</button>' : '<button type="button" class="secondary" id="dCancel">取消</button>') + '</div>';
    $("#dCancel") && ($("#dCancel").onclick = panelHint);
    $("#dDelete") && ($("#dDelete").onclick = () => {
      Store.deleteArtifact(a.id);
      renderConsole(); panelHint(); toast("遗物已移出登记");
    });
  }

  function markOptions(selected) {
    return marks.map(m => '<option value="' + esc(m.code) + '"' + (m.code === selected ? " selected" : "") + ">" + esc(m.code) + " · " + typeNames[m.type] + "</option>").join("");
  }

  function showReading(id) {
    const a = Store.getArtifact(id);
    if (!a) return;
    const latest = D.latestReading(a);
    const rows = a.readings.slice().sort((x, y) => new Date(y.at) - new Date(x.at));
    dForm.innerHTML =
      '<h2>电导率读数 · ' + esc(a.code) + '</h2>'
      + '<div class="muted">槽位 ' + esc(a.tankNo) + " · " + esc(D.materialName(a.material)) + "</div>"
      + '<input type="hidden" name="mode" value="reading"><input type="hidden" name="id" value="' + a.id + '">'
      + '<label>新读数 μS/cm *</label><input name="value" type="number" min="0" step="1" required autofocus placeholder="阈值 ' + Store.getConfig().threshold + '">'
      + '<div class="toolbar" style="margin-top:10px"><button>记录读数</button><button type="button" class="secondary" id="dCancel">返回</button></div>'
      + '<h3 style="margin-top:12px">历史读数</h3>'
      + (rows.length ? '<table class="hist"><tr><th>时刻</th><th>μS/cm</th><th></th></tr>'
        + rows.map(r => '<tr><td>' + fmt(r.at) + (r.correctedAt ? ' <span class="warn">已更正</span>' : "") + '</td><td>' + r.value + '</td>'
          + '<td><button type="button" class="ghost" data-act="correctActive" data-rid="' + r.id + '">更正</button></td></tr>').join("")
        + "</table>" : '<div class="muted">暂无读数</div>');
    $("#dCancel").onclick = panelHint;
    dForm.querySelectorAll("[data-act='correctActive']").forEach(b => b.onclick = () => {
      const r = rows.find(x => x.id === b.dataset.rid);
      const nv = prompt("将 " + fmt(r.at) + " 的读数更正为（μS/cm）：", r.value);
      if (nv == null || isNaN(Number(nv))) return;
      Store.correctActiveReading(a.id, r.id, Number(nv));
      renderConsole(); showReading(a.id); toast("读数已更正，已按新数据重新判定");
    });
  }

  function showChange(id) {
    const a = Store.getArtifact(id);
    if (!a) return;
    dForm.innerHTML =
      '<h2>换水登记 · ' + esc(a.code) + '</h2>'
      + '<div class="muted">槽位 ' + esc(a.tankNo) + " · 最近换水 " + fmt(D.latestChange(a) ? D.latestChange(a).at : null) + "</div>"
      + '<input type="hidden" name="mode" value="change"><input type="hidden" name="id" value="' + a.id + '">'
      + '<label>换水说明</label><input name="note" placeholder="例如 第三次换水，全槽更换">'
      + '<div class="toolbar" style="margin-top:10px"><button>记录换水</button><button type="button" class="secondary" id="dCancel">返回</button></div>';
    $("#dCancel").onclick = panelHint;
  }

  function showClose(tankNo) {
    const check = Store.canCloseTank(tankNo);
    if (!check.evaluation) { toast("槽位为空"); return; }
    const ev = check.evaluation;
    const checklist = ev.artifacts.map(r => {
      const latest = D.latestReading(r.artifact);
      const high = latest && latest.value > Store.getConfig().threshold;
      return "<li>" + (r.verdict.ok && !ev.conflict ? "✓ " : "✗ ") + esc(r.artifact.code)
        + "：" + (latest ? latest.value + " μS/cm" : "无读数")
        + " · " + esc(D.materialName(r.artifact.material)) + "</li>";
    }).join("");
    dForm.innerHTML =
      '<h2>结批复核 · 槽位 ' + esc(tankNo) + '</h2>'
      + (check.ok ? '<div class="muted ok">全部达标，可由复核员确认结批。</div>'
        : '<div class="warning">该槽存在未达标项或异常，结批按钮将被拒绝，请先处理左侧清单。</div>')
      + '<ul class="checklist" style="margin-top:8px">' + checklist + "</ul>"
      + (ev.conflict ? '<div class="warning">同槽材质冲突，必须先分槽处理。</div>' : "")
      + '<input type="hidden" name="mode" value="close"><input type="hidden" name="tankNo" value="' + esc(tankNo) + '">'
      + '<label>复核员 *</label><input name="reviewer" required value="' + esc(localStorage.getItem("zfl30LastReviewer") || "") + '" placeholder="姓名">'
      + '<label>排水量 L *</label><input name="displacedVolume" type="number" min="0" step="0.1" required>'
      + '<label>余盐 mg/L *</label><input name="residualSalt" type="number" min="0" step="0.1" required>'
      + '<label>结批备注</label><textarea name="note"></textarea>'
      + '<div class="toolbar" style="margin-top:10px"><button' + (check.ok ? "" : " disabled") + '>确认结批</button>'
      + '<button type="button" class="secondary" id="dCancel">返回</button></div>';
    $("#dCancel").onclick = panelHint;
  }

  function showBatch(id) {
    const b = Store.getBatch(id);
    if (!b) return;
    const voided = b.state === "void";
    const tables = b.artifacts.map(a => {
      const rows = a.readings.slice().sort((x, y) => new Date(y.at) - new Date(x.at));
      return '<div class="art"><div class="art-head"><b>' + esc(a.code) + '</b><span class="pill">' + esc(D.materialName(a.material)) + '</span></div>'
        + '<table class="hist"><tr><th>时刻</th><th>μS/cm</th><th></th></tr>'
        + rows.map(r => '<tr><td>' + fmt(r.at) + (r.correctedAt ? ' <span class="warn">已更正</span>' : "") + '</td><td>' + r.value + '</td>'
          + '<td>' + (voided ? "—" : '<button type="button" class="ghost" data-act="correctHist" data-aid="' + a.id + '" data-rid="' + r.id + '">更正</button>') + '</td></tr>').join("")
        + "</table></div>";
    }).join("");
    dForm.innerHTML =
      '<h2>' + esc(b.batchNo) + ' · 槽位 ' + esc(b.tankNo) + '</h2>'
      + (voided
        ? '<div class="warning">该批次已作废：' + esc(b.voidReason) + '<br>遗物已回槽按新数据重判，旧记录保留备查。</div>'
        : '<div class="muted ok">已结批存档。如发现历史读数有误，可在下方更正，原批次将作废并回槽重判。</div>')
      + '<ul class="checklist" style="margin-top:8px">'
      + "<li>结批时刻：" + fmt(b.closedAt) + "</li>"
      + "<li>复核员：" + esc(b.reviewer) + "</li>"
      + "<li>排水量：" + esc(b.displacedVolume) + " L</li>"
      + "<li>余盐：" + esc(b.residualSalt) + " mg/L</li>"
      + "<li>判定阈值：" + b.config.threshold + " μS/cm · 最小间隔 " + b.config.minHours + "h · 超期上限 " + b.config.maxHours + "h</li>"
      + (b.note ? "<li>备注：" + esc(b.note) + "</li>" : "")
      + "</ul>" + tables
      + '<div class="toolbar" style="margin-top:10px"><button type="button" id="exportBatch">导出该批次JSON</button>'
      + '<button type="button" class="secondary" id="dCancel">返回</button></div>';
    $("#dCancel").onclick = panelHint;
    $("#exportBatch").onclick = () => download("batch-" + b.batchNo + ".json", Store.exportBatchPayload(b));
    dForm.querySelectorAll("[data-act='correctHist']").forEach(btn => {
      btn.onclick = () => showCorrect(id, btn.dataset.aid, btn.dataset.rid);
    });
  }

  function showCorrect(batchId, artifactId, readingId) {
    const b = Store.getBatch(batchId);
    const a = b.artifacts.find(x => x.id === artifactId);
    const r = a.readings.find(x => x.id === readingId);
    dForm.innerHTML =
      '<h2>更正历史读数</h2>'
      + '<div class="warning">提交后批次 ' + esc(b.batchNo) + ' 将标记作废并原样留档；槽位 ' + esc(b.tankNo)
      + ' 的遗物全部回槽，按更正后的数据重新判定。</div>'
      + '<input type="hidden" name="mode" value="correct">'
      + '<input type="hidden" name="batchId" value="' + b.id + '">'
      + '<input type="hidden" name="artifactId" value="' + a.id + '">'
      + '<input type="hidden" name="readingId" value="' + r.id + '">'
      + '<label>遗物 / 读数时刻</label><div class="muted">' + esc(a.code) + " · " + fmt(r.at) + " · 原值 " + r.value + " μS/cm</div>"
      + '<label>更正后读数 μS/cm *</label><input name="value" type="number" min="0" step="1" required value="' + r.value + '">'
      + '<label>更正原因 *</label><input name="reason" required placeholder="例如 仪表校准偏差">'
      + '<label>更正人 *</label><input name="reviewer" required value="' + esc(localStorage.getItem("zfl30LastReviewer") || "") + '">'
      + '<div class="toolbar" style="margin-top:10px"><button>确认更正并重判</button>'
      + '<button type="button" class="secondary" id="dCancel">返回</button></div>';
    $("#dCancel").onclick = () => showBatch(batchId);
  }

  // ---------- 表单统一提交 ----------
  dForm.addEventListener("submit", e => {
    e.preventDefault();
    const fd = new FormData(dForm);
    const mode = fd.get("mode");
    if (mode === "artifact") {
      const data = {
        tankNo: fd.get("tankNo").trim(),
        code: fd.get("code").trim(),
        material: fd.get("material"),
        enteredAt: fromLocalInput(fd.get("enteredAt")),
        markCode: fd.get("markCode") || "",
        reading: fd.get("reading")
      };
      if (fd.get("id")) Store.updateArtifact(fd.get("id"), data);
      else Store.addArtifact(data);
      renderConsole(); panelHint(); toast("遗物信息已保存");
    } else if (mode === "reading") {
      Store.addReading(fd.get("id"), fd.get("value"));
      renderConsole(); showReading(fd.get("id")); toast("读数已记录，已重新判定");
    } else if (mode === "change") {
      Store.addChange(fd.get("id"), fd.get("note") || "常规换水");
      renderConsole(); panelHint(); toast("换水已登记，换水间隔重新计时");
    } else if (mode === "close") {
      const reviewer = fd.get("reviewer").trim();
      localStorage.setItem("zfl30LastReviewer", reviewer);
      const res = Store.closeTank(fd.get("tankNo"), {
        reviewer,
        displacedVolume: fd.get("displacedVolume"),
        residualSalt: fd.get("residualSalt"),
        note: fd.get("note")
      });
      if (!res.ok) { toast(res.error); showClose(fd.get("tankNo")); return; }
      renderConsole(); panelHint(); toast("批次 " + res.batch.batchNo + " 已结批存档");
    } else if (mode === "correct") {
      const reviewer = fd.get("reviewer").trim();
      localStorage.setItem("zfl30LastReviewer", reviewer);
      const res = Store.correctArchivedReading(
        fd.get("batchId"), fd.get("artifactId"), fd.get("readingId"),
        fd.get("value"), fd.get("reason"), reviewer
      );
      if (!res.ok) { toast(res.error); return; }
      dStatus.value = "";
      renderConsole(); panelHint();
      toast("原批次已作废留档，槽位 " + res.tankNo + " 已按新数据回槽重判");
    }
  });

  // ---------- 筛选与配置 ----------
  $("#newArtifactBtn").onclick = () => showArtifact(null);
  dMaterial.onchange = renderConsole;
  dSearch.oninput = renderConsole;
  dStatus.onchange = renderConsole;
  function cfgPatch() {
    Store.updateConfig({
      threshold: Number(cfgThreshold.value) || D.DEFAULT_CONFIG.threshold,
      minHours: Number(cfgMin.value) || D.DEFAULT_CONFIG.minHours,
      maxHours: Number(cfgMax.value) || D.DEFAULT_CONFIG.maxHours
    });
    renderConsole();
  }
  cfgThreshold.onchange = cfgPatch;
  cfgMin.onchange = cfgPatch;
  cfgMax.onchange = cfgPatch;

  // ---------- 启动 ----------
  renderMap();
  panelHint();
})();
