/**
 * 团队编排器（Team Lite，计划 2026-11-04-014）
 *
 * 纯逻辑、无 Pi / 无 IO：
 *   - 一个 Team 绑定一个 Run；
 *   - Lead 是当前 Work/Review 会话，队友是具名、可重复唤醒的一次性执行体；
 *   - 共享任务板支持 revision CAS、依赖 DAG、owner、writeScopes 告警；
 *   - 消息走内存 inbox；队友空闲时唤醒，运行中排队，当前 turn 结束后投递；
 *   - 事件由调用方注入 emit 写入现有事件流，前端只读投影。
 *
 * 约束（由用户 2026-11-04 决定）：
 *   - Work / Review 可创建团队；Chat 只能只读查看历史团队，不能创建；
 *   - 团队总人数最多 3（Lead + 2 名队友）；任务最多 20 个；
 *   - 不嵌套团队，队友不能再创建团队。
 */

export const TEAM_MAX_MEMBERS = 3;
export const TEAM_MAX_TASKS = 20;
export const TEAM_MAX_MESSAGE_BYTES = 16 * 1024;
export const TEAM_MAX_TASK_TEXT = 16 * 1024;
export const TEAM_MIN_WAIT_MS = 10 * 1000;
export const TEAM_MAX_WAIT_MS = 60 * 60 * 1000;
export const TEAM_DEFAULT_WAIT_MS = 30 * 1000;

export const TEAM_MEMBER_ROLES = Object.freeze({
  scout: { label: "资料探索", readOnly: true },
  planner: { label: "方案拆解", readOnly: true },
  reviewer: { label: "审阅", readOnly: true },
  verifier: { label: "独立核验", readOnly: true },
  worker: { label: "执行", readOnly: false },
});

export const TEAM_TASK_STATUSES = Object.freeze([
  "pending", "claimed", "running", "review", "done", "failed", "cancelled",
]);

const TASK_STATUS_LABELS = Object.freeze({
  pending: "待认领",
  claimed: "已认领",
  running: "进行中",
  review: "待验收",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
});

const TERMINAL_TASK_STATUSES = new Set(["done", "failed", "cancelled"]);
const ACTIVE_MEMBER_STATUSES = new Set(["provisioning", "active", "running"]);

export class TeamError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "TeamError";
    this.code = code;
  }
}

function nowIso(now) {
  return new Date(now()).toISOString();
}

function text(value, max = 20000) {
  return String(value ?? "").slice(0, max);
}

function bytesOf(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8");
}

function normalizeName(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function normalizeScopes(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((item) => String(item || "").trim().replace(/\\/g, "/")).filter(Boolean))].slice(0, 40);
}

function scopeKey(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").toLowerCase();
}

function scopesOverlap(left, right) {
  const a = scopeKey(left);
  const b = scopeKey(right);
  if (!a || !b) return false;
  if (a === b) return true;
  // 目录写域（以 / 结尾）与文件写域：把目录视为前缀；纯文件按精确匹配。
  if (String(left).endsWith("/") && b.startsWith(a + "/")) return true;
  if (String(right).endsWith("/") && a.startsWith(b + "/")) return true;
  return false;
}

function roleSpec(role) {
  return TEAM_MEMBER_ROLES[role] || null;
}

/** Lead 固定 id，前端和工具都按这个 id 识别。 */
export const TEAM_LEAD_ID = "lead";

