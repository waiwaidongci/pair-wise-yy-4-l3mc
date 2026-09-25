/*
 * 脱盐判定（纯业务逻辑，不碰 DOM 与 localStorage）
 * 判定规则：
 *   1. 最新电导率必须 <= 阈值；无读数视为未达标；
 *   2. 距最近一次换水（无换水记录则距入槽时刻）必须 >= 最短换水间隔，
 *      否则视为仍在浸泡中，不能结批；
 *   3. 同一槽内只能放同一种材质，未知材质与任何其它材质混放均判冲突；
 *   4. 材质冲突优先级最高（异常列），其余未达标留在待换水列。
 */
(function (global) {
  "use strict";

  var DEFAULT_THRESHOLD = 100; // μS/cm
  var DEFAULT_INTERVAL_H = 24; // 小时

  var STATE = {
    READY: "ready",       // 达标，可结批
    HIGH: "high",         // 最新电导率超标
    SOAKING: "soaking",   // 换水间隔不足
    NODATA: "nodata",     // 无读数 / 无入槽时刻
    CONFLICT: "conflict"  // 同槽材质冲突
  };

  var STATE_NAMES = {
    ready: "达标待结批",
    high: "电导率超标",
    soaking: "换水间隔不足",
    nodata: "尚无读数",
    conflict: "材质冲突"
  };

  var TYPE_NAMES = { ceramic: "陶片", wood: "木构件", metal: "金属件", unknown: "未知物" };

  function typeName(type) { return TYPE_NAMES[type] || type || "未填材质"; }

  // 最近电导率读数（读数以追加方式登记，取时间最新一条）
  function latestReading(mark) {
    if (!mark || !Array.isArray(mark.readings) || !mark.readings.length) return null;
    return mark.readings.slice().sort(function (a, b) {
      return new Date(b.at) - new Date(a.at);
    })[0];
  }

  // 最近换水记录
  function latestWaterChange(mark) {
    if (!mark || !Array.isArray(mark.waterChanges) || !mark.waterChanges.length) return null;
    return mark.waterChanges.slice().sort(function (a, b) {
      return new Date(b.at) - new Date(a.at);
    })[0];
  }

  // 按槽号分组（忽略空槽号、忽略大小写与首尾空格）
  function groupByTank(marks) {
    var groups = {};
    (marks || []).forEach(function (m) {
      var t = (m.tank || "").trim().toUpperCase();
      if (!t) return;
      (groups[t] = groups[t] || []).push(m);
    });
    return groups;
  }

  // 槽内材质是否冲突；返回 { conflict, materials }
  function tankConflict(marksInTank) {
    var set = {};
    (marksInTank || []).forEach(function (m) {
      var key = (m.type || "unknown").trim() || "unknown";
      set[key] = typeName(key);
    });
    var keys = Object.keys(set);
    return {
      conflict: keys.length > 1,
      materials: Object.values(set)
    };
  }

  // 电导率是否达标
  function conductivityOk(mark, threshold) {
    var r = latestReading(mark);
    if (!r) return { ok: false, reading: null };
    return { ok: Number(r.value) <= Number(threshold), reading: r };
  }

  // 换水间隔是否满足；基准时刻 = 最近换水时间，否则入槽时刻
  function intervalOk(mark, intervalHours, now) {
    var last = latestWaterChange(mark);
    var baseAt = last ? last.at : mark.enteredAt;
    if (!baseAt) return { ok: false, baseAt: null, reason: last ? "water" : "enter" };
    var elapsedH = (new Date(now) - new Date(baseAt)) / 36e5;
    return { ok: elapsedH >= Number(intervalHours), baseAt: baseAt, elapsedH: elapsedH, reason: last ? "water" : "enter" };
  }

  /*
   * 判定单件遗物（调用方先算好槽位冲突）
   * 返回 { state, reading, interval, reasons:[中文原因…] }
   */
  function judge(mark, opts) {
    opts = opts || {};
    var threshold = opts.threshold != null ? opts.threshold : DEFAULT_THRESHOLD;
    var intervalHours = opts.intervalHours != null ? opts.intervalHours : DEFAULT_INTERVAL_H;
    var now = opts.now || new Date().toISOString();
    var inConflict = !!opts.inConflict;
    var reasons = [];

    if (inConflict) reasons.push("同槽混放材质冲突");
    var cond = conductivityOk(mark, threshold);
    if (!cond.reading) {
      reasons.push("尚无电导率读数");
    } else if (!cond.ok) {
      reasons.push("最新电导率 " + cond.reading.value + " μS/cm 高于阈值 " + threshold);
    }
    var iv = intervalOk(mark, intervalHours, now);
    if (!iv.baseAt) {
      reasons.push("缺少入槽时刻，无法计算换水间隔");
    } else if (!iv.ok) {
      var left = (Number(intervalHours) - iv.elapsedH).toFixed(1);
      reasons.push((iv.reason === "water" ? "距最近换水" : "自入槽") +
        "不足 " + intervalHours + " 小时（还差约 " + left + " 小时）");
    }

    var state;
    if (inConflict) state = STATE.CONFLICT;
    else if (!cond.reading || !iv.baseAt) state = STATE.NODATA;
    else if (!cond.ok) state = STATE.HIGH;
    else if (!iv.ok) state = STATE.SOAKING;
    else state = STATE.READY;

    if (state === STATE.READY) reasons = ["电导率已降至阈值以下，换水间隔满足要求"];
    return { state: state, reading: cond.reading, interval: iv, reasons: reasons };
  }

  /*
   * 判定一批遗物；返回 [{ mark, tank, state, reasons, reading, interval }]
   * 没有槽号的遗物不参与监护台判定。
   */
  function judgeAll(marks, opts) {
    opts = opts || {};
    var groups = groupByTank(marks);
    var out = [];
    Object.keys(groups).sort().forEach(function (tank) {
      var rows = groups[tank];
      var conflict = tankConflict(rows).conflict;
      rows.forEach(function (mark) {
        var r = judge(mark, Object.assign({}, opts, { inConflict: conflict }));
        out.push({
          mark: mark,
          tank: tank,
          conflict: conflict,
          state: r.state,
          reasons: r.reasons,
          reading: r.reading,
          interval: r.interval
        });
      });
    });
    return out;
  }

  // 槽位汇总：槽内所有件都达标且无冲突才算就绪
  function tankSummary(rowsInTank) {
    if (!rowsInTank.length) return { state: STATE.NODATA, ready: false };
    var conflict = rowsInTank.some(function (r) { return r.state === STATE.CONFLICT; });
    var allReady = rowsInTank.every(function (r) { return r.state === STATE.READY; });
    var state = conflict ? STATE.CONFLICT : (allReady ? STATE.READY : STATE.HIGH);
    // 细粒度：未就绪时取最差件状态用于筛选
    var worst = STATE.READY;
    rowsInTank.forEach(function (r) {
      var rank = { ready: 0, soaking: 1, nodata: 2, high: 3, conflict: 4 };
      if ((rank[r.state] || 0) > (rank[worst] || 0)) worst = r.state;
    });
    return {
      conflict: conflict,
      ready: !conflict && allReady,
      state: conflict ? STATE.CONFLICT : (allReady ? STATE.READY : worst)
    };
  }

  global.Desal = {
    DEFAULT_THRESHOLD: DEFAULT_THRESHOLD,
    DEFAULT_INTERVAL_H: DEFAULT_INTERVAL_H,
    STATE: STATE,
    STATE_NAMES: STATE_NAMES,
    TYPE_NAMES: TYPE_NAMES,
    typeName: typeName,
    latestReading: latestReading,
    latestWaterChange: latestWaterChange,
    groupByTank: groupByTank,
    tankConflict: tankConflict,
    conductivityOk: conductivityOk,
    intervalOk: intervalOk,
    judge: judge,
    judgeAll: judgeAll,
    tankSummary: tankSummary
  };
})(window);
