import React, { useEffect, useMemo, useRef, useState } from "react";
import Icon from "./Icon.jsx";
import {
  groupTeamTasks,
  teamMemberStatusLabel,
  teamRoleLabel,
  teamStatusLabel,
} from "../团队投影.js";

function memberInitial(name) {
  return String(name || "?").trim().slice(0, 1).toUpperCase() || "?";
}

function statusTone(status) {
  const value = String(status || "");
  if (value === "failed" || value === "attention") return "error";
  if (value === "provisioning" || value === "active" || value === "running") return "active";
  if (value === "completed" || value === "idle" || value === "closed") return "done";
  return "muted";
}

function currentTaskOf(member, tasks) {
  const direct = (tasks || []).find((task) => task.id === member.currentTaskId);
  if (direct) return direct;
  if (member.currentTaskId) return { id: member.currentTaskId, title: member.currentTaskId };
  return null;
}

function MemberCard({ member, tasks, selected, onSelect }) {
  const current = currentTaskOf(member, tasks);
  return (
    <button
      type="button"
      className={`team-member-card ${selected ? "selected" : ""} ${statusTone(member.status)}`}
      onClick={() => onSelect?.(member.id)}
      aria-pressed={selected}
      title={`${member.name} · ${teamRoleLabel(member.role)} · ${teamMemberStatusLabel(member.status)}`}
    >
      <span className="team-member-avatar" aria-hidden="true">{memberInitial(member.name)}</span>
      <span className="team-member-main">
        <span className="team-member-name">
          {member.name}
          {member.role === "lead" && String(member.name).toLowerCase() !== "lead" && <em className="team-member-lead">Lead</em>}
        </span>
        <span className="team-member-meta">
          {teamRoleLabel(member.role)} · {teamMemberStatusLabel(member.status)}
        </span>
        <span className="team-member-task" title={current?.title || member.activity || ""}>
          {current?.title || member.activity || "等待任务"}
        </span>
      </span>
      <i className={`team-status-dot ${statusTone(member.status)}`} aria-hidden="true" />
    </button>
  );
}

function TaskCard({ task, expanded, onToggle }) {
  return (
    <article className={`team-task-card ${task.status || "pending"} ${task.writeConflicts?.length ? "conflict" : ""}`}>
      <button
        type="button"
        className="team-task-head"
        onClick={() => onToggle?.(task.id)}
        aria-expanded={expanded}
      >
        <span className="team-task-title">
          <span className="team-task-id">{task.id}</span>
          <strong>{task.title}</strong>
        </span>
        <span className="team-task-status">{task.statusLabel || task.status}</span>
        <span className={`team-task-chevron ${expanded ? "open" : ""}`}><Icon name="chevronRight" size={12} /></span>
      </button>
      <div className="team-task-meta">
        <span>{task.ownerName || "未分配"}</span>
        <span>Rev.{task.revision}</span>
        {task.ready === false && <span className="team-task-warn"><Icon name="lock" size={10} /> 依赖未完成</span>}
        {task.writeConflicts?.length > 0 && <span className="team-task-warn"><Icon name="warning" size={10} /> 写域重叠</span>}
      </div>
      {expanded && (
        <div className="team-task-detail">
          {task.description ? <p>{task.description}</p> : <p className="team-muted">没有补充描述。</p>}
          {task.blockedBy?.length > 0 && <p><b>依赖：</b>{task.blockedBy.join("、")}</p>}
          {task.writeScopes?.length > 0 && <p><b>写域：</b>{task.writeScopes.join("、")}</p>}
          {task.result ? <p className="team-task-result"><b>结果：</b>{task.result}</p> : null}
        </div>
      )}
    </article>
  );
}

function MemberDetail({ member, tasks, onBack, onOpenTranscript }) {
  const current = currentTaskOf(member, tasks);
  const transcript = Array.isArray(member.transcript) ? member.transcript : [];
  return (
    <div className="team-member-detail" id="team-member-detail">
      <button type="button" className="team-detail-back" onClick={onBack}>
        <Icon name="chevronLeft" size={13} /> 返回团队
      </button>
      <div className="team-detail-head">
        <span className="team-member-avatar large" aria-hidden="true">{memberInitial(member.name)}</span>
        <div>
          <strong>{member.name}</strong>
          <div className="team-member-meta">{teamRoleLabel(member.role)} · {teamMemberStatusLabel(member.status)}</div>
        </div>
        <i className={`team-status-dot ${statusTone(member.status)}`} aria-hidden="true" />
      </div>
      <dl className="team-detail-fields">
        <div><dt>当前任务</dt><dd>{current?.title || member.task || "无"}</dd></div>
        <div><dt>最近活动</dt><dd>{member.activity || "无"}</dd></div>
      </dl>
      {member.error ? <div className="team-detail-error" role="alert">{member.error}</div> : null}
      {member.result ? (
        <div className="team-detail-result">
          <div className="team-detail-label">本轮结果</div>
          <div className="team-detail-result-text">{member.result}</div>
        </div>
      ) : <div className="team-detail-empty">队友尚未返回结果。</div>}
      {transcript.length > 0 && onOpenTranscript ? (
        <button
          type="button"
          className="team-detail-transcript"
          onClick={() => onOpenTranscript({
            id: member.subagentId || `team-member-${member.id}`,
            role: member.role,
            status: member.status,
            task: member.task,
            summary: member.result,
            transcript,
          })}
        >
          <Icon name="file" size={12} /> 打开完整轨迹
        </button>
      ) : null}
    </div>
  );
}