export class TeamService {
  constructor({
    teamId,
    runId = null,
    sessionId = null,
    threadId = null,
    leadName = "Lead",
    mode = "agent",
    canWrite = false,
    emit = () => {},
    runMemberTask = null,
    signal = null,
    now = Date.now,
    maxMembers = TEAM_MAX_MEMBERS,
    maxTasks = TEAM_MAX_TASKS,
  } = {}) {
    if (!teamId) throw new TeamError("TEAM_ID_REQUIRED", "团队缺少 teamId");
    if (typeof runMemberTask !== "function") throw new TeamError("TEAM_RUNNER_REQUIRED", "团队缺少队友执行器");
    this.teamId = String(teamId);
    this.runId = runId ? String(runId) : null;
    this.sessionId = sessionId ? String(sessionId) : null;
    this.threadId = threadId ? String(threadId) : null;
    this.mode = String(mode || "agent");
    this.canWrite = canWrite === true;
    this.emitFn = typeof emit === "function" ? emit : () => {};
    this.runMemberTask = runMemberTask;
    this.now = typeof now === "function" ? now : Date.now;
    this.maxMembers = Math.max(1, Math.min(10, Number(maxMembers) || TEAM_MAX_MEMBERS));
    this.maxTasks = Math.max(1, Math.min(100, Number(maxTasks) || TEAM_MAX_TASKS));
    this.startedAt = this.now();
    this.updatedAt = this.startedAt;
    this.version = 0;
    this.started = false;
    this.closed = false;
    this.closeReason = "";
    this.memberSeq = 0;
    this.taskSeq = 0;
    this.messageSeq = 0;
    this.members = new Map();
    this.tasks = new Map();
    this.messages = [];
    this.waiters = new Set();
    this.abortController = new AbortController();
    this.parentAbort = null;
    this.lead = this._createLead(leadName);
    this.members.set(this.lead.id, this.lead);
    if (signal) {
      this.parentAbort = () => this.close("run_cancelled");
      if (signal.aborted) this.close("run_cancelled");
      else signal.addEventListener("abort", this.parentAbort, { once: true });
    }
  }

  _createLead(name) {
    return {
      id: TEAM_LEAD_ID,
      name: normalizeName(name) || "Lead",
      role: "lead",
      roleLabel: "Lead",
      status: "active",
      task: "",
      activity: "负责拆解任务与汇总",
      currentTaskId: null,
      result: "",
      error: "",
      transcript: [],
      inbox: [],
      childId: null,
      subagentId: null,
      createdAt: this.startedAt,
      finishedAt: null,
      lastSeq: 0,
    };
  }

  _emit(type, data = {}) {
    this.updatedAt = this.now();
    this.version += 1;
    try {
      this.emitFn(type, {
        teamId: this.teamId,
        runId: this.runId,
        threadId: this.threadId,
        sessionId: this.sessionId,
        at: nowIso(this.now),
        ...data,
      });
    } catch {
      // 事件写入失败不阻断团队执行；调用方的事件层会自行记录错误。
    }
    this._notify();
  }

