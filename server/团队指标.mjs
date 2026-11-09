/**
 * 团队运行指标（2026-11-09，计划 2026-11-09-001 §5.6）
 *
 * 轻量计数：建议 / 创建 / 触发来源 / 阻断 / 空团队。持久化到 `.oaw/team-metrics.json`
 * （运行时 JSON，原子写，可删除重建；不引入数据库）。
 */
import fs from "node:fs";
import path from "node:path";

const MAX_TEAM_TRACK = 200;
const metricsFile = () => String(process.env.OAW_TEAM_METRICS_FILE || "").trim() || path.join(process.cwd(), ".oaw", "team-metrics.json");

function emptyMetrics() {
  return {
    suggested: 0,
    started: 0,
    blocked: 0,
    closed: 0,
    emptyTeams: 0,
    byTrigger: { user: 0, suggested: 0, model: 0 },
    updatedAt: null,
  };
}

export function readTeamMetrics() {
  try {
    const data = JSON.parse(fs.readFileSync(metricsFile(), "utf8"));
    const base = emptyMetrics();
    return {
      ...base,
      ...data,
      byTrigger: { ...base.byTrigger, ...(data.byTrigger || {}) },
    };
  } catch {
    return emptyMetrics();
  }
}

function writeTeamMetrics(data) {
  try {
    const file = metricsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(temp, file);
  } catch {}
}

// teamId -> 任务板更新次数（仅进程内，用于判断空团队）
const teamTaskUpdates = new Map();

function mutate(fn) {
  const data = readTeamMetrics();
  fn(data);
  data.updatedAt = new Date().toISOString();
  writeTeamMetrics(data);
  return data;
}

export function recordTeamSuggested() {
  return mutate((data) => { data.suggested += 1; });
}

export function recordTeamStarted(trigger = "model") {
  const key = ["user", "suggested", "model"].includes(trigger) ? trigger : "model";
  return mutate((data) => {
    data.started += 1;
    data.byTrigger[key] = (data.byTrigger[key] || 0) + 1;
  });
}

export function recordTeamBlocked() {
  return mutate((data) => { data.blocked += 1; });
}

export function recordTeamTaskUpdate(teamId = "") {
  const key = String(teamId || "");
  if (!key) return;
  teamTaskUpdates.set(key, (teamTaskUpdates.get(key) || 0) + 1);
  while (teamTaskUpdates.size > MAX_TEAM_TRACK) teamTaskUpdates.delete(teamTaskUpdates.keys().next().value);
}

export function recordTeamClosed(teamId = "") {
  const key = String(teamId || "");
  const updates = teamTaskUpdates.get(key) || 0;
  if (key) teamTaskUpdates.delete(key);
  return mutate((data) => {
    data.closed += 1;
    if (updates === 0) data.emptyTeams += 1;
  });
}

export function teamMetricsSnapshot() {
  const data = readTeamMetrics();
  return {
    suggested: data.suggested,
    started: data.started,
    blocked: data.blocked,
    closed: data.closed,
    emptyTeams: data.emptyTeams,
    byTrigger: { ...data.byTrigger },
    updatedAt: data.updatedAt,
  };
}

export function resetTeamMetrics() {
  writeTeamMetrics(emptyMetrics());
  teamTaskUpdates.clear();
  return { ok: true };
}