/**
 * 团队只读面板（计划 2026-11-04-014 §7.4–7.8）。
 *
 * 业务状态全部来自 props.team；本地只有 selectedMemberId / expandedTaskId 两个 UI 状态。
 * 不提供 spawn / interrupt / 认领 / 改状态按钮：这些只能由 Agent 工具发起。
 */
export default function TeamPanel({ team = null, onOpenTranscript }) {
  const [selectedMemberId, setSelectedMemberId] = useState("");
  const [expandedTaskId, setExpandedTaskId] = useState("");
  const panelRef = useRef(null);
  const teamId = team?.id || "";

  useEffect(() => {
    setSelectedMemberId("");
    setExpandedTaskId("");
  }, [teamId]);

  const members = useMemo(() => team?.members || [], [team]);
  const tasks = useMemo(() => team?.tasks || [], [team]);
  const groups = useMemo(() => groupTeamTasks(tasks), [tasks]);
  const selectedMember = members.find((member) => member.id === selectedMemberId) || null;
  const counts = team?.counts || { activeMembers: 0, members: 0, tasks: 0, doneTasks: 0, reviewTasks: 0, blockedTasks: 0 };

  if (!team) {
    return (
      <div className="team-panel team-panel-empty" role="tabpanel" id="team-panel" aria-label="团队">
        <div className="team-empty-card">
          <Icon name="user" size={22} />
          <strong>还没有团队</strong>
          <p>在 Work 或 Review 中让 Agent 创建队友后，这里会显示成员、共享任务板与只读轨迹。</p>
        </div>
      </div>
    );
  }

  return (
    <div ref={panelRef} className={`team-panel ${selectedMember ? "show-detail" : ""}`} role="tabpanel" id="team-panel" aria-label="团队">
      <header className="team-summary">
        <div className="team-summary-title">
          <h2 id="team-panel-title" tabIndex={-1}>团队</h2>
          <span className={`team-status-pill ${statusTone(team.status)}`}>{teamStatusLabel(team.status)}</span>
          <span className="team-summary-count">{counts.activeMembers}/{counts.members} 活跃</span>
        </div>
        <div className="team-summary-meta">
          <span>{team.mode === "review" ? "Review · 只读" : "Work · 面板只读"}</span>
          <span>·</span>
          <span
            className={`team-trigger-badge trigger-${team.trigger || "model"}`}
            title={(team.suggestReasons || []).join("；") || "团队创建来源"}
          >
            {team.trigger === "user" ? "用户指定" : team.trigger === "suggested" ? "系统建议" : "模型自选"}
          </span>
          <span>·</span>
          <span>队友写操作仍需审批</span>
          <span>·</span>
          <span>{counts.tasks} 个任务 · {counts.doneTasks} 完成</span>
          {counts.blockedTasks > 0 ? <span className="team-summary-warn">· {counts.blockedTasks} 受阻</span> : null}
        </div>
      </header>

      <div className="team-body">
        <aside className="team-roster" aria-label="团队成员">
          <div className="team-roster-head">成员</div>
          <div className="team-roster-list" role="list">
            {members.map((member) => (
              <MemberCard
                key={member.id}
                member={member}
                tasks={tasks}
                selected={member.id === selectedMemberId}
                onSelect={setSelectedMemberId}
              />
            ))}
          </div>
        </aside>

        <section className="team-content" aria-label="共享任务板">
          {selectedMember ? (
            <MemberDetail
              member={selectedMember}
              tasks={tasks}
              onBack={() => setSelectedMemberId("")}
              onOpenTranscript={onOpenTranscript}
            />
          ) : (
            <>
              <div className="team-board-head">
                <span>共享任务板</span>
                <span className="team-muted">只读 · 由 Agent 推进</span>
              </div>
              {groups.length === 0 ? (
                <div className="team-board-empty">
                  <Icon name="list" size={20} />
                  <strong>Lead 尚未拆解任务</strong>
                  <p>复杂协作任务通常先用 team_task 创建 2–6 个可认领任务。</p>
                </div>
              ) : groups.map((group) => (
                <section key={group.key} className={`team-task-group ${group.key}`} aria-label={group.label}>
                  <div className="team-task-group-head">
                    <span>{group.label}</span>
                    <em>{group.tasks.length}</em>
                  </div>
                  <div className="team-task-list">
                    {group.tasks.map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        expanded={expandedTaskId === task.id}
                        onToggle={(id) => setExpandedTaskId((current) => current === id ? "" : id)}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
