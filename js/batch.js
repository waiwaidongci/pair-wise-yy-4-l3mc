/*
 * 脱盐批次存档与持久化
 *  - 当前批次（active）容纳所有未结批、已入槽的遗物；
 *  - 结批时按槽固化判定快照，复核员逐槽填入排水量与余盐；
 *  - 历史读数更正/补录/删除若落在已结批批次上，原批次作废，
 *    该槽遗物带新数据回到新的当前批次重新判定，旧批次留档可查。
 */
(function (global) {
  "use strict";

  var MARKS_KEY = "zfl30Marks";
  var BATCH_KEY = "zfl30Batches";

  function uid() {
    return (global.crypto && global.crypto.randomUUID) ?
      global.crypto.randomUUID() :
      "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }

  // ---------- 标记（遗物）持久化，沿用原潜水标记的存储键 ----------
  function loadMarks() {
    try { return JSON.parse(global.localStorage.getItem(MARKS_KEY) || "[]"); }
    catch (e) { return []; }
  }
  function saveMarks(marks) {
    global.localStorage.setItem(MARKS_KEY, JSON.stringify(marks));
  }

  // ---------- 批次存储 ----------
  function loadAll() {
    try {
      var data = JSON.parse(global.localStorage.getItem(BATCH_KEY) || "null");
      if (!data || !Array.isArray(data.batches)) return { seq: 0, batches: [] };
      return data;
    } catch (e) { return { seq: 0, batches: [] }; }
  }
  function saveAll(state) {
    global.localStorage.setItem(BATCH_KEY, JSON.stringify(state));
  }

  function listBatches() { return loadAll().batches; }

  function getActive() {
    return listBatches().filter(function (b) { return b.status === "active"; })[0] || null;
  }

  function archivedBatches() {
    return listBatches()
      .filter(function (b) { return b.status !== "active"; })
      .sort(function (a, b) { return (b.closedAt || b.createdAt) > (a.closedAt || a.createdAt) ? 1 : -1; });
  }

  function nextCode(state) {
    return "BATCH-" + String(state.seq + 1).padStart(4, "0");
  }

  function createActive() {
    var state = loadAll();
    var batch = {
      id: uid(),
      code: nextCode(state),
      status: "active",
      createdAt: new Date().toISOString(),
      closedAt: null,
      reviewer: null,
      note: null,
      threshold: null,
      intervalHours: null,
      tanks: {},
      supersedes: []
    };
    state.seq += 1;
    state.batches.push(batch);
    saveAll(state);
    return batch;
  }

  function getOrCreateActive() { return getActive() || createActive(); }

  // 已结批（未作废）批次中包含某件遗物的，取最近一批
  function findClosedBatchForMark(markId) {
    var hit = null;
    listBatches().forEach(function (b) {
      if (b.status !== "closed") return;
      var contains = Object.keys(b.tanks).some(function (t) {
        return b.tanks[t].rows.some(function (r) { return r.markId === markId; });
      });
      if (contains && (!hit || b.closedAt > hit.closedAt)) hit = b;
    });
    return hit;
  }

  // 已结批且未作废批次里的全部遗物 id（这些不参与当前批次判定）
  function closedMarkIds() {
    var ids = {};
    listBatches().forEach(function (b) {
      if (b.status !== "closed") return;
      Object.keys(b.tanks).forEach(function (t) {
        b.tanks[t].rows.forEach(function (r) { ids[r.markId] = true; });
      });
    });
    return ids;
  }

  // 当前批次范围内的标记：有槽号、且不在任何有效结批快照中
  function activeMarks(marks) {
    var frozen = closedMarkIds();
    return marks.filter(function (m) {
      return (m.tank || "").trim() && !frozen[m.id];
    });
  }

  // ---------- 读数 / 换水登记 ----------
  function getMark(marks, markId) {
    return marks.filter(function (m) { return m.id === markId; })[0] || null;
  }

  function appendReading(mark, value, at) {
    mark.readings = mark.readings || [];
    var rec = { id: uid(), value: Number(value), at: at || new Date().toISOString() };
    mark.readings.push(rec);
    return rec;
  }

  function appendWaterChange(mark, at) {
    mark.waterChanges = mark.waterChanges || [];
    var rec = { id: uid(), at: at || new Date().toISOString() };
    mark.waterChanges.push(rec);
    return rec;
  }

  /*
   * 对某件遗物的历史数据做改动（补录/更正/删除读数、登记换水）后，
   * 若它已属于某个结批批次，则该批次作废，并保证存在当前批次承接重判。
   * 返回 { voided: [作废批次…], active: 当前批次 }
   */
  function cascadeAfterEdit(markId) {
    var state = loadAll();
    var voided = [];
    var active = state.batches.filter(function (b) { return b.status === "active"; })[0];
    if (!active) {
      active = {
        id: uid(), code: nextCode(state), status: "active",
        createdAt: new Date().toISOString(), closedAt: null, reviewer: null,
        note: null, threshold: null, intervalHours: null, tanks: {}, supersedes: []
      };
      state.seq += 1;
      state.batches.push(active);
    }
    state.batches.forEach(function (b) {
      if (b.status !== "closed") return;
      var contains = Object.keys(b.tanks).some(function (t) {
        return b.tanks[t].rows.some(function (r) { return r.markId === markId; });
      });
      if (!contains) return;
      b.status = "void";
      b.voidedAt = new Date().toISOString();
      b.voidReason = "历史读数/换水记录更正，按新数据重新判定";
      b.supersededBy = active.id;
      if (active.supersedes.indexOf(b.id) === -1) active.supersedes.push(b.id);
      voided.push(b);
    });
    saveAll(state);
    return { voided: voided, active: getActive() };
  }

  // 登记新读数；若该件已结批则触发作废重判
  function registerReading(markId, value, at) {
    var marks = loadMarks();
    var mark = getMark(marks, markId);
    if (!mark) throw new Error("遗物不存在");
    appendReading(mark, value, at);
    saveMarks(marks);
    var result = cascadeAfterEdit(markId);
    result.reading = (mark.readings || []).slice(-1)[0];
    return result;
  }

  function registerWaterChange(markId, at) {
    var marks = loadMarks();
    var mark = getMark(marks, markId);
    if (!mark) throw new Error("遗物不存在");
    appendWaterChange(mark, at);
    saveMarks(marks);
    return cascadeAfterEdit(markId);
  }

  function correctReading(markId, readingId, value, at) {
    var marks = loadMarks();
    var mark = getMark(marks, markId);
    if (!mark) throw new Error("遗物不存在");
    var rec = (mark.readings || []).filter(function (r) { return r.id === readingId; })[0];
    if (!rec) throw new Error("读数不存在");
    rec.value = Number(value);
    if (at) rec.at = at;
    saveMarks(marks);
    return cascadeAfterEdit(markId);
  }

  function deleteReading(markId, readingId) {
    var marks = loadMarks();
    var mark = getMark(marks, markId);
    if (!mark) throw new Error("遗物不存在");
    mark.readings = (mark.readings || []).filter(function (r) { return r.id !== readingId; });
    saveMarks(marks);
    return cascadeAfterEdit(markId);
  }

  /*
   * 复核结批：用当前阈值/间隔重新判定当前批次全部槽位，
   * 必须全部达标且无材质冲突；reviewData 形如
   * { reviewer, note, tanks: { "T-01": { discharge: 42, residualSalt: 3.1 } } }
   * 排水量单位 L，余盐单位 mg/L（Cl⁻ 计），逐槽必填。
   */
  function closeActive(reviewData, opts) {
    opts = opts || {};
    var threshold = opts.threshold != null ? opts.threshold : global.Desal.DEFAULT_THRESHOLD;
    var intervalHours = opts.intervalHours != null ? opts.intervalHours : global.Desal.DEFAULT_INTERVAL_H;
    var marks = activeMarks(loadMarks());
    var rows = global.Desal.judgeAll(marks, { threshold: threshold, intervalHours: intervalHours, now: opts.now });
    var notReady = rows.filter(function (r) { return r.state !== global.Desal.STATE.READY; });
    if (notReady.length) {
      return { ok: false, error: "仍有槽位未达标，不能结批", rows: notReady };
    }
    if (!rows.length) {
      return { ok: false, error: "当前批次没有任何已入槽的遗物" };
    }
    var byTank = {};
    rows.forEach(function (r) { (byTank[r.tank] = byTank[r.tank] || []).push(r); });

    var tanks = {};
    Object.keys(byTank).sort().forEach(function (tank) {
      var rv = (reviewData && reviewData.tanks || {})[tank];
      if (!rv || rv.discharge === "" || rv.discharge === undefined ||
          rv.residualSalt === "" || rv.residualSalt === undefined) {
        notReady.push({ tank: tank });
        return;
      }
      tanks[tank] = {
        discharge: Number(rv.discharge),
        residualSalt: Number(rv.residualSalt),
        materials: global.Desal.tankConflict(byTank[tank].map(function (r) { return r.mark; })).materials,
        rows: byTank[tank].map(function (r) {
          return {
            markId: r.mark.id,
            code: r.mark.code,
            type: r.mark.type,
            reading: { value: r.reading.value, at: r.reading.at },
            lastWaterAt: global.Desal.latestWaterChange(r.mark) &&
              global.Desal.latestWaterChange(r.mark).at,
            enteredAt: r.mark.enteredAt,
            reasons: r.reasons
          };
        })
      };
    });
    if (notReady.length) {
      return { ok: false, error: "存在未填写排水量或余盐的槽位", tanks: Object.keys(byTank) };
    }

    var state = loadAll();
    var batch = state.batches.filter(function (b) { return b.status === "active"; })[0];
    if (!batch) return { ok: false, error: "当前批次不存在" };
    batch.status = "closed";
    batch.closedAt = new Date().toISOString();
    batch.reviewer = reviewData.reviewer || "未署名复核员";
    batch.note = reviewData.note || "";
    batch.threshold = Number(threshold);
    batch.intervalHours = Number(intervalHours);
    batch.tanks = tanks;
    saveAll(state);
    return { ok: true, batch: batch };
  }

  global.BatchStore = {
    uid: uid,
    loadMarks: loadMarks,
    saveMarks: saveMarks,
    listBatches: listBatches,
    getActive: getActive,
    getOrCreateActive: getOrCreateActive,
    createActive: createActive,
    archivedBatches: archivedBatches,
    activeMarks: activeMarks,
    closedMarkIds: closedMarkIds,
    findClosedBatchForMark: findClosedBatchForMark,
    appendReading: appendReading,
    appendWaterChange: appendWaterChange,
    registerReading: registerReading,
    registerWaterChange: registerWaterChange,
    correctReading: correctReading,
    deleteReading: deleteReading,
    cascadeAfterEdit: cascadeAfterEdit,
    closeActive: closeActive
  };
})(window);
