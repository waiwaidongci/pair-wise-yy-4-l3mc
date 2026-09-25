/*
 * 页面操作：潜水图标记（地图、编辑、时间线）+ 脱盐监护台
 * （槽位看板、读数/换水登记、复核结批弹窗、筛选与 JSON 导出）。
 * 判定规则全部来自 Desal，批次读写全部走 BatchStore。
 */
(function () {
  "use strict";

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var D = Desal, B = BatchStore;

  var map = $("#map");
  var form = $("#form");
  var list = $("#list");
  var filter = $("#filter");
  var view = $("#view");
  var listTitle = $("#listTitle");
  var modal = $("#modal");
  var modalCard = $("#modalCard");

  var SETTINGS_KEY = "zfl30DesalSettings";
  var marks = B.loadMarks();
  var pending = null;
  var settings = loadSettings();

  // ---------- 工具 ----------
  function loadSettings() {
    try {
      var s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
      return s || { threshold: D.DEFAULT_THRESHOLD, intervalHours: D.DEFAULT_INTERVAL_H };
    } catch (e) { return { threshold: D.DEFAULT_THRESHOLD, intervalHours: D.DEFAULT_INTERVAL_H }; }
  }
  function persistSettings() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }
  function save() { B.saveMarks(marks); }
  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function hoursAgoIso(h) { return new Date(Date.now() - h * 36e5).toISOString(); }
  function fmt(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  }
  function ago(iso) {
    if (!iso) return "—";
    var h = (Date.now() - new Date(iso)) / 36e5;
    if (h < 1) return Math.max(1, Math.round(h * 60)) + " 分钟前";
    if (h < 48) return h.toFixed(1) + " 小时前";
    return (h / 24).toFixed(1) + " 天前";
  }
  function toLocalInput(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d)) return "";
    var p = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      "T" + p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function nowLocalInput() { return toLocalInput(new Date().toISOString()); }
  function normalTank(v) { return (v || "").trim().toUpperCase(); }

  // ---------- 首次使用示例数据 ----------
  (function seed() {
    var hasMarks = localStorage.getItem("zfl30Marks") !== null;
    var hasBatches = localStorage.getItem("zfl30Batches") !== null;
    if (hasMarks && hasBatches) return;

    if (!hasMarks) {
      function m(code, type, tank, dive, depth, entered, waters, readings, x, y) {
        return {
          id: B.uid(), code: code, type: type, tank: tank, enteredAt: entered,
          dive: dive, depth: depth, orientation: "", condition: "", note: "",
          x: x, y: y,
          waterChanges: (waters || []).map(function (at) { return { id: B.uid(), at: at }; }),
          readings: (readings || []).map(function (r) { return { id: B.uid(), value: r[0], at: r[1] }; })
        };
      }
      marks = [
        m("A-017", "ceramic", "T-01", "DIVE-01", "17.8m", hoursAgoIso(72),
          [hoursAgoIso(50), hoursAgoIso(26)],
          [[520, hoursAgoIso(71)], [260, hoursAgoIso(49)], [150, hoursAgoIso(27)], [88, hoursAgoIso(25)]], 42, 46),
        m("A-021", "ceramic", "T-01", "DIVE-01", "18.0m", hoursAgoIso(70),
          [hoursAgoIso(25)],
          [[480, hoursAgoIso(69)], [95, hoursAgoIso(24)]], 45, 43),
        m("M-009", "metal", "T-02", "DIVE-02", "19.6m", hoursAgoIso(60),
          [hoursAgoIso(20)],
          [[300, hoursAgoIso(40)], [210, hoursAgoIso(18)]], 61, 36),
        m("M-012", "metal", "T-02", "DIVE-02", "19.1m", hoursAgoIso(60),
          [hoursAgoIso(6)],
          [[310, hoursAgoIso(40)], [65, hoursAgoIso(5)]], 64, 33),
        m("W-003", "wood", "T-03", "DIVE-02", "18.2m", hoursAgoIso(40),
          [hoursAgoIso(30)],
          [[140, hoursAgoIso(10)]], 58, 39),
        m("A-030", "ceramic", "T-03", "DIVE-03", "18.5m", hoursAgoIso(40),
          [hoursAgoIso(30)],
          [[90, hoursAgoIso(8)]], 55, 42),
        m("U-002", "unknown", "T-04", "DIVE-03", "20.3m", hoursAgoIso(30), [], [], 49, 52),
        m("C-101", "ceramic", "T-05", "DIVE-01", "17.1m", hoursAgoIso(120),
          [hoursAgoIso(96), hoursAgoIso(72), hoursAgoIso(48)],
          [[640, hoursAgoIso(118)], [300, hoursAgoIso(94)], [120, hoursAgoIso(70)], [55, hoursAgoIso(46)]], 38, 41),
        {
          id: B.uid(), code: "U-005", type: "unknown", tank: "", enteredAt: "",
          dive: "DIVE-04", depth: "—", orientation: "", condition: "刚出水，等待分配槽位", note: "",
          x: 52, y: 48, waterChanges: [], readings: []
        }
      ];
      save();
    }

    if (!hasBatches && !hasMarks) {
      // 仅全新安装时给出一条已结批示例，演示存档与更正作废流程；
      // 老用户缺批次数据时由 getOrCreateActive 现建空当前批次。
      var c101 = marks.filter(function (x) { return x.code === "C-101"; })[0];
      var closed = {
        id: B.uid(), code: "BATCH-0001", status: "closed",
        createdAt: hoursAgoIso(120), closedAt: hoursAgoIso(12),
        reviewer: "陈维", note: "脱盐稳定，余盐达标后转恒温保湿柜。",
        threshold: D.DEFAULT_THRESHOLD, intervalHours: D.DEFAULT_INTERVAL_H,
        tanks: {
          "T-05": {
            discharge: 180, residualSalt: 2.4, materials: ["陶片"],
            rows: [{
              markId: c101 ? c101.id : "", code: "C-101", type: "ceramic",
              reading: { value: 55, at: hoursAgoIso(46) },
              lastWaterAt: hoursAgoIso(48), enteredAt: hoursAgoIso(120),
              reasons: ["电导率已降至阈值以下，换水间隔满足要求"]
            }]
          }
        },
        supersedes: [], voidedAt: null, voidReason: null, supersededBy: null
      };
      var active = {
        id: B.uid(), code: "BATCH-0002", status: "active",
        createdAt: hoursAgoIso(2), closedAt: null, reviewer: null, note: null,
        threshold: null, intervalHours: null, tanks: {}, supersedes: []
      };
      localStorage.setItem("zfl30Batches", JSON.stringify({ seq: 2, batches: [closed, active] }));
    }
  })();

  // ---------- 沉船平面地图 ----------
  for (var i = 0; i < 7; i++) {
    var rib = document.createElement("div");
    rib.className = "rib";
    rib.style.left = (28 + i * 7) + "%";
    map.appendChild(rib);
  }

  function renderMap() {
    map.querySelectorAll(".marker").forEach(function (el) { el.remove(); });
    var filtered = filter.value ? marks.filter(function (x) { return x.type === filter.value; }) : marks;
    filtered.forEach(function (mk) {
      if (mk.x == null) return;
      var el = document.createElement("button");
      el.className = "marker " + mk.type + (mk.id === form.id.value ? " selected" : "");
      el.style.left = mk.x + "%";
      el.style.top = mk.y + "%";
      el.textContent = mk.code.slice(0, 2);
      el.onclick = function (ev) { ev.stopPropagation(); edit(mk.id); };
      map.appendChild(el);
    });
  }

  function renderList(data) {
    listTitle.textContent = "标记列表";
    list.className = "list";
    list.innerHTML = data.map(function (mk) {
      var tankPill = mk.tank ? ' <span class="pill">槽位 ' + esc(mk.tank) + "</span>" : "";
      return '<div class="item ' + (mk.id === form.id.value ? "active" : "") + '" data-id="' + mk.id + '">' +
        "<b>" + esc(mk.code) + '</b> <span class="pill">' + esc(D.typeName(mk.type)) + "</span>" + tankPill +
        '<div class="muted">' + esc(mk.dive) + " · " + esc(mk.depth) + " · " + esc(mk.orientation || "—") + "</div>" +
        "<div>" + esc(mk.condition || "") + "</div></div>";
    }).join("");
    list.querySelectorAll("[data-id]").forEach(function (el) {
      el.onclick = function () { edit(el.dataset.id); };
    });
  }

  function renderTimeline(data) {
    listTitle.textContent = "潜次时间线";
    list.className = "timeline";
    var groups = data.reduce(function (g, item) {
      (g[item.dive] = g[item.dive] || []).push(item);
      return g;
    }, {});
    list.innerHTML = Object.entries(groups).map(function (pair) {
      var items = pair[1];
      return '<div class="item"><b>' + esc(pair[0]) + "</b>" +
        '<div class="muted">新增' + items.length + "个标记</div>" +
        items.map(function (it) {
          return "<div>" + esc(it.code) + " · " + esc(D.typeName(it.type)) + "</div>";
        }).join("") + "</div>";
    }).join("");
  }

  function renderDive() {
    renderMap();
    var data = filter.value ? marks.filter(function (x) { return x.type === filter.value; }) : marks;
    if (view.value === "timeline") renderTimeline(data);
    else renderList(data);
  }

  function edit(id) {
    var mk = marks.filter(function (x) { return x.id === id; })[0];
    if (!mk) return;
    form.reset();
    Object.keys(mk).forEach(function (key) {
      if (!form[key]) return;
      form[key].value = key === "enteredAt" ? toLocalInput(mk[key]) : mk[key];
    });
    pending = { x: mk.x, y: mk.y };
    renderDive();
  }

  map.addEventListener("click", function (event) {
    var rect = map.getBoundingClientRect();
    pending = {
      x: Number(((event.clientX - rect.left) / rect.width * 100).toFixed(2)),
      y: Number(((event.clientY - rect.top) / rect.height * 100).toFixed(2))
    };
    form.reset();
    form.id.value = "";
    form.code.value = "M-" + String(marks.length + 1).padStart(3, "0");
    form.dive.value = "DIVE-01";
    renderDive();
  });

  form.onsubmit = function (event) {
    event.preventDefault();
    if (!pending) pending = { x: 50, y: 50 };
    var data = Object.fromEntries(new FormData(form).entries());
    data.tank = normalTank(data.tank);
    data.enteredAt = data.enteredAt ? new Date(data.enteredAt).toISOString() : "";
    if (data.id) {
      var old = marks.filter(function (x) { return x.id === data.id; })[0];
      Object.assign(old, data, pending);
    } else {
      marks.push(Object.assign({ waterChanges: [], readings: [] }, data, { id: B.uid() }, pending));
    }
    save();
    renderDive();
    if (!$("#tankView").hidden) renderConsole();
  };

  $("#deleteBtn").onclick = function () {
    if (!form.id.value) return;
    marks = marks.filter(function (x) { return x.id !== form.id.value; });
    form.reset();
    pending = null;
    save();
    renderDive();
    if (!$("#tankView").hidden) renderConsole();
  };

  filter.onchange = renderDive;
  view.onchange = renderDive;

  // ---------- 脱盐监护台 ----------
  var tankFilterEl = $("#tankFilter");
  var stateFilterEl = $("#stateFilter");
  var thresholdEl = $("#threshold");
  var intervalEl = $("#intervalH");

  thresholdEl.value = settings.threshold;
  intervalEl.value = settings.intervalHours;
  thresholdEl.onchange = function () {
    settings.threshold = Number(thresholdEl.value) || D.DEFAULT_THRESHOLD;
    persistSettings();
    renderConsole();
  };
  intervalEl.onchange = function () {
    settings.intervalHours = Number(intervalEl.value) || D.DEFAULT_INTERVAL_H;
    persistSettings();
    renderConsole();
  };
  tankFilterEl.onchange = renderConsole;
  stateFilterEl.onchange = renderConsole;

  function activeRows() {
    B.getOrCreateActive();
    return D.judgeAll(B.activeMarks(marks), {
      threshold: settings.threshold,
      intervalHours: settings.intervalHours
    });
  }

  function groupRows(rows) {
    var groups = {};
    rows.forEach(function (r) {
      (groups[r.tank] = groups[r.tank] || []).push(r);
    });
    Object.keys(groups).forEach(function (t) {
      groups[t].sort(function (a, b) { return a.mark.code > b.mark.code ? 1 : -1; });
    });
    return groups;
  }

  function renderConsole() {
    var active = B.getOrCreateActive();
    var rows = activeRows();
    var groups = groupRows(rows);
    var tankNames = Object.keys(groups).sort();
    B.archivedBatches().forEach(function (b) {
      Object.keys(b.tanks).forEach(function (t) {
        if (tankNames.indexOf(t) === -1) tankNames.push(t);
      });
    });
    tankNames.sort();

    var prev = tankFilterEl.value;
    tankFilterEl.innerHTML = '<option value="">全部槽位</option>' +
      tankNames.map(function (t) { return '<option value="' + t + '">' + t + "</option>"; }).join("");
    if (tankNames.indexOf(prev) !== -1) tankFilterEl.value = prev;

    var tankF = tankFilterEl.value;
    var stateF = stateFilterEl.value;
    var readyCount = tankNames.filter(function (t) {
      return groups[t] && D.tankSummary(groups[t]).ready;
    }).length;
    var conflictCount = tankNames.filter(function (t) {
      return groups[t] && D.tankSummary(groups[t]).conflict;
    }).length;

    $("#batchMeta").innerHTML =
      '<div class="muted">当前批次</div><b>' + esc(active.code) + "</b>" +
      '<div class="muted">建立 ' + fmt(active.createdAt) + " · 槽位 " + tankNames.length +
      " · 达标 " + readyCount + " · 冲突 " + conflictCount +
      (active.supersedes.length ? ' · <span style="color:#96382d">含重判槽位（原批次已作废）</span>' : "") +
      "</div>";

    var pendingHtml = "";
    var abnHtml = "";
    tankNames.forEach(function (t) {
      if (!groups[t]) return;
      if (tankF && t !== tankF) return;
      var tankRows = groups[t];
      var summary = D.tankSummary(tankRows);
      var shown = stateF ? tankRows.filter(function (r) { return r.state === stateF; }) : tankRows;
      if (stateF && !shown.length) return;
      var card = tankCard(t, tankRows, shown, summary);
      if (summary.conflict) abnHtml += card;
      else pendingHtml += card;
    });

    var archives = B.archivedBatches();
    if (tankF) archives = archives.filter(function (b) { return !!b.tanks[tankF]; });
    var doneHtml = archives.map(archivedBatchCard).join("");
    if (!doneHtml) doneHtml = '<div class="empty">尚无结批记录</div>';
    if (!pendingHtml) pendingHtml = '<div class="empty">当前批次没有待换水槽位</div>';
    if (!abnHtml) abnHtml = '<div class="empty">未发现同槽材质冲突</div>';

    $("#colPending").innerHTML = pendingHtml;
    $("#colAbn").innerHTML = abnHtml;
    $("#colDone").innerHTML = doneHtml;
    $("#cntPending").textContent = "（" + countTanks(pendingHtml) + " 槽）";
    $("#cntAbn").textContent = "（" + countTanks(abnHtml) + " 槽）";
    $("#cntDone").textContent = "（" + archives.length + " 批）";

    bindCardButtons();
  }

  function countTanks(html) {
    return (html.match(/class="tankcard/g) || []).length;
  }

  function reasonTags(r) {
    var cls = r.state === D.STATE.READY ? "good"
      : r.state === D.STATE.CONFLICT ? "bad"
      : r.state === D.STATE.SOAKING ? "warn" : "bad";
    return '<div class="tags">' + r.reasons.map(function (t) {
      return '<span class="tag ' + cls + '">' + esc(t) + "</span>";
    }).join("") + "</div>";
  }

  function readingCell(r) {
    if (!r.reading) return '<span class="muted">无读数</span>';
    var over = r.reading.value > settings.threshold;
    return '<span class="reading ' + (over ? "over" : "ok") + '">' +
      r.reading.value + " μS/cm</span>";
  }

  function activeArtRowHtml(r) {
    var lastWc = D.latestWaterChange(r.mark);
    var baseText = lastWc
      ? "最近换水 " + fmt(lastWc.at) + "（" + ago(lastWc.at) + "）"
      : (r.mark.enteredAt ? "入槽 " + fmt(r.mark.enteredAt) + "（" + ago(r.mark.enteredAt) + "），未换过水" : "未填入槽时刻");
    var badge = r.state === D.STATE.READY
      ? '<span class="tag good">达标待结批</span>'
      : '<span class="tag ' + (r.state === "conflict" ? "bad" : "warn") + '">' + esc(D.STATE_NAMES[r.state]) + "</span>";
    return '<div class="artrow">' +
      '<div class="art-main"><span><b>' + esc(r.mark.code) + '</b> <span class="pill">' +
      esc(D.typeName(r.mark.type)) + "</span> " + badge + "</span>" + readingCell(r) + "</div>" +
      '<div class="muted">' + esc(baseText) + "</div>" +
      reasonTags(r) +
      '<div class="rowbtns">' +
      '<button class="mini" data-act="readings" data-id="' + r.mark.id + '">登记/查看读数</button>' +
      '<button class="mini secondary" data-act="water" data-id="' + r.mark.id + '">登记换水</button>' +
      "</div></div>";
  }

  function tankCard(tank, tankRows, shownRows, summary) {
    var materials = D.tankConflict(tankRows.map(function (r) { return r.mark; })).materials;
    var cls = "tankcard" + (summary.conflict ? " conflict" : summary.ready ? " ready" : "");
    var headTag = summary.conflict
      ? '<span class="tag bad">材质冲突</span>'
      : summary.ready ? '<span class="tag good">整槽达标，可结批</span>'
      : '<span class="tag warn">未达标</span>';
    return '<div class="' + cls + '" data-tank="' + tank + '">' +
      '<div class="tank-head"><b>槽位 ' + tank + "</b>" +
      '<span><span class="pill">' + materials.map(esc).join(" / ") + "</span> " + headTag +
      "</span></div>" +
      shownRows.map(activeArtRowHtml).join("") +
      "</div>";
  }

  function archivedBatchCard(b) {
    var voided = b.status === "void";
    var head =
      '<div class="tank-head"><b>' + esc(b.code) + (voided ? "（已作废）" : "") + "</b>" +
      (voided ? '<span class="tag bad">读数更正 · 重新判定中</span>'
        : '<span class="tag good">已结批</span>') + "</div>" +
      '<div class="muted">复核员：' + esc(b.reviewer) + " · 结批 " + fmt(b.closedAt) +
      '<br>阈值 ' + (b.threshold || "—") + " μS/cm · 换水间隔 " + (b.intervalHours || "—") + " h" +
      (b.note ? "<br>" + esc(b.note) : "") + "</div>";
    var tanksHtml = Object.keys(b.tanks).sort().map(function (t) {
      var tk = b.tanks[t];
      var rows = tk.rows.map(function (r) {
        var over = r.reading && b.threshold != null && r.reading.value > b.threshold;
        return '<div class="artrow"><div class="art-main">' +
          "<span><b>" + esc(r.code) + '</b> <span class="pill">' + esc(D.typeName(r.type)) + "</span></span>" +
          (r.reading ? '<span class="reading ' + (over ? "over" : "ok") + '">' + r.reading.value + " μS/cm</span>" : "") +
          "</div>" +
          '<div class="muted">入槽 ' + fmt(r.enteredAt) + " · 最近换水 " + fmt(r.lastWaterAt) + "</div>" +
          '<div class="rowbtns"><button class="mini" data-act="correct" data-id="' + esc(r.markId) +
          '">更正历史读数</button></div></div>';
      }).join("");
      return '<div style="border-top:1px dashed #cddadb;margin-top:8px;padding-top:7px">' +
        '<div class="tank-head"><b>槽位 ' + esc(t) + '</b>' +
        '<span class="pill">排水量 ' + tk.discharge + ' L · 余盐 ' + tk.residualSalt + " mg/L</span></div>" +
        rows + "</div>";
    }).join("");
    return '<div class="tankcard archived' + (voided ? " void" : "") + '">' +
      (voided ? '<div class="stamp">作废</div>' : "") + head + tanksHtml + "</div>";
  }

  function bindCardButtons() {
    document.querySelectorAll("[data-act]").forEach(function (btn) {
      btn.onclick = function () {
        var id = btn.dataset.id;
        if (btn.dataset.act === "readings" || btn.dataset.act === "correct") openReadings(id);
        else if (btn.dataset.act === "water") openWater(id);
      };
    });
  }

  // ---------- 弹窗 ----------
  function closeModal() { modal.hidden = true; modalCard.innerHTML = ""; }
  modal.addEventListener("click", function (e) { if (e.target === modal) closeModal(); });

  function findMark(id) {
    return marks.filter(function (x) { return x.id === id; })[0] || null;
  }
  function refreshAfterStore(result) {
    marks = B.loadMarks();
    save();
    renderConsole();
    renderDive();
    (result.voided || []).forEach(function (b) {
      // 用轻量提示：作废事件在批次头与存档卡上均有留痕
    });
  }
  function voidNotice(result) {
    if (result.voided && result.voided.length) {
      return '<div class="confirmlist">原批次 ' +
        result.voided.map(function (b) { return esc(b.code); }).join("、") +
        " 已作废，遗物按新数据转入 " + esc(result.active.code) + " 重新判定；旧批次已留档。</div>";
    }
    return "";
  }

  function openReadings(markId) {
    var mk = findMark(markId) || B.loadMarks().filter(function (x) { return x.id === markId; })[0];
    if (!mk) return;
    var closed = B.findClosedBatchForMark(markId);
    var readings = (mk.readings || []).slice().sort(function (a, b) {
      return new Date(b.at) - new Date(a.at);
    });
    modalCard.innerHTML =
      "<h2>电导率读数 · " + esc(mk.code) + "（槽位 " + esc(mk.tank || "—") + "）</h2>" +
      (closed ? '<div class="confirmlist">该件属于已结批批次 ' + esc(closed.code) +
        "：更正、删除或补录读数都会使该批次作废，并按新数据重新判定，旧批次留档。</div>" : "") +
      '<table class="readings"><thead><tr><th>时刻</th><th>电导率 μS/cm</th><th style="width:150px">操作</th></tr></thead><tbody>' +
      readings.map(function (r) {
        return '<tr data-rid="' + r.id + '"><td><input type="datetime-local" class="r-at" value="' +
          toLocalInput(r.at) + '"></td><td><input type="number" step="1" class="r-val" value="' + r.value + '"></td>' +
          '<td><button class="mini" data-do="fix">更正</button> ' +
          '<button class="mini danger" data-do="del">删除</button></td></tr>';
      }).join("") +
      "</tbody></table>" +
      '<div class="inlineform"><div><label>补录时刻</label><input type="datetime-local" class="new-at" value="' +
      nowLocalInput() + '"></div><div><label>电导率 μS/cm</label><input type="number" step="1" class="new-val" placeholder="如 96"></div>' +
      '<button data-do="add">补录读数</button></div>' +
      '<div class="modal-foot"><button class="secondary" data-do="close">关闭</button></div>';
    modal.hidden = false;

    modalCard.querySelectorAll("tr[data-rid]").forEach(function (tr) {
      var rid = tr.dataset.rid;
      tr.querySelector('[data-do="fix"]').onclick = function () {
        var at = tr.querySelector(".r-at").value;
        var val = tr.querySelector(".r-val").value;
        if (val === "" || !at) return alert("请填写读数与时刻");
        var res = B.correctReading(markId, rid, val, new Date(at).toISOString());
        refreshAfterStore(res);
        alert(voidNotice(res) ? "已更正：原批次作废，按新数据重判，旧记录留档。" : "读数已更正。");
        openReadings(markId);
      };
      tr.querySelector('[data-do="del"]').onclick = function () {
        if (!confirm("删除该历史读数？若已结批，原批次将作废并重新判定。")) return;
        var res = B.deleteReading(markId, rid);
        refreshAfterStore(res);
        alert(voidNotice(res) ? "已删除：原批次作废，按新数据重判，旧记录留档。" : "读数已删除。");
        openReadings(markId);
      };
    });
    modalCard.querySelector('[data-do="add"]').onclick = function () {
      var at = modalCard.querySelector(".new-at").value;
      var val = modalCard.querySelector(".new-val").value;
      if (val === "" || !at) return alert("请填写读数与时刻");
      var res = B.registerReading(markId, val, new Date(at).toISOString());
      refreshAfterStore(res);
      alert(voidNotice(res) ? "已补录：原批次作废，按新数据重判，旧记录留档。" : "读数已登记。");
      openReadings(markId);
    };
    modalCard.querySelector('[data-do="close"]').onclick = closeModal;
  }

  function openWater(markId) {
    var mk = findMark(markId);
    if (!mk) return;
    var history = (mk.waterChanges || []).slice().sort(function (a, b) { return new Date(b.at) - new Date(a.at); });
    modalCard.innerHTML =
      "<h2>换水记录 · " + esc(mk.code) + "（槽位 " + esc(mk.tank || "—") + "）</h2>" +
      '<label>本次换水时刻</label><input type="datetime-local" id="wcAt" value="' + nowLocalInput() + '">' +
      "<h2>历史换水</h2>" +
      (history.length ? history.map(function (w) {
        return '<div class="muted">· ' + fmt(w.at) + "（" + ago(w.at) + "）</div>";
      }).join("") : '<div class="muted">尚无换水记录，间隔将自入槽时刻起算。</div>') +
      '<div class="modal-foot"><button id="wcSave">登记换水</button>' +
      '<button class="secondary" id="wcCancel">关闭</button></div>';
    modal.hidden = false;
    $("#wcCancel", modalCard).onclick = closeModal;
    $("#wcSave", modalCard).onclick = function () {
      var at = $("#wcAt", modalCard).value;
      if (!at) return alert("请填写换水时刻");
      var res = B.registerWaterChange(markId, new Date(at).toISOString());
      refreshAfterStore(res);
      closeModal();
      renderConsole();
      alert("换水已登记，间隔重新起算。");
    };
  }

  // ---------- 复核结批 ----------
  $("#closeBatchBtn").onclick = function () {
    var rows = activeRows();
    var groups = groupRows(rows);
    var tanks = Object.keys(groups).sort();
    var notReady = rows.filter(function (r) { return r.state !== D.STATE.READY; });
    if (!tanks.length) return alert("当前批次没有任何已入槽的遗物。");

    var warnHtml = notReady.length
      ? '<div class="confirmlist">以下遗物未达标，结批前必须留在待换水：<br>' +
        notReady.map(function (r) {
          return "· 槽位 " + r.tank + " " + r.mark.code + "：" + r.reasons.join("；");
        }).join("<br>") + "</div>"
      : '<div class="confirmlist" style="background:#edf7ef;border-color:#b6d3bb;color:#2f6d43">全部槽位达标，可由复核员结批。</div>';

    modalCard.innerHTML =
      "<h2>复核结批 · " + esc(B.getActive().code) + "</h2>" + warnHtml +
      "<label>复核员</label><input id='rvName' placeholder='值班复核员姓名'>" +
      "<label>结批备注</label><textarea id='rvNote' placeholder='如：转恒温保湿柜'></textarea>" +
      "<h2>逐槽复核数据</h2>" +
      '<table class="readings"><thead><tr><th>槽位</th><th>排水量 L</th><th>余盐 mg/L</th></tr></thead><tbody>' +
      tanks.map(function (t) {
        var s = D.tankSummary(groups[t]);
        return '<tr data-tank="' + t + '"><td><b>' + t + "</b> " +
          (s.ready ? '<span class="tag good">达标</span>' : '<span class="tag bad">未达标</span>') +
          '</td><td><input type="number" step="0.1" class="discharge" placeholder="排水量"' +
          (s.ready ? "" : " disabled") + "></td>" +
          '<td><input type="number" step="0.1" class="residual" placeholder="余盐（Cl⁻）"' +
          (s.ready ? "" : " disabled") + "></td></tr>";
      }).join("") + "</tbody></table>" +
      '<div class="modal-foot"><button id="rvSave"' + (notReady.length ? " disabled" : "") +
      ">确认结批</button><button class='secondary' id='rvCancel'>取消</button></div>";
    modal.hidden = false;

    $("#rvCancel", modalCard).onclick = closeModal;
    $("#rvSave", modalCard).onclick = function () {
      var review = {
        reviewer: $("#rvName", modalCard).value.trim(),
        note: $("#rvNote", modalCard).value.trim(),
        tanks: {}
      };
      var missing = false;
      tanks.forEach(function (t) {
        var tr = modalCard.querySelector('tr[data-tank="' + t + '"]');
        var dis = tr.querySelector(".discharge").value;
        var res = tr.querySelector(".residual").value;
        if (dis === "" || res === "") missing = true;
        review.tanks[t] = { discharge: dis, residualSalt: res };
      });
      if (!review.reviewer) return alert("请填写复核员姓名");
      if (missing) return alert("每个达标槽位都必须填写排水量和余盐。");
      var out = B.closeActive(review, {
        threshold: settings.threshold,
        intervalHours: settings.intervalHours
      });
      if (!out.ok) return alert(out.error);
      B.getOrCreateActive();
      closeModal();
      renderConsole();
      alert("批次 " + out.batch.code + " 已结批存档，新的当前批次已建立。");
    };
  };

  // ---------- 导出（跟随当前视图/当前批次与筛选） ----------
  $("#exportBtn").onclick = function () {
    if ($("#tankView").hidden) {
      download("dive-marks.json", JSON.stringify(marks, null, 2));
      return;
    }
    var active = B.getOrCreateActive();
    var rows = activeRows();
    var groups = groupRows(rows);
    var tankF = tankFilterEl.value;
    var stateF = stateFilterEl.value;
    var tanks = Object.keys(groups).sort().filter(function (t) {
      return !tankF || t === tankF;
    }).map(function (t) {
      var tankRows = groups[t];
      var shown = stateF ? tankRows.filter(function (r) { return r.state === stateF; }) : tankRows;
      var s = D.tankSummary(tankRows);
      return {
        tank: t,
        materials: D.tankConflict(tankRows.map(function (r) { return r.mark; })).materials,
        state: s.state,
        readyToClose: s.ready,
        items: shown.map(function (r) {
          var w = D.latestWaterChange(r.mark);
          return {
            code: r.mark.code,
            material: r.mark.type,
            enteredAt: r.mark.enteredAt || null,
            latestConductivity: r.reading ? { value: r.reading.value, at: r.reading.at } : null,
            latestWaterChange: w ? w.at : null,
            elapsedHours: r.interval && r.interval.baseAt != null ? Number(r.interval.elapsedH.toFixed(2)) : null,
            judgment: r.state,
            reasons: r.reasons
          };
        })
      };
    });
    var payload = {
      exportedAt: new Date().toISOString(),
      batch: { code: active.code, id: active.id, createdAt: active.createdAt, supersedes: active.supersedes },
      threshold: settings.threshold,
      intervalHours: settings.intervalHours,
      filter: { tank: tankF || null, state: stateF || null },
      tanks: tanks
    };
    download("desal-" + active.code.toLowerCase() + ".json", JSON.stringify(payload, null, 2));
  };

  function download(name, text) {
    var blob = new Blob([text], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---------- 页签 ----------
  document.querySelectorAll(".tab").forEach(function (tab) {
    tab.onclick = function () {
      var isTank = tab.dataset.tab === "tank";
      document.querySelectorAll(".tab").forEach(function (t) { t.classList.remove("active"); });
      tab.classList.add("active");
      $("#diveView").hidden = isTank;
      $("#tankView").hidden = !isTank;
      $("#exportBtn").textContent = isTank ? "导出当前批次JSON" : "导出标记JSON";
      if (isTank) renderConsole();
    };
  });

  renderDive();
})();