  _notify() {
    if (!this.waiters.size) return;
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const waiter of waiters) {
      try {
        clearTimeout(waiter.timer);
        waiter.resolve({ changed: true, timedOut: false, closed: this.closed, team: this.snapshot({ includeTranscript: false }) });
      } catch {}
    }
  }

  start() {
    if (this.started) return this.snapshot();
    this.started = true;
    this._emit("team_started", {
      teamId: this.teamId,
      leadId: this.lead.id,
      leadName: this.lead.name,
      mode: this.mode,
      canWrite: this.canWrite,
      maxMembers: this.maxMembers,
      maxTasks: this.maxTasks,
      members: [this._publicMember(this.lead, { includeTranscript: false })],
      counts: this._counts(),
    });
    return this.snapshot({ includeTranscript: false });
  }

  _publicMember(member, { includeTranscript = true } = {}) {
    if (!member) return null;
    return {
      id: member.id,
      name: member.name,
      role: member.role,
      roleLabel: member.roleLabel,
      status: member.status,
      task: member.task,
      activity: member.activity,
      currentTaskId: member.currentTaskId,
      result: text(member.result, 20000),
      error: text(member.error, 2000),
      transcript: includeTranscript
        ? (Array.isArray(member.transcript) ? member.transcript.slice(0, 240) : [])
        : undefined,
      subagentId: member.subagentId,
      transcriptAvailable: Boolean(member.transcript?.length),
      inboxCount: member.inbox.length,
      createdAt: member.createdAt,
      finishedAt: member.finishedAt,
      lastSeq: member.lastSeq || 0,
    };
  }

  _counts() {
    const members = [...this.members.values()];
    const tasks = [...this.tasks.values()];
    return {
      members: members.length,
      activeMembers: members.filter((member) => ACTIVE_MEMBER_STATUSES.has(member.status)).length,
      tasks: tasks.length,
      doneTasks: tasks.filter((task) => task.status === "done").length,
      failedTasks: tasks.filter((task) => task.status === "failed").length,
      blockedTasks: tasks.filter((task) => this._taskBlocked(task)).length,
      pendingTasks: tasks.filter((task) => task.status === "pending").length,
      reviewTasks: tasks.filter((task) => task.status === "review").length,
      unreadMessages: members.reduce((sum, member) => sum + member.inbox.length, 0),
    };
  }

  _teamStatus() {
    if (this.closed) return "closed";
    const teammates = [...this.members.values()].filter((member) => member.id !== TEAM_LEAD_ID);
    if (teammates.some((member) => member.status === "failed")) return "attention";
    if (teammates.some((member) => ACTIVE_MEMBER_STATUSES.has(member.status))) return "active";
    const tasks = [...this.tasks.values()];
    if (tasks.some((task) => task.status === "failed")) return "attention";
    if (tasks.some((task) => task.status === "review")) return "attention";
    return "idle";
  }

  snapshot({ includeTranscript = true } = {}) {
    const members = [...this.members.values()].map((member) => this._publicMember(member, { includeTranscript }));
    const tasks = [...this.tasks.values()].map((task) => this._publicTask(task));
    return {
      id: this.teamId,
      teamId: this.teamId,
      runId: this.runId,
      sessionId: this.sessionId,
      threadId: this.threadId,
      mode: this.mode,
      status: this._teamStatus(),
      leadId: this.lead.id,
      leadName: this.lead.name,
      maxMembers: this.maxMembers,
      maxTasks: this.maxTasks,
      members,
      tasks,
      counts: this._counts(),
      startedAt: new Date(this.startedAt).toISOString(),
      updatedAt: new Date(this.updatedAt).toISOString(),
      closedAt: this.closed ? new Date(this.updatedAt).toISOString() : null,
      closeReason: this.closeReason || "",
      version: this.version,
    };
  }

  _assertOpen() {
    if (this.closed) throw new TeamError("TEAM_CLOSED", "团队已结束，不能再执行该操作");
  }

  _resolveMember(target) {
    const value = String(target || "").trim();
    if (!value) throw new TeamError("TEAM_MEMBER_REQUIRED", "需要指定队友");
    if (value === TEAM_LEAD_ID || value.toLowerCase() === String(this.lead.name).toLowerCase()) return this.lead;
    const byId = this.members.get(value);
    if (byId) return byId;
    const lower = value.toLowerCase();
    const byName = [...this.members.values()].find((member) => member.name.toLowerCase() === lower);
    if (byName) return byName;
    throw new TeamError("TEAM_MEMBER_NOT_FOUND", `找不到队友：${value}`);
  }

  _resolveRole(requested) {
    const raw = String(requested || "scout").toLowerCase();
    let role = roleSpec(raw) ? raw : "scout";
    // Review / Chat 只读：worker 降级为 scout，避免团队工具绕过模式边界。
    if (role === "worker" && !this.canWrite) role = "scout";
    return role;
  }

  _assertName(name, exceptId = "") {
    const normalized = normalizeName(name);
    if (!normalized) throw new TeamError("TEAM_NAME_REQUIRED", "队友名字不能为空");
    if (normalized.length > 64) throw new TeamError("TEAM_NAME_TOO_LONG", "队友名字不能超过 64 个字符");
    const lower = normalized.toLowerCase();
    const duplicate = [...this.members.values()].some((member) => member.id !== exceptId && member.name.toLowerCase() === lower);
    if (duplicate) throw new TeamError("TEAM_NAME_DUPLICATE", `队友名字已存在：${normalized}`);
    return normalized;
  }

  spawn({ name, role = "scout", task = "" } = {}) {
    this._assertOpen();
    if (this.members.size >= this.maxMembers) {
      throw new TeamError("TEAM_FULL", `团队人数已达上限（${this.maxMembers} 人，含 Lead）`);
    }
    const memberName = this._assertName(name);
    const taskText = String(task || "").trim();
    if (!taskText) throw new TeamError("TEAM_TASK_REQUIRED", "创建队友时必须给出首个任务");
    if (taskText.length > 4000) throw new TeamError("TEAM_TASK_TOO_LONG", "队友任务不能超过 4000 个字符");
    const effectiveRole = this._resolveRole(role);
    const spec = roleSpec(effectiveRole);
    const index = ++this.memberSeq;
    const member = {
      id: `member-${index}`,
      name: memberName,
      role: effectiveRole,
      roleLabel: spec.label,
      status: "provisioning",
      task: taskText,
      activity: "正在创建隔离会话",
      currentTaskId: null,
      result: "",
      error: "",
      transcript: [],
      inbox: [],
      childId: `team_member_${index}_${Math.random().toString(36).slice(2, 8)}`,
      subagentId: null,
      createdAt: this.now(),
      finishedAt: null,
      lastSeq: 0,
    };
    this.members.set(member.id, member);
    this._emit("team_member_spawned", {
      member: this._publicMember(member, { includeTranscript: false }),
      requestedRole: String(role || "scout"),
      role: effectiveRole,
      readOnly: spec.readOnly,
    });
    // 延后一个微任务启动：让 team_spawn 的同步返回值仍是 provisioning，
    // 前端先看到“创建中”，随后再由 team_member_status 推进到执行中。
    queueMicrotask(() => { void this._execute(member, taskText, { initial: true }); });
    return {
      member: this._publicMember(member, { includeTranscript: false }),
      team: this.snapshot({ includeTranscript: false }),
      note: `已创建队友 ${member.name}（${member.roleLabel}），它会在独立上下文中执行；用 team_wait 等待进展。`,
    };
  }

  _continuationPrompt(member, message) {
    return [
      `你是团队队友「${member.name}」。以下是新的消息/补充要求：`,
      String(message || "").slice(0, TEAM_MAX_MESSAGE_BYTES),
      "",
      "请结合你上一轮的结果继续处理；如果任务已完成，直接给出新的补充结论。",
    ].join("\n");
  }

  async _execute(member, prompt, { initial = false, messageId = null } = {}) {
    if (this.closed || member.status === "cancelled") return;
    member.status = "active";
    member.activity = initial ? "开始执行任务" : "处理新消息";
    member.error = "";
    this._emit("team_member_status", {
      memberId: member.id,
      status: member.status,
      activity: member.activity,
      currentTaskId: member.currentTaskId || null,
      initial,
    });
    let outcome = null;
    try {
      outcome = await this.runMemberTask({
        ...member,
        teamId: this.teamId,
      }, prompt, {
        initial,
        messageId,
        signal: this.abortController.signal,
        onActivity: (activity) => {
          if (this.closed) return;
          member.activity = text(activity, 300) || member.activity;
          this._emit("team_member_status", {
            memberId: member.id,
            status: member.status,
            activity: member.activity,
            currentTaskId: member.currentTaskId || null,
          });
        },
      });
    } catch (error) {
      if (this.closed) return;
      const message = text(error?.message || error, 1200);
      member.status = "failed";
      member.error = message;
      member.activity = "执行失败";
      member.finishedAt = this.now();
      this._emit("team_member_result", {
        memberId: member.id,
        status: "failed",
        output: "",
        transcript: member.transcript || [],
        isError: true,
        error: message,
      });
      this._emit("team_member_status", {
        memberId: member.id,
        status: member.status,
        activity: member.activity,
        error: message,
      });
      return;
    }
    if (this.closed) return;
    const output = text(outcome?.text || "", 20000);
    const isError = outcome?.isError === true;
    member.subagentId = outcome?.childId || member.childId;
    member.result = output;
    member.transcript = Array.isArray(outcome?.transcript) ? outcome.transcript.slice(0, 240) : (member.transcript || []);
    member.status = isError ? "failed" : "completed";
    member.error = isError ? text(output, 1200) : "";
    member.activity = isError ? "执行失败" : "任务已完成";
    member.finishedAt = this.now();
    // 队友完成后把结果回填到它当前认领的任务：其他队友（尤其是 reviewer）
    // 通过 team_task get/list 就能看到交接内容，不必依赖成员私有会话。
    if (!isError) {
      const owned = member.currentTaskId
        ? this.tasks.get(member.currentTaskId)
        : [...this.tasks.values()].find((task) => task.ownerId === member.id && !task.result && !TERMINAL_TASK_STATUSES.has(task.status));
      if (owned && !owned.result && owned.status !== "cancelled") {
        owned.result = text(output, 4000);
        owned.revision += 1;
        owned.updatedAt = this.now();
        owned.updatedBy = member.id;
        this._emit("team_task_updated", {
          task: this._publicTask(owned),
          action: "result",
          actorId: member.id,
          counts: this._counts(),
        });
      }
    }
    this._emit("team_member_result", {
      memberId: member.id,
      status: member.status,
      output: output.slice(0, 16000),
      transcript: member.transcript,
      isError,
      error: isError ? text(output, 1200) : "",
    });
    this._emit("team_member_status", {
      memberId: member.id,
      status: member.status,
      activity: member.activity,
      error: member.error || undefined,
      currentTaskId: member.currentTaskId || null,
    });
    await this._drainInbox(member);
  }

  async _drainInbox(member) {
    if (this.closed || !member.inbox.length) return;
    const next = member.inbox.shift();
    this._emit("team_message_delivered", {
      messageId: next.id,
      to: member.id,
      toName: member.name,
      from: next.from,
      preview: text(next.text, 500),
    });
    await this._execute(member, this._continuationPrompt(member, next.text), {
      initial: false,
      messageId: next.id,
    });
  }

  send({ target, message, from = TEAM_LEAD_ID } = {}) {
    this._assertOpen();
    const member = this._resolveMember(target);
    if (member.id === TEAM_LEAD_ID) throw new TeamError("TEAM_SEND_LEAD", "队友结果会通过结果事件返回；不向 Lead 发送团队消息");
    if (member.id === from) throw new TeamError("TEAM_SEND_SELF", "不能给自己发消息");
    const body = String(message || "").trim();
    if (!body) throw new TeamError("TEAM_MESSAGE_REQUIRED", "消息不能为空");
    if (bytesOf(body) > TEAM_MAX_MESSAGE_BYTES) {
      throw new TeamError("TEAM_MESSAGE_TOO_LARGE", `消息超过 ${TEAM_MAX_MESSAGE_BYTES} 字节上限`);
    }
    const record = {
      id: `message-${++this.messageSeq}`,
      from: String(from || TEAM_LEAD_ID),
      to: member.id,
      text: body,
      createdAt: this.now(),
    };
    this.messages.push(record);
    if (this.messages.length > 200) this.messages.splice(0, this.messages.length - 200);
    member.inbox.push(record);
    member.activity = member.status === "active" ? "收到新消息（排队）" : "收到新消息";
    this._emit("team_message_queued", {
      messageId: record.id,
      from: record.from,
      to: member.id,
      toName: member.name,
      bytes: bytesOf(body),
      preview: text(body, 500),
      status: member.status,
    });
    if (!ACTIVE_MEMBER_STATUSES.has(member.status)) {
      void this._execute(member, this._continuationPrompt(member, body), {
        initial: false,
        messageId: record.id,
      });
      return {
        message: record,
        queued: false,
        note: `已唤醒 ${member.name} 并投递消息。`,
      };
    }
    return {
      message: record,
      queued: true,
      note: `${member.name} 正在执行，消息已排队，本轮结束后投递。`,
    };
  }

  waitForChange({ timeoutMs = TEAM_DEFAULT_WAIT_MS } = {}) {
    const requested = Number(timeoutMs);
    const timeout = Math.max(TEAM_MIN_WAIT_MS, Math.min(TEAM_MAX_WAIT_MS, Number.isFinite(requested) ? requested : TEAM_DEFAULT_WAIT_MS));
    if (this.closed) {
      return Promise.resolve({ changed: false, timedOut: false, noProgress: true, closed: true, team: this.snapshot({ includeTranscript: false }) });
    }
    const active = [...this.members.values()]
      .some((member) => member.id !== TEAM_LEAD_ID && ACTIVE_MEMBER_STATUSES.has(member.status));
    if (!active) {
      return Promise.resolve({ changed: false, timedOut: false, noProgress: true, team: this.snapshot({ includeTranscript: false }) });
    }
    return new Promise((resolve) => {
      const waiter = { resolve, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        resolve({ changed: false, timedOut: true, noProgress: false, team: this.snapshot({ includeTranscript: false }) });
      }, timeout);
      this.waiters.add(waiter);
    });
  }

  _taskBlocked(task) {
    if (!task || !Array.isArray(task.blockedBy) || !task.blockedBy.length) return false;
    return task.blockedBy.some((dependencyId) => {
      const dependency = this.tasks.get(dependencyId);
      return !dependency || dependency.status !== "done";
    });
  }

  _publicTask(task) {
    const conflicts = [];
    for (const other of this.tasks.values()) {
      if (other.id === task.id) continue;
      if (TERMINAL_TASK_STATUSES.has(other.status)) continue;
      if (!task.writeScopes?.length || !other.writeScopes?.length) continue;
      if (task.writeScopes.some((left) => other.writeScopes.some((right) => scopesOverlap(left, right)))) {
        conflicts.push(other.id);
      }
    }
    return {
      id: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      statusLabel: TASK_STATUS_LABELS[task.status] || task.status,
      ownerId: task.ownerId || null,
      ownerName: task.ownerId ? (this.members.get(task.ownerId)?.name || task.ownerId) : "",
      blockedBy: [...task.blockedBy],
      ready: !this._taskBlocked(task),
      result: String(task.result || "").slice(0, 4000),
      writeScopes: [...task.writeScopes],
      writeConflicts: conflicts,
      revision: task.revision,
      createdAt: new Date(task.createdAt).toISOString(),
      updatedAt: new Date(task.updatedAt).toISOString(),
      updatedBy: task.updatedBy || null,
    };
  }

  _assertExpectedRevision(task, expectedRevision) {
    if (expectedRevision === undefined || expectedRevision === null || expectedRevision === "") {
      throw new TeamError("TEAM_REVISION_REQUIRED", `更新任务需要 expectedRevision（当前 revision=${task.revision}）`);
    }
    if (Number(expectedRevision) !== Number(task.revision)) {
      throw new TeamError("STALE_REVISION", `任务已被修改：期望 revision=${expectedRevision}，当前 revision=${task.revision}`);
    }
  }

  _actor(actorId) {
    const actor = this.members.get(String(actorId || ""));
    if (!actor) throw new TeamError("TEAM_ACTOR_NOT_FOUND", "任务操作者不在团队中");
    return actor;
  }

  _validateDependencies(blockedBy, selfId = null) {
    const ids = Array.isArray(blockedBy) ? [...new Set(blockedBy.map((item) => String(item || "").trim()).filter(Boolean))] : [];
    if (ids.length > 20) throw new TeamError("TEAM_TOO_MANY_DEPENDENCIES", "任务依赖不能超过 20 个");
    for (const id of ids) {
      if (selfId && id === selfId) throw new TeamError("TEAM_DEPENDENCY_SELF", "任务不能依赖自己");
      if (!this.tasks.has(id)) throw new TeamError("TEAM_DEPENDENCY_MISSING", `依赖任务不存在：${id}`);
    }
    // 环检测：从每个依赖向上回溯，若回到 selfId 则成环。
    if (selfId) {
      const stack = [...ids];
      const seen = new Set();
      while (stack.length) {
        const current = stack.pop();
        if (current === selfId) throw new TeamError("TEAM_DEPENDENCY_CYCLE", "任务依赖不能成环");
        if (seen.has(current)) continue;
        seen.add(current);
        const task = this.tasks.get(current);
        for (const next of task?.blockedBy || []) stack.push(next);
      }
    }
    return ids;
  }

  task({ action, taskId = "", expectedRevision = null, title = "", description = undefined, status = "", owner = "", blockedBy, writeScopes = [], result = undefined } = {}, { actorId = TEAM_LEAD_ID } = {}) {
    this._assertOpen();
    const actor = this._actor(actorId);
    const op = String(action || "").toLowerCase();
    if (op === "list") {
      return {
        tasks: [...this.tasks.values()].map((task) => this._publicTask(task)),
        counts: this._counts(),
        team: this.snapshot({ includeTranscript: false }),
      };
    }
    if (op === "get") {
      const task = this.tasks.get(String(taskId || ""));
      if (!task) throw new TeamError("TEAM_TASK_NOT_FOUND", `任务不存在：${taskId}`);
      return { task: this._publicTask(task), team: this.snapshot({ includeTranscript: false }) };
    }
    if (op === "create") {
      if (actor.id !== TEAM_LEAD_ID) throw new TeamError("TEAM_LEAD_ONLY", "只有 Lead 可以创建任务");
      if (this.tasks.size >= this.maxTasks) throw new TeamError("TEAM_TASK_LIMIT", `任务已达上限（${this.maxTasks} 个）`);
      const taskTitle = String(title || "").trim();
      if (!taskTitle) throw new TeamError("TEAM_TASK_TITLE_REQUIRED", "任务标题不能为空");
      if (taskTitle.length > 200) throw new TeamError("TEAM_TASK_TITLE_TOO_LONG", "任务标题不能超过 200 个字符");
      if (String(description || "").length > TEAM_MAX_TASK_TEXT) throw new TeamError("TEAM_TASK_DESCRIPTION_TOO_LONG", "任务描述不能超过 16KB");
      const dependencies = this._validateDependencies(Array.isArray(blockedBy) ? blockedBy : []);
      let ownerMember = null;
      if (owner) {
        ownerMember = this._resolveMember(owner);
        if (ownerMember.id === TEAM_LEAD_ID) throw new TeamError("TEAM_TASK_OWNER_INVALID", "任务 owner 需要是队友，不能是 Lead");
      }
      const task = {
        id: `task-${++this.taskSeq}`,
        title: taskTitle,
        description: text(description, TEAM_MAX_TASK_TEXT),
        status: "pending",
        ownerId: ownerMember?.id || null,
        blockedBy: dependencies,
        writeScopes: normalizeScopes(writeScopes),
        result: result !== undefined ? text(result, 4000) : "",
        revision: 1,
        createdAt: this.now(),
        updatedAt: this.now(),
        updatedBy: actor.id,
      };
      this.tasks.set(task.id, task);
      this._emit("team_task_updated", {
        task: this._publicTask(task),
        action: "create",
        actorId: actor.id,
        counts: this._counts(),
      });
      return { task: this._publicTask(task), team: this.snapshot({ includeTranscript: false }) };
    }
    const task = this.tasks.get(String(taskId || ""));
    if (!task) throw new TeamError("TEAM_TASK_NOT_FOUND", `任务不存在：${taskId}`);
    if (op === "claim") {
      this._assertExpectedRevision(task, expectedRevision);
      if (task.status !== "pending") throw new TeamError("TEAM_TASK_NOT_CLAIMABLE", `任务当前是 ${TASK_STATUS_LABELS[task.status] || task.status}，不能认领`);
      if (this._taskBlocked(task)) throw new TeamError("TEAM_TASK_BLOCKED", "任务依赖尚未完成，不能认领");
      if (actor.id === TEAM_LEAD_ID) throw new TeamError("TEAM_TASK_CLAIM_LEAD", "Lead 不需要认领任务；请指派给队友");
      task.status = "claimed";
      task.ownerId = actor.id;
      task.revision += 1;
      task.updatedAt = this.now();
      task.updatedBy = actor.id;
      actor.currentTaskId = task.id;
      actor.activity = `已认领 ${task.title}`.slice(0, 300);
      if (actor.id !== TEAM_LEAD_ID) {
        this._emit("team_member_status", {
          memberId: actor.id,
          status: actor.status,
          activity: actor.activity,
          currentTaskId: actor.currentTaskId,
        });
      }
      this._emit("team_task_updated", {
        task: this._publicTask(task),
        action: "claim",
        actorId: actor.id,
        counts: this._counts(),
      });
      return { task: this._publicTask(task), team: this.snapshot({ includeTranscript: false }) };
    }
    if (op === "update") {
      if (actor.id !== TEAM_LEAD_ID && task.ownerId !== actor.id) throw new TeamError("TEAM_TASK_NOT_OWNER", "只有 Lead 或任务 owner 可以更新任务");
      this._assertExpectedRevision(task, expectedRevision);
      if (task.status === "done" || task.status === "cancelled") throw new TeamError("TEAM_TASK_TERMINAL", "已完成/已取消的任务不能再更新");
      const nextStatus = String(status || "").toLowerCase();
      const hasStatus = Boolean(nextStatus);
      const hasDependencies = blockedBy !== undefined && blockedBy !== null;
      const hasDescription = description !== undefined && description !== null;
      const hasResult = result !== undefined && result !== null;
      if (!hasStatus && !hasDependencies && !hasDescription && !hasResult) {
        throw new TeamError("TEAM_TASK_UPDATE_REQUIRED", "update 至少需要 status / blockedBy / description / result");
      }
      if (hasDescription && String(description).length > TEAM_MAX_TASK_TEXT) {
        throw new TeamError("TEAM_TASK_DESCRIPTION_TOO_LONG", "任务描述不能超过 16KB");
      }
      if (hasResult && String(result).length > 4000) {
        throw new TeamError("TEAM_TASK_RESULT_TOO_LONG", "任务结果摘要不能超过 4000 个字符");
      }
      if (hasStatus) {
        if (!TEAM_TASK_STATUSES.includes(nextStatus)) throw new TeamError("TEAM_TASK_STATUS_INVALID", `任务状态无效：${status}`);
        if (nextStatus === "pending") throw new TeamError("TEAM_TASK_STATUS_INVALID", "不能把任务改回待认领");
        if (nextStatus === "claimed") throw new TeamError("TEAM_TASK_STATUS_INVALID", "claim 请使用 action=claim");
        if (task.status === "pending" && nextStatus !== "cancelled" && nextStatus !== "failed") {
          throw new TeamError("TEAM_TASK_NOT_CLAIMED", "任务尚未认领，不能直接推进；请先 action=claim");
        }
      }
      if (hasDependencies) {
        task.blockedBy = this._validateDependencies(blockedBy, task.id);
      }
      if (hasStatus && nextStatus === "done" && this._taskBlocked(task)) {
        throw new TeamError("TEAM_TASK_BLOCKED", "依赖未完成，不能标记完成");
      }
      if (hasDescription) task.description = text(description, TEAM_MAX_TASK_TEXT);
      if (hasResult) task.result = text(result, 4000);
      if (hasStatus) task.status = nextStatus;
      if (hasStatus && nextStatus === "done" && !task.ownerId) task.ownerId = actor.id;
      task.revision += 1;
      task.updatedAt = this.now();
      task.updatedBy = actor.id;
      this._emit("team_task_updated", {
        task: this._publicTask(task),
        action: "update",
        actorId: actor.id,
        counts: this._counts(),
      });
      return { task: this._publicTask(task), team: this.snapshot({ includeTranscript: false }) };
    }
    throw new TeamError("TEAM_ACTION_INVALID", `不支持的任务操作：${action}`);
  }

  close(reason = "run_finished") {
    if (this.closed) return this.snapshot({ includeTranscript: false });
    this.closed = true;
    this.closeReason = String(reason || "run_finished");
    this.lead.status = "completed";
    this.lead.activity = "团队已结束";
    this.lead.finishedAt = this.now();
    for (const member of this.members.values()) {
      if (member.id === TEAM_LEAD_ID) continue;
      if (ACTIVE_MEMBER_STATUSES.has(member.status)) {
        member.status = "cancelled";
        member.activity = "随团队结束而停止";
        member.finishedAt = this.now();
        this._emit("team_member_status", {
          memberId: member.id,
          status: member.status,
          activity: member.activity,
        });
      }
    }
    try { this.abortController.abort(); } catch {}
    if (this.parentAbort) {
      try { this.parentAbort = null; } catch {}
    }
    this._emit("team_closed", {
      reason: this.closeReason,
      team: this.snapshot({ includeTranscript: false }),
      counts: this._counts(),
    });
    return this.snapshot({ includeTranscript: false });
  }
}

