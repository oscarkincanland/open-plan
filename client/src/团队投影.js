/**
 * Agent Teams 前端投影（计划 2026-11-04-014）。
 *
 * 纯函数、零 React：把 team_* 事件归约为顶栏 chip / 画布团队面板共用的只读视图。
 * 业务状态只来自事件；组件本地只允许 selectedMemberId / taskFilter / expandedTaskId。
 */

export const TEAM_TASK_GROUPS = Object.freeze([
  { key: "running", label: "进行中", statuses: ["claimed", "running"] },
  { key: "pending", label: "待认领", statuses: ["pending"] },
  { key: "review", label: "待验收", statuses: ["review"] },
  { key: "done", label: "已结束", statuses: ["done", "failed", "cancelled"] },
]);

const ACTIVE_MEMBER_STATUSES = new Set(["provisioning", "active", "running"]);
const MEMBER_STATUS_LABELS = Object.freeze({
  provisioning: "创建中",
  active: "执行中",
  running: "执行中",
  completed: "已完成",
  idle: "空闲",
  failed: "失败",
  cancelled: "已取消",
});
const TEAM_STATUS_LABELS = Object.freeze({
  provisioning: "组队中",
  active: "进行中",
  attention: "需关注",
  idle: "空闲",
  completed: "已结束",
  closed: "已结束",
  failed: "失败",
  unknown: "状态待同步",
});

export function teamMemberStatusLabel(status) {
  return MEMBER_STATUS_LABELS[String(status || "")] || String(status || "未知");
}

export function teamStatusLabel(status) {
  return TEAM_STATUS_LABELS[String(status || "")] || TEAM_STATUS_LABELS.unknown;
}

export function teamRoleLabel(role) {
  return {
    lead: "调度",
    scout: "资料探索",
    planner: "方案拆解",
    reviewer: "审阅",
    verifier: "独立核验",
    worker: "执行",
  }[String(role || "")] || "队友";
}

function safeSeq(event) {
  return Number(event?.seq || event?.id || 0) || 0;
}

function normalizeCounts(team) {
  const members = Array.isArray(team.members) ? team.members : [];
  const tasks = Array.isArray(team.tasks) ? team.tasks : [];
  return {
    members: members.length,
    activeMembers: members.filter((member) => ACTIVE_MEMBER_STATUSES.has(String(member.status || ""))).length,
    tasks: tasks.length,
    doneTasks: tasks.filter((task) => task.status === "done").length,
    failedTasks: tasks.filter((task) => task.status === "failed").length,
    blockedTasks: tasks.filter((task) => task.ready === false).length,
    pendingTasks: tasks.filter((task) => task.status === "pending").length,
    reviewTasks: tasks.filter((task) => task.status === "review").length,
    unreadMessages: members.reduce((sum, member) => sum + (Number(member.inboxCount) || 0), 0),
  };
}

function teamStatusOf(team) {
  if (!team) return "unknown";
  if (team.status === "closed" || team.status === "completed") return "closed";
  if (team.status === "failed") return "failed";
  if (team.status === "attention") return "attention";
  const members = team.members || [];
  const tasks = team.tasks || [];
  if (members.some((member) => member.status === "failed") || tasks.some((task) => task.status === "failed")) return "attention";
  if (members.some((member) => ACTIVE_MEMBER_STATUSES.has(String(member.status || "")))) return "active";
  if (tasks.some((task) => task.status === "review")) return "attention";
  return team.status === "provisioning" ? "provisioning" : "idle";
}

function ensureLead(team) {
  const members = Array.isArray(team.members) ? [...team.members] : [];
  if (!members.some((member) => member.id === "lead")) {
    members.unshift({
      id: "lead",
      name: team.leadName || "Lead",
      role: "lead",
      roleLabel: "Lead",
      status: "active",
      activity: "负责拆解任务与汇总",
      currentTaskId: null,
      result: "",
      transcript: [],
    });
  }
  return members;
}

function finish(team, extra = {}) {
  if (!team) return null;
  const next = { ...team, ...extra };
  const members = ensureLead(next);
  const tasks = Array.isArray(next.tasks) ? next.tasks : [];
  const merged = {
    ...next,
    members,
    tasks,
    counts: normalizeCounts({ ...next, members, tasks }),
  };
  const status = teamStatusOf(merged);
  return { ...merged, status, statusLabel: teamStatusLabel(status) };
}

function normalizeMember(member) {
  if (!member || !member.id) return null;
  return {
    ...member,
    roleLabel: member.roleLabel || teamRoleLabel(member.role),
    statusLabel: teamMemberStatusLabel(member.status),
    ...(Array.isArray(member.transcript) ? { transcript: member.transcript } : {}),
  };
}

function upsertMember(members, member) {
  const normalized = normalizeMember(member);
  if (!normalized) return members;
  const index = members.findIndex((item) => item.id === normalized.id);
  if (index < 0) return [...members, normalized];
  const next = [...members];
  next[index] = { ...next[index], ...normalized };
  return next;
}

function upsertTask(tasks, task) {
  if (!task || !task.id) return tasks;
  const index = tasks.findIndex((item) => item.id === task.id);
  if (index < 0) return [...tasks, task];
  const current = tasks[index];
  // 任务 revision 只增不减；旧 revision 的迟到事件不能覆盖新状态。
  if (Number(task.revision || 0) < Number(current.revision || 0)) return tasks;
  const next = [...tasks];
  next[index] = { ...current, ...task };
  return next;
}

/**
 * 归约一个 team_* 事件。非 team 事件原样返回；未知 team 事件保持现状。
 * @param {object|null} team
 * @param {{type?:string,data?:object,seq?:number,id?:number}} event
 */
