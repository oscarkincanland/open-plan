import React from "react";
import Icon from "./Icon.jsx";
import { teamHeaderLabel, teamHeaderTitle, teamStatusLabel } from "../团队投影.js";

/**
 * 顶栏团队 chip（计划 2026-11-04-014 §7.2）。
 *
 * 只做“状态 + 入口”：完整 roster/任务板在画布团队标签里。
 * 没有团队时不占位；窄屏由 CSS 收起文字，只保留图标 + 计数。
 */
export default function TeamHeaderChip({ team = null, active = false, onOpen }) {
  if (!team) return null;
  const counts = team.counts || { activeMembers: 0, members: 0 };
  const status = String(team.status || "unknown");
  const label = teamHeaderLabel(team);
  const title = `${teamHeaderTitle(team)}${onOpen ? "；点击打开团队面板" : ""}`;
  return (
    <button
      type="button"
      className={`team-header-chip ${status} ${active ? "active" : ""}`}
      onClick={() => onOpen?.()}
      aria-label={title}
      title={title}
      aria-controls="team-panel"
    >
      <Icon name="user" size={13} />
      <span className="team-header-chip-text">团队</span>
      <span className="team-header-chip-count">{counts.activeMembers}/{counts.members}</span>
      <i className="team-header-chip-dot" aria-hidden="true" />
      <span className="team-header-chip-sr">{teamStatusLabel(status)}</span>
    </button>
  );
}