export function createTeamService(options) {
  return new TeamService(options);
}

/** 给工具/提示词用的紧凑摘要，不包含 transcript 大字段。 */
export function formatTeamSummary(snapshot) {
  if (!snapshot) return "当前没有团队。";
  const members = (snapshot.members || []).map((member) =>
    `- ${member.id} ${member.name}（${member.roleLabel}）：${member.status}${member.currentTaskId ? `，任务 ${member.currentTaskId}` : ""}${member.activity ? `，${member.activity}` : ""}`,
  );
  const tasks = (snapshot.tasks || []).map((task) =>
    `- ${task.id} ${task.title}：${task.statusLabel || task.status}${task.ownerName ? `，owner ${task.ownerName}` : "，未分配"}${task.ready === false ? "（依赖未完成）" : ""}${task.writeConflicts?.length ? `，写域冲突 ${task.writeConflicts.join("/")}` : ""}${task.result ? `；结果：${String(task.result).replace(/\s+/g, " ").slice(0, 240)}` : ""}`,
  );
  return [
    `团队 ${snapshot.id}（${snapshot.status}，${snapshot.counts?.activeMembers || 0}/${snapshot.counts?.members || 0} 活跃，人数上限 ${snapshot.maxMembers}）`,
    "成员：",
    ...(members.length ? members : ["- 无"]),
    "任务板：",
    ...(tasks.length ? tasks : ["- 暂无任务"]),
  ].join("\n").slice(0, 12000);
}

/** 给子队友的团队任务工具提示：只让队友认领/推进任务，不让他创建任务/管理团队。 */
export function buildMemberTeamPrompt(member) {
  return [
    `你属于一个 Open Plan 团队，成员名「${member.name}」，角色「${member.roleLabel}」。`,
    "你可以用 team_task 查看/认领/推进共享任务板；只能改自己认领的任务。",
    "依赖其他队友时用 team_wait 等一次变化，再 team_task get/list 读取交接结果；不要连续轮询。",
    "不要创建团队、不要创建任务、不要给其他队友发消息；完成后用简洁的结构化摘要回报（做了什么/证据/产物/未完成/风险）。",
  ].join("\n");
}
