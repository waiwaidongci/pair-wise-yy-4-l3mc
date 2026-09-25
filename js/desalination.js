/*
 * desalination.js —— 脱盐判定（纯业务规则，不碰 localStorage / DOM）
 *
 * 留在“待换水”的三条判据（任一不满足即未达标）：
 *   1. 最近电导率未降到阈值（threshold μS/cm）
 *   2. 距入槽（或最近一次换水）的时间不足最小换水间隔（minHours）
 *   3. 同槽混放材质冲突（材质分组不同）
 * 异常判据：
 *   - 材质冲突（致命，不允许结批）
 *   - 最近换水后超过 maxHours 仍未换水（超期）
 *   - 最近电导率较上一次上升（盐分回升）
 */
(function (global) {
  "use strict";

  const MATERIALS = {
    ceramic: { name: "陶瓷", group: "ceramic" },
    wood: { name: "木质", group: "wood" },
    metal: { name: "金属", group: "metal" },
    unknown: { name: "未知", group: "unknown" }
  };

  const DEFAULT_CONFIG = { threshold: 100, minHours: 24, maxHours: 72 };

  function materialName(code) {
    return (MATERIALS[code] || MATERIALS.unknown).name;
  }

  function hoursBetween(from, to) {
    return (new Date(to).getTime() - new Date(from).getTime()) / 3600000;
  }

  function latestOf(list, field) {
    if (!list || !list.length) return null;
    return list.slice().sort((a, b) => new Date(b[field]) - new Date(a[field]))[0];
  }

  function latestReading(artifact) {
    return latestOf(artifact.readings, "at");
  }

  function latestChange(artifact) {
    return latestOf(artifact.changes, "at");
  }

  // 同槽材质冲突：槽内出现两种及以上材质分组
  function materialConflict(artifacts) {
    const groups = new Set(artifacts.map(a => MATERIALS[a.material] ? MATERIALS[a.material].group : "unknown"));
    return groups.size > 1;
  }

  // 判定单件遗物：返回 { ok, reasons:[{code,text}], anomalies:[{code,text}] }
  function judgeArtifact(artifact, config, now) {
    const reasons = [];
    const anomalies = [];
    now = now || new Date().toISOString();

    const reading = latestReading(artifact);
    const change = latestChange(artifact);
    const anchor = change ? change.at : artifact.enteredAt;

    if (!reading) {
      reasons.push({ code: "no_reading", text: "尚无电导率读数" });
    } else {
      if (reading.value > config.threshold) {
        reasons.push({
          code: "high_conductivity",
          text: "最近电导率 " + reading.value + " μS/cm 高于阈值 " + config.threshold + " μS/cm"
        });
      }
      // 回升：存在更早读数，且最近值更高
      const older = artifact.readings
        .filter(r => r.at !== reading.at)
        .sort((a, b) => new Date(b.at) - new Date(a.at))[0];
      if (older && reading.value > older.value) {
        anomalies.push({
          code: "rebound",
          text: "电导率回升：" + older.value + " → " + reading.value + " μS/cm"
        });
      }
    }

    const elapsed = hoursBetween(anchor, now);
    if (elapsed < config.minHours) {
      const wait = (config.minHours - elapsed).toFixed(1);
      reasons.push({
        code: "interval_short",
        text: "距" + (change ? "最近换水" : "入槽") + "仅 " + elapsed.toFixed(1) + "h，未满 " + config.minHours + "h（还需约 " + wait + "h）"
      });
    }
    if (elapsed > config.maxHours) {
      anomalies.push({
        code: "overdue",
        text: "已 " + elapsed.toFixed(1) + "h 未换水，超过超期上限 " + config.maxHours + "h"
      });
    }

    return { ok: reasons.length === 0, reasons, anomalies };
  }

  // 判定一个在槽批次（槽内全部遗物 + 配置）
  // 返回 { state: 'ready'|'pending'|'anomaly', ready, conflict, artifacts:[{artifact, verdict}], tankReasons, tankAnomalies }
  function judgeTank(artifacts, config, now) {
    now = now || new Date().toISOString();
    const rows = artifacts.map(a => ({ artifact: a, verdict: judgeArtifact(a, config, now) }));
    const conflict = materialConflict(artifacts);

    const tankReasons = [];
    const tankAnomalies = [];
    if (conflict) {
      const list = [...new Set(artifacts.map(a => materialName(a.material)))].join(" / ");
      tankAnomalies.push({ code: "material_conflict", text: "同槽混放材质冲突：" + list });
    }

    const anyNotReady = rows.some(r => !r.verdict.ok);
    const hasAnomaly = conflict || rows.some(r => r.verdict.anomalies.length > 0);

    let state;
    if (hasAnomaly) state = "anomaly";
    else if (anyNotReady || !artifacts.length) state = "pending";
    else state = "ready";

    return {
      state,
      ready: state === "ready",
      conflict,
      hasAnomaly,
      artifacts: rows,
      tankReasons,
      tankAnomalies
    };
  }

  global.Desal = {
    MATERIALS,
    DEFAULT_CONFIG,
    materialName,
    hoursBetween,
    latestReading,
    latestChange,
    materialConflict,
    judgeArtifact,
    judgeTank
  };
})(window);