export function reduceTeamEvent(team, event) {
  const type = String(event?.type || "");
  if (!type.startsWith("team_")) return team;
  const data = event?.data && typeof event.data === "object" ? event.data : (event || {});
  if (type === "team_started") {
    return finish({
      id: data.teamId || data.id || team?.id || "team",
      teamId: data.teamId || data.id || team?.teamId || "team",
      runId: data.runId || team?.runId || null,
      mode: data.mode || team?.mode || "agent",
      status: data.status || "active",
      leadId: data.leadId || "lead",
      leadName: data.leadName || "Lead",
      maxMembers: Number(data.maxMembers || team?.maxMembers || 3),
      maxTasks: Number(data.maxTasks || team?.maxTasks || 20),
      members: Array.isArray(data.members) && data.members.length ? data.members : (team?.members || []),
      tasks: Array.isArray(data.tasks) ? data.tasks : (team?.tasks || []),
      startedAt: data.at || team?.startedAt || null,
      updatedAt: data.at || team?.updatedAt || null,
      lastSeq: Math.max(safeSeq(event), Number(team?.lastSeq || 0)),
    });
  }
  if (!team) return team;
  if (type === "team_member_spawned") {
    return finish(team, {
      members: upsertMember(team.members, data.member),
      updatedAt: data.at || team.updatedAt,
      lastSeq: Math.max(Number(team.lastSeq || 0), safeSeq(event)),
    });
  }
  if (type === "team_member_status") {
    const members = (team.members || []).map((member) => (
      member.id === data.memberId
        ? {
          ...member,
          status: data.status || member.status,
          activity: data.activity || member.activity,
          currentTaskId: data.currentTaskId ?? member.currentTaskId,
          error: data.error ?? member.error,
        }
        : member
    ));
    return finish(team, {
      members,
      updatedAt: data.at || team.updatedAt,
      lastSeq: Math.max(Number(team.lastSeq || 0), safeSeq(event)),
    });
  }
  if (type === "team_member_result") {
    const members = (team.members || []).map((member) => (
      member.id === data.memberId
        ? {
          ...member,
          status: data.status || member.status,
          result: String(data.output || member.result || ""),
          transcript: Array.isArray(data.transcript) ? data.transcript : (member.transcript || []),
          error: data.error || (data.isError ? member.error : ""),
          transcriptAvailable: true,
        }
        : member
    ));
    return finish(team, {
      members,
      updatedAt: data.at || team.updatedAt,
      lastSeq: Math.max(Number(team.lastSeq || 0), safeSeq(event)),
    });
  }
  if (type === "team_task_updated") {
    return finish(team, {
      tasks: upsertTask(team.tasks || [], data.task),
      updatedAt: data.at || team.updatedAt,
      lastSeq: Math.max(Number(team.lastSeq || 0), safeSeq(event)),
    });
  }
  if (type === "team_message_queued" || type === "team_message_delivered") {
    const members = (team.members || []).map((member) => (
      member.id === data.to
        ? {
          ...member,
          activity: type === "team_message_queued"
            ? (member.status === "active" ? "收到新消息（排队）" : "收到新消息")
            : "已接收新消息",
        }
        : member
    ));
    return finish(team, {
      members,
      updatedAt: data.at || team.updatedAt,
      lastSeq: Math.max(Number(team.lastSeq || 0), safeSeq(event)),
    });
  }
  if (type === "team_closed") {
    // team_closed 带最终快照：Lead/队友的终态、最终任务板与计数必须一起合并，
    // 否则面板会停在“Lead 执行中 / 1 个活跃”，与已结束状态矛盾。
    const snapshot = data.team && typeof data.team === "object" ? data.team : {};
    const members = (Array.isArray(snapshot.members) ? snapshot.members : [])
      .reduce((list, member) => upsertMember(list, member), team.members || []);
    const tasks = (Array.isArray(snapshot.tasks) ? snapshot.tasks : [])
      .reduce((list, task) => upsertTask(list, task), team.tasks || []);
    return finish(team, {
      ...snapshot,
      members,
      tasks,
      status: "closed",
      closeReason: data.reason || snapshot.closeReason || team.closeReason || "",
      closedAt: data.at || team.closedAt || null,
      updatedAt: data.at || team.updatedAt,
      lastSeq: Math.max(Number(team.lastSeq || 0), safeSeq(event)),
    });
  }
  return team;
}

/** 从历史事件数组重建团队；没有 team_started 时返回 null。 */
export function teamFromEvents(events = []) {
  let team = null;
  for (const event of Array.isArray(events) ? events : []) {
    team = reduceTeamEvent(team, event);
  }
  return team;
}

/** 面板渲染用的任务分组；空分组过滤。 */
export function groupTeamTasks(tasks = []) {
  const list = Array.isArray(tasks) ? tasks : [];
  return TEAM_TASK_GROUPS.map((group) => ({
    ...group,
    tasks: list.filter((task) => group.statuses.includes(String(task.status || ""))),
  })).filter((group) => group.tasks.length > 0);
}

export function teamHeaderLabel(team) {
  if (!team) return "";
  const counts = team.counts || normalizeCounts(team);
  return `团队 ${counts.activeMembers}/${counts.members}`;
}

export function teamHeaderTitle(team) {
  if (!team) return "";
  const counts = team.counts || normalizeCounts(team);
  const parts = [`团队 ${counts.activeMembers}/${counts.members}`, teamStatusLabel(team.status)];
  if (counts.blockedTasks) parts.push(`${counts.blockedTasks} 个任务受阻`);
  if (counts.reviewTasks) parts.push(`${counts.reviewTasks} 个任务待验收`);
  return parts.join("，");
}
