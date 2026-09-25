/*
 * batches.js —— 批次存档与历史重判（localStorage 持久化）
 *
 * 数据模型
 *   state.artifacts  在槽遗物 { id, tankNo, batchId, code, material, enteredAt,
 *                               readings:[{id,value,at}], changes:[{id,at,note}] }
 *   state.cycles     每槽当前开放批次 { [tankNo]: { batchId, tankNo, openedAt } }
 *   state.batches    已结批存档 { id, batchNo, tankNo, closedAt, reviewer,
 *                               displacedVolume, residualSalt, config,
 *                               artifacts:[...快照], state:'closed'|'void',
 *                               voidedAt, voidReason, supersededBy }
 *
 * 历史读数更正 → 旧批次 state='void' 留档，遗物快照回到在槽按新数据重判，
 *                 旧批次 supersededBy 指向新开放批次。
 */
(function (global) {
  "use strict";

  const KEY = "zfl30DesalState";
  const D = global.Desal;

  function uid() {
    return global.crypto && crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }

  function load() {
    try {
      const parsed = JSON.parse(localStorage.getItem(KEY) || "null");
      if (parsed && Array.isArray(parsed.artifacts) && Array.isArray(parsed.batches)) {
        parsed.config = Object.assign({}, D.DEFAULT_CONFIG, parsed.config || {});
        parsed.cycles = parsed.cycles || {};
        return parsed;
      }
    } catch (e) { /* 存档损坏时重建 */ }
    const seeded = seed();
    save(seeded);
    return seeded;
  }

  function save(state) {
    localStorage.setItem(KEY, JSON.stringify(state));
  }

  let state = load();

  // ---------- 配置 ----------
  function getConfig() {
    return Object.assign({}, state.config);
  }
  function updateConfig(patch) {
    state.config = Object.assign({}, state.config, patch);
    persist();
    return getConfig();
  }

  // ---------- 在槽遗物 ----------
  function activeArtifacts() {
    return state.artifacts.slice();
  }

  function getArtifact(id) {
    return state.artifacts.find(a => a.id === id) || null;
  }

  function openCycleFor(tankNo) {
    if (!state.cycles[tankNo]) {
      state.cycles[tankNo] = { batchId: uid(), tankNo, openedAt: new Date().toISOString() };
    }
    return state.cycles[tankNo];
  }

  function pruneCycle(tankNo) {
    if (!state.artifacts.some(a => a.tankNo === tankNo)) delete state.cycles[tankNo];
  }

  function addArtifact(data) {
    const cycle = openCycleFor(data.tankNo);
    const artifact = {
      id: uid(),
      tankNo: data.tankNo,
      batchId: cycle.batchId,
      code: data.code,
      material: data.material,
      markCode: data.markCode || "",
      enteredAt: data.enteredAt,
      readings: [],
      changes: []
    };
    if (data.reading) artifact.readings.push({ id: uid(), value: Number(data.reading), at: data.enteredAt });
    state.artifacts.push(artifact);
    persist();
    return artifact;
  }

  function updateArtifact(id, patch) {
    const a = getArtifact(id);
    if (!a) return null;
    // 换槽：跟随目标槽的当前批次
    if (patch.tankNo && patch.tankNo !== a.tankNo) {
      const cycle = openCycleFor(patch.tankNo);
      a.batchId = cycle.batchId;
    }
    Object.assign(a, patch);
    pruneCycle(a.tankNo);
    persist();
    return a;
  }

  function deleteArtifact(id) {
    const a = getArtifact(id);
    if (!a) return;
    const tankNo = a.tankNo;
    state.artifacts = state.artifacts.filter(x => x.id !== id);
    pruneCycle(tankNo);
    persist();
  }

  function addReading(id, value) {
    const a = getArtifact(id);
    if (!a) return null;
    const reading = { id: uid(), value: Number(value), at: new Date().toISOString() };
    a.readings.push(reading);
    persist();
    return reading;
  }

  // 更正当前批次内的读数（直接改，按新数据立即重判）
  function correctActiveReading(artifactId, readingId, value) {
    const a = getArtifact(artifactId);
    if (!a) return null;
    const r = a.readings.find(x => x.id === readingId);
    if (!r) return null;
    r.value = Number(value);
    persist();
    return r;
  }

  function addChange(id, note) {
    const a = getArtifact(id);
    if (!a) return null;
    const change = { id: uid(), at: new Date().toISOString(), note: note || "常规换水" };
    a.changes.push(change);
    persist();
    return change;
  }

  // ---------- 结批 ----------
  function canCloseTank(tankNo, now) {
    const items = state.artifacts.filter(a => a.tankNo === tankNo);
    if (!items.length) return { ok: false, evaluation: null };
    const evaluation = D.judgeTank(items, state.config, now || new Date().toISOString());
    return { ok: evaluation.ready, evaluation };
  }

  function closeTank(tankNo, review, now) {
    now = now || new Date().toISOString();
    const check = canCloseTank(tankNo, now);
    if (!check.ok) {
      return { ok: false, error: "该槽仍有待换水项或异常，不能结批", evaluation: check.evaluation };
    }
    if (!review.reviewer || review.displacedVolume == null || review.residualSalt == null) {
      return { ok: false, error: "复核员、排水量、余盐必须填写" };
    }
    const items = state.artifacts.filter(a => a.tankNo === tankNo);
    const cycle = state.cycles[tankNo];
    const batch = {
      id: cycle ? cycle.batchId : uid(),
      batchNo: nextBatchNo(),
      tankNo,
      openedAt: cycle ? cycle.openedAt : null,
      closedAt: now,
      reviewer: review.reviewer,
      displacedVolume: Number(review.displacedVolume),
      residualSalt: Number(review.residualSalt),
      note: review.note || "",
      config: Object.assign({}, state.config),
      artifacts: clone(items),
      state: "closed",
      voidedAt: null,
      voidReason: "",
      supersededBy: null
    };
    state.batches.push(batch);
    state.artifacts = state.artifacts.filter(a => a.tankNo !== tankNo);
    delete state.cycles[tankNo];
    persist();
    return { ok: true, batch };
  }

  function nextBatchNo() {
    const n = state.batches.length + 1;
    return "P-" + String(n).padStart(3, "0");
  }

  function archivedBatches() {
    return state.batches.slice().sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt));
  }

  function getBatch(id) {
    return state.batches.find(b => b.id === id) || null;
  }

  // ---------- 历史读数更正：旧批次作废，回槽按新数据重判 ----------
  function correctArchivedReading(batchId, artifactId, readingId, value, reason, reviewer) {
    const batch = getBatch(batchId);
    if (!batch || batch.state !== "closed") return { ok: false, error: "只能更正已结批批次的读数" };

    const cycle = openCycleFor(batch.tankNo);
    const reopened = batch.artifacts.map(snap => {
      const copy = cloneOne(snap);
      copy.batchId = cycle.batchId; // 整槽回到同一个新批次
      copy.tankNo = batch.tankNo;
      return copy;
    });
    const target = reopened.find(a => a.id === artifactId);
    if (!target) return { ok: false, error: "批次中未找到该遗物" };
    const reading = target.readings.find(r => r.id === readingId);
    if (!reading) return { ok: false, error: "未找到该历史读数" };
    reading.value = Number(value);
    reading.correctedAt = new Date().toISOString();
    reading.correctionNote = reason || "历史读数更正";
    reading.correctedBy = reviewer || "";

    // 旧记录原样留档，仅标记作废
    batch.state = "void";
    batch.voidedAt = new Date().toISOString();
    batch.voidReason = (reason || "历史读数更正") + (reviewer ? "（更正人：" + reviewer + "）" : "");
    batch.supersededBy = cycle.batchId;

    state.artifacts = state.artifacts.filter(a => a.tankNo !== batch.tankNo).concat(reopened);
    state.cycles[batch.tankNo] = cycle;
    persist();
    return { ok: true, newBatchId: cycle.batchId, tankNo: batch.tankNo };
  }

  // ---------- 导出 ----------
  function exportPayload(artifacts, now) {
    const tanks = {};
    artifacts.forEach(a => { (tanks[a.tankNo] ||= []).push(a); });
    return {
      exportedAt: new Date().toISOString(),
      config: getConfig(),
      tanks: Object.keys(tanks).sort().map(tankNo => {
        const items = tanks[tankNo];
        const evaluation = D.judgeTank(items, state.config, now || new Date().toISOString());
        return {
          tankNo,
          batchId: state.cycles[tankNo] ? state.cycles[tankNo].batchId : items[0].batchId,
          state: evaluation.state,
          tankAnomalies: evaluation.tankAnomalies,
          artifacts: items
        };
      })
    };
  }

  function exportBatchPayload(batch) {
    return { exportedAt: new Date().toISOString(), batch };
  }

  // ---------- 工具 ----------
  function clone(items) { return items.map(cloneOne); }
  function cloneOne(a) {
    return {
      id: a.id, tankNo: a.tankNo, batchId: a.batchId, code: a.code,
      material: a.material, markCode: a.markCode || "", enteredAt: a.enteredAt,
      readings: a.readings.map(r => Object.assign({}, r)),
      changes: a.changes.map(c => Object.assign({}, c))
    };
  }

  function persist() { save(state); }

  function resetForTest(next) { state = next; persist(); }

  // ---------- 演示数据 ----------
  function seed() {
    const now = Date.now();
    const iso = hoursAgo => new Date(now - hoursAgo * 3600000).toISOString();
    const reading = (value, h) => ({ id: uid(), value, at: iso(h) });
    const change = (h, note) => ({ id: uid(), at: iso(h), note });

    const t1Cycle = { batchId: uid(), tankNo: "T-01", openedAt: iso(10) };
    const t2Cycle = { batchId: uid(), tankNo: "T-02", openedAt: iso(96) };
    const t3Cycle = { batchId: uid(), tankNo: "T-03", openedAt: iso(100) };

    const a1 = {
      id: uid(), tankNo: "T-01", batchId: t1Cycle.batchId,
      code: "A-017", material: "ceramic", markCode: "A-017", enteredAt: iso(10),
      readings: [reading(156, 6)],
      changes: []
    };
    const a2 = {
      id: uid(), tankNo: "T-02", batchId: t2Cycle.batchId,
      code: "M-008", material: "metal", markCode: "M-008", enteredAt: iso(96),
      readings: [reading(122, 50)],
      changes: [change(50, "首次换水")]
    };
    const a3 = {
      id: uid(), tankNo: "T-02", batchId: t2Cycle.batchId,
      code: "W-003", material: "wood", markCode: "W-003", enteredAt: iso(96),
      readings: [reading(84, 50)],
      changes: [change(50, "首次换水")]
    };
    const a4 = {
      id: uid(), tankNo: "T-03", batchId: t3Cycle.batchId,
      code: "W-011", material: "wood", markCode: "", enteredAt: iso(100),
      readings: [reading(140, 80), reading(68, 30)],
      changes: [change(80, "第一次换水"), change(30, "第二次换水")]
    };
    const a5 = {
      id: uid(), tankNo: "T-03", batchId: t3Cycle.batchId,
      code: "W-012", material: "wood", markCode: "", enteredAt: iso(100),
      readings: [reading(132, 80), reading(61, 30)],
      changes: [change(80, "第一次换水"), change(30, "第二次换水")]
    };

    const closedArtifact = {
      id: uid(), tankNo: "T-04", batchId: null, code: "M-002",
      material: "metal", markCode: "", enteredAt: iso(260),
      readings: [reading(180, 240), reading(92, 60), reading(55, 30)],
      changes: [change(200, "第一次换水"), change(60, "第二次换水"), change(30, "末次换水")]
    };
    const closed = {
      id: uid(),
      batchNo: "P-001",
      tankNo: "T-04",
      openedAt: iso(260),
      closedAt: iso(20),
      reviewer: "复核员 林舟",
      displacedVolume: 120,
      residualSalt: 48,
      note: "连续三次换水后电导率稳定，结批入库。",
      config: Object.assign({}, D.DEFAULT_CONFIG),
      artifacts: [closedArtifact],
      state: "closed",
      voidedAt: null,
      voidReason: "",
      supersededBy: null
    };
    closedArtifact.batchId = closed.id;

    return {
      config: Object.assign({}, D.DEFAULT_CONFIG),
      cycles: { "T-01": t1Cycle, "T-02": t2Cycle, "T-03": t3Cycle },
      artifacts: [a1, a2, a3, a4, a5],
      batches: [closed]
    };
  }

  global.Store = {
    getConfig, updateConfig,
    activeArtifacts, getArtifact,
    addArtifact, updateArtifact, deleteArtifact,
    addReading, correctActiveReading, addChange,
    canCloseTank, closeTank,
    archivedBatches, getBatch,
    correctArchivedReading,
    exportPayload, exportBatchPayload,
    resetForTest
  };
})(window);
