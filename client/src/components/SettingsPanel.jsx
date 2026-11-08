import React, { useState, useCallback, useEffect } from "react";
import Icon from "./Icon.jsx";
import 模型设置页 from "./模型设置页.jsx";
import { useTheme, SKINS } from "../theme.jsx";
import 跑马灯文本 from "./跑马灯文本.jsx";
import { ACTIVITY_DISPLAY_OPTIONS, ANSWER_DETAIL_OPTIONS, MARQUEE_COLORS, MARQUEE_SPEEDS, MARQUEE_STYLES, MOTION_LEVELS, PREVIEW_AUTO_OPEN_OPTIONS, useAppearance, useAppearanceSetter } from "../界面外观.js";
import { agentDiagnostics, agentNetworkSettings, agentNetworkSettingsSave, archiveProject, archiveSession, archiveSessions, classifyProjects, createProject, deleteSession, deleteSessions, getPermissionRules, listSessions, mapSettings, mapSettingsSave, pinProject, removePermissionRule, searchSettings, searchSettingsSave, searchSettingsTest, updateProject, updateProjectSettings } from "../api.js";
import { notifyError, askConfirm } from "./Feedback.jsx";

/**
 * 设置面板（左侧栏底部 tab）
 * 外观 / 对话行为 / 模型 / 服务集成 / 高级
 * 持久化到 localStorage `oaw_settings`（组件通过 useSetting 读取）
 */
const SETTINGS_KEY = "oaw_settings";
const DEFAULT_SETTINGS = {
  theme: null, // null = 跟随当前主题按钮
  msgFontSize: "medium", // small | medium | large
  commentHighlightMs: 20000, // 批注高亮时长
  thinkingDefaultOpen: false, // 思考块默认收起（结论优先，证据层按需展开）
  showTimeline: true, // 消息目录栏
};

export function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function useSetting(key) {
  const [v, setV] = useState(() => loadSettings()[key]);
  const set = useCallback((next) => {
    setV(next);
    try {
      const s = loadSettings();
      s[key] = next;
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    } catch {}
  }, [key]);
  return [v, set];
}

const FONT_OPTIONS = [
  { id: "small", label: "小", size: 12 },
  { id: "medium", label: "中", size: 13 },
  { id: "large", label: "大", size: 14 },
];

const PROJECT_TYPES = ["交通规划", "GIS / 地图分析", "调研报告", "Office 文档", "数据分析", "综合项目", "资料库"];
const PROJECT_STATUSES = ["进行中", "待整理", "已完成", "已归档", "模板项目"];
const PROJECT_PROFILES = ["通用 Agent", "创作", "研究", "Office", "GIS", "数据分析"];
const PROFILE_POLICY_HINTS = {
  "通用 Agent": "完整工具链 · 标准推理 · 64K 上下文",
  "创作": "模板与 Office 产出优先 · 48K 上下文",
  "研究": "知识库与引用优先 · 深度推理 · 96K 上下文",
  Office: "Office CLI 优先 · 文档写入前确认",
  GIS: "地图与空间分析优先 · 图层写入前确认",
  "数据分析": "数据校验与图表产出优先 · 深度推理",
};
const SETTINGS_NAV = [
  {
    id: "basic",
    label: "基础设置",
    items: [
      ["appearance", "外观与对话", "sun"],
      ["providers", "模型", "robot"],
      ["network", "网络与搜索", "globe"],
      ["services", "服务与底图", "map"],
    ],
  },
  {
    id: "agent",
    label: "Agent 能力",
    items: [
      ["project", "项目与记忆", "folder"],
      ["archive", "归档历史", "history"],
      ["permission", "审批与权限", "shield"],
    ],
  },
  {
    id: "advanced",
    label: "高级",
    items: [
      ["advanced", "重置与诊断", "tool"],
    ],
  },
];

function ProjectSettingsSection({ project, projects = [], currentWorkspace = "", models = [], onProjectUpdated, onProjectSelect }) {
  const [projectDraft, setProjectDraft] = useState({ name: "", type: "综合项目", status: "进行中", description: "" });
  const [settingsDraft, setSettingsDraft] = useState({ defaultModel: "", agentProfile: "通用 Agent", skills: [], skillsPolicy: "on", allowSkillDrafts: "on", memoryPolicy: "approval_required", artifactPolicy: "validation_required" });
  const [projectFilter, setProjectFilter] = useState({ query: "", type: "", status: "", pinned: false, pending: false, sort: "recent" });
  const [createOpen, setCreateOpen] = useState(false);
  const [newProject, setNewProject] = useState({ name: "", rootPath: currentWorkspace, type: "综合项目", status: "进行中", description: "" });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [classifying, setClassifying] = useState(false);

  useEffect(() => {
    setProjectDraft({
      name: project?.name || "",
      type: project?.type || "综合项目",
      status: project?.status || "进行中",
      description: project?.description || "",
    });
    setSettingsDraft({
      defaultModel: project?.settings?.defaultModel || "",
      agentProfile: project?.settings?.agentProfile || "通用 Agent",
      skills: Array.isArray(project?.settings?.skills) ? project.settings.skills : [],
      skillsPolicy: project?.settings?.skillsPolicy || "on",
      allowSkillDrafts: project?.settings?.allowSkillDrafts || "on",
      memoryPolicy: project?.settings?.memoryPolicy || "approval_required",
      artifactPolicy: project?.settings?.artifactPolicy || "validation_required",
    });
  }, [project]);

  useEffect(() => {
    setNewProject((value) => ({ ...value, rootPath: value.rootPath || currentWorkspace }));
  }, [currentWorkspace]);

  const visibleProjects = projects
    .filter((item) => !projectFilter.query || `${item.name} ${item.description} ${item.rootPath}`.toLowerCase().includes(projectFilter.query.toLowerCase()))
    .filter((item) => !projectFilter.type || item.type === projectFilter.type)
    .filter((item) => !projectFilter.status || item.status === projectFilter.status)
    .filter((item) => !projectFilter.pinned || item.pinned)
    .filter((item) => !projectFilter.pending || item.pendingMemoryCount > 0 || item.unresolvedRunCount > 0)
    .sort((a, b) => projectFilter.sort === "name"
      ? String(a.name || "").localeCompare(String(b.name || ""))
      : String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));

  const saveProject = async () => {
    if (!project?.id || !projectDraft.name.trim() || saving) return;
    setSaving(true);
    setMessage("");
    try {
      await updateProject(project.id, projectDraft);
      await updateProjectSettings(project.id, { ...settingsDraft, skills: settingsDraft.skills });
      setMessage("项目设置已保存");
      onProjectUpdated?.();
    } catch (error) {
      setMessage(`保存失败：${error.message}`);
    } finally {
      setSaving(false);
    }
  };

  const toggleProjectArchive = async () => {
    if (!project?.id || saving) return;
    setSaving(true);
    try {
      await archiveProject(project.id, project.status !== "已归档");
      setMessage(project.status === "已归档" ? "项目已恢复" : "项目已归档");
      onProjectUpdated?.();
    } catch (error) { setMessage(`状态更新失败：${error.message}`); }
    finally { setSaving(false); }
  };

  const toggleProjectPin = async () => {
    if (!project?.id || saving) return;
    setSaving(true);
    try {
      await pinProject(project.id, !project.pinned);
      setMessage(project.pinned ? "项目已取消置顶" : "项目已置顶");
      onProjectUpdated?.();
    } catch (error) { setMessage(`置顶失败：${error.message}`); }
    finally { setSaving(false); }
  };

  const create = async () => {
    if (!newProject.name.trim() || !newProject.rootPath.trim() || saving) return;
    setSaving(true);
    setMessage("");
    try {
      const result = await createProject(newProject);
      setCreateOpen(false);
      setNewProject({ name: "", rootPath: currentWorkspace, type: "综合项目", status: "进行中", description: "" });
      onProjectUpdated?.();
      if (result.project?.id) onProjectSelect?.(result.project.id);
      setMessage(result.existing ? "该工作区已有项目，已切换到现有项目" : "项目已创建");
    } catch (error) { setMessage(`创建失败：${error.message}`); }
    finally { setSaving(false); }
  };

  const classify = async () => {
    if (classifying) return;
    setClassifying(true);
    setMessage("");
    try {
      const preview = await classifyProjects(false);
      const changes = (preview.changes || []).filter((item) => item.changed);
      if (!changes.length) {
        setMessage("没有可自动判断的项目，已保留现有分类");
        return;
      }
      const result = await classifyProjects(true);
      setMessage(`已按项目名称归类 ${result.changed || changes.length} 个项目`);
      onProjectUpdated?.();
    } catch (error) {
      setMessage(`自动归类失败：${error.message}`);
    } finally {
      setClassifying(false);
    }
  };

  return (
    <div className="project-settings-section">
      <div className="sp-section-title"><Icon name="folder" size={12} /> 项目管理</div>
      <div className="project-management-toolbar">
        <input className="sp-input" placeholder="搜索项目、描述或路径" value={projectFilter.query} onChange={(e) => setProjectFilter((value) => ({ ...value, query: e.target.value }))} />
        <select className="sp-select" value={projectFilter.type} onChange={(e) => setProjectFilter((value) => ({ ...value, type: e.target.value }))}><option value="">全部类型</option>{PROJECT_TYPES.map((item) => <option key={item}>{item}</option>)}</select>
        <select className="sp-select" value={projectFilter.status} onChange={(e) => setProjectFilter((value) => ({ ...value, status: e.target.value }))}><option value="">全部状态</option>{PROJECT_STATUSES.map((item) => <option key={item}>{item}</option>)}</select>
            <select className="sp-select" value={projectFilter.sort} onChange={(e) => setProjectFilter((value) => ({ ...value, sort: e.target.value }))}><option value="recent">最近活跃</option><option value="name">名称</option></select>
            <label className="sp-check-label"><input type="checkbox" checked={projectFilter.pinned} onChange={(e) => setProjectFilter((value) => ({ ...value, pinned: e.target.checked }))} /> 置顶</label>
            <label className="sp-check-label"><input type="checkbox" checked={projectFilter.pending} onChange={(e) => setProjectFilter((value) => ({ ...value, pending: e.target.checked }))} /> 待处理</label>
        <button className="btn-sm" onClick={classify} disabled={classifying}><Icon name="flow" size={12} /> {classifying ? "归类中…" : "自动归类"}</button>
        <button className="btn-sm primary" onClick={() => setCreateOpen((value) => !value)}><Icon name="plus" size={12} /> 新建项目</button>
      </div>
      {createOpen && (
        <div className="project-create-form">
          <input className="sp-input" placeholder="项目名称" value={newProject.name} onChange={(e) => setNewProject((value) => ({ ...value, name: e.target.value }))} />
          <input className="sp-input" placeholder="项目工作区绝对路径" value={newProject.rootPath} onChange={(e) => setNewProject((value) => ({ ...value, rootPath: e.target.value }))} />
          <select className="sp-select" value={newProject.type} onChange={(e) => setNewProject((value) => ({ ...value, type: e.target.value }))}>{PROJECT_TYPES.map((item) => <option key={item}>{item}</option>)}</select>
          <select className="sp-select" value={newProject.status} onChange={(e) => setNewProject((value) => ({ ...value, status: e.target.value }))}>{PROJECT_STATUSES.map((item) => <option key={item}>{item}</option>)}</select>
          <input className="sp-input" placeholder="项目说明（可选）" value={newProject.description} onChange={(e) => setNewProject((value) => ({ ...value, description: e.target.value }))} />
          <button className="btn-sm primary" onClick={create} disabled={saving}>创建</button>
        </div>
      )}
      <div className="project-management-list">
        {visibleProjects.map((item) => (
          <button key={item.id} className={`project-management-item ${item.id === project?.id ? "active" : ""}`} onClick={() => onProjectSelect?.(item.id)}>
            <span className="project-management-item-main"><strong>{item.pinned ? "★ " : ""}{item.name}</strong><small>{item.type} · {item.status} · 会话 {item.sessionCount || 0} · 任务 {item.runCount || 0}</small></span>
            <span className="project-management-item-count">{item.pendingMemoryCount ? `待沉淀 ${item.pendingMemoryCount}` : ""}</span>
          </button>
        ))}
        {!visibleProjects.length && <div className="empty">没有匹配的项目</div>}
      </div>
      {project ? (
        <>
          <div className="sp-row project-settings-row"><span className="sp-label">当前项目</span><strong>{project.name}</strong><button className="btn-xs" onClick={toggleProjectPin} disabled={saving}>{project.pinned ? "取消置顶" : "置顶"}</button><button className="btn-xs" onClick={toggleProjectArchive} disabled={saving}>{project.status === "已归档" ? "恢复项目" : "归档项目"}</button></div>
          <div className="sp-row"><span className="sp-label">项目名称</span><input className="sp-input" value={projectDraft.name} onChange={(e) => setProjectDraft((value) => ({ ...value, name: e.target.value }))} /></div>
          <div className="sp-row"><span className="sp-label">项目类型</span><select className="sp-select" value={projectDraft.type} onChange={(e) => setProjectDraft((value) => ({ ...value, type: e.target.value }))}>{PROJECT_TYPES.map((item) => <option key={item}>{item}</option>)}</select><span className="sp-label">项目状态</span><select className="sp-select" value={projectDraft.status} onChange={(e) => setProjectDraft((value) => ({ ...value, status: e.target.value }))}>{PROJECT_STATUSES.map((item) => <option key={item}>{item}</option>)}</select></div>
          <div className="sp-row"><span className="sp-label">项目说明</span><textarea className="sp-textarea" value={projectDraft.description} onChange={(e) => setProjectDraft((value) => ({ ...value, description: e.target.value }))} /></div>
          <div className="sp-section-title project-runtime-title"><Icon name="robot" size={12} /> 项目运行设置</div>
          <div className="sp-row"><span className="sp-label">默认模型</span><select className="sp-select" value={settingsDraft.defaultModel} onChange={(e) => setSettingsDraft((value) => ({ ...value, defaultModel: e.target.value }))}><option value="">跟随系统默认</option>{models.map((item) => <option key={`${item.provider || "model"}/${item.id}`} value={item.id}>{item.id}</option>)}</select></div>
           <div className="sp-row"><span className="sp-label">Agent Profile</span><select className="sp-select" value={settingsDraft.agentProfile} onChange={(e) => setSettingsDraft((value) => ({ ...value, agentProfile: e.target.value }))}>{PROJECT_PROFILES.map((item) => <option key={item}>{item}</option>)}</select><span className="sp-note-inline">{PROFILE_POLICY_HINTS[settingsDraft.agentProfile] || "按任务选择工具链"}</span></div>
          <div className="sp-row"><span className="sp-label">允许 Skills</span><input className="sp-input" placeholder="skill-a, skill-b（留空表示按需）" value={settingsDraft.skills.join(", ")} onChange={(e) => setSettingsDraft((value) => ({ ...value, skills: e.target.value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean) }))} /></div>
          <div className="sp-row">
            <span className="sp-label">技能策略</span>
            <select className="sp-select" value={settingsDraft.skillsPolicy} onChange={(e) => setSettingsDraft((value) => ({ ...value, skillsPolicy: e.target.value }))}>
              <option value="on">开启（每轮注入目录，由模型自行判断是否使用）</option>
              <option value="off">关闭（不注入技能目录，显式点名仍预检）</option>
            </select>
            <span className="sp-label">技能草稿</span>
            <select className="sp-select" value={settingsDraft.allowSkillDrafts} onChange={(e) => setSettingsDraft((value) => ({ ...value, allowSkillDrafts: e.target.value }))}>
              <option value="on">总是允许生成</option>
              <option value="complex">仅复杂任务允许生成</option>
              <option value="off">关闭</option>
            </select>
          </div>
          <div className="sp-note">技能草稿只写工作区 `.oaw/skill-drafts`，安装到技能库必须由你在技能广场里确认。</div>
          <div className="sp-row"><span className="sp-label">记忆策略</span><select className="sp-select" value={settingsDraft.memoryPolicy} onChange={(e) => setSettingsDraft((value) => ({ ...value, memoryPolicy: e.target.value }))}><option value="approval_required">必须审核后沉淀</option><option value="manual">仅手动维护</option></select><span className="sp-label">成果策略</span><select className="sp-select" value={settingsDraft.artifactPolicy} onChange={(e) => setSettingsDraft((value) => ({ ...value, artifactPolicy: e.target.value }))}><option value="validation_required">校验通过后固定</option><option value="manual">仅手动固定</option></select></div>
          <div className="sp-row"><span className="sp-label">操作</span><button className="btn-sm primary" onClick={saveProject} disabled={saving}>{saving ? "保存中…" : "保存项目设置"}</button>{message && <span className="sp-auth-msg">{message}</span>}</div>
        </>
      ) : <div className="empty">请选择一个项目查看设置</div>}
    </div>
  );
}

function formatArchiveTime(value) {
  const ms = Date.parse(value || "");
  if (!Number.isFinite(ms)) return "时间未知";
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/**
 * 归档历史（2026-11-03）：归档会话的唯一管理入口。
 * 归档只改 header，不删除文件/消息；运行中的会话不可归档，因此这里不会出现“在跑”的项。
 */
function ArchiveSettingsSection({ onSessionsChanged }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setMessage("");
    try {
      const result = await listSessions({ archived: "only" });
      setItems(Array.isArray(result?.sessions) ? result.sessions : []);
    } catch (error) {
      setMessage(`读取归档失败：${error.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const available = new Set(items.map((item) => item.id));
    setSelectedIds((current) => new Set([...current].filter((id) => available.has(id))));
  }, [items]);

  const visible = query.trim()
    ? items.filter((item) => `${item.title || ""} ${item.label || ""} ${item.cwd || ""}`.toLowerCase().includes(query.trim().toLowerCase()))
    : items;
  const toggle = (id) => setSelectedIds((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const restoreOne = async (id) => {
    try {
      await archiveSession(id, false);
      await load();
      onSessionsChanged?.();
      setMessage("已恢复该会话");
    } catch (error) { setMessage(`恢复失败：${error.message}`); }
  };
  const deleteOne = async (id) => {
    if (!(await askConfirm("永久删除此归档会话？删除后不可恢复。"))) return;
    try {
      await deleteSession(id);
      await load();
      onSessionsChanged?.();
      setMessage("已永久删除");
    } catch (error) { setMessage(`删除失败：${error.message}`); }
  };
  const batchRestore = async () => {
    if (!selectedIds.size) return;
    try {
      const result = await archiveSessions([...selectedIds], false);
      setSelectedIds(new Set());
      await load();
      onSessionsChanged?.();
      setMessage(`已恢复 ${result?.restoredIds?.length || 0} 个会话${result?.skipped?.length ? `，跳过 ${result.skipped.length} 个` : ""}`);
    } catch (error) { setMessage(`批量恢复失败：${error.message}`); }
  };
  const batchDelete = async () => {
    if (!selectedIds.size) return;
    if (!(await askConfirm(`永久删除已选的 ${selectedIds.size} 个归档会话？删除后不可恢复。`))) return;
    try {
      const result = await deleteSessions([...selectedIds]);
      setSelectedIds(new Set());
      await load();
      onSessionsChanged?.();
      setMessage(`已删除 ${result?.deleted?.length || 0} 个会话${result?.skipped?.length ? `，跳过 ${result.skipped.length} 个` : ""}`);
    } catch (error) { setMessage(`批量删除失败：${error.message}`); }
  };

  return (
    <div className="sp-section archive-settings-section" id="settings-archive">
      <div className="sp-section-title"><Icon name="history" size={12} /> 归档历史</div>
      <p className="sp-hint">归档只收起会话，不删除文件和消息，可随时恢复；运行中的会话不能归档。</p>
      <div className="archive-toolbar">
        <input className="sp-input" placeholder="搜索标题或工作区" value={query} onChange={(event) => setQuery(event.target.value)} />
        <button type="button" className="btn-sm" onClick={load} disabled={loading}><Icon name="refresh" size={12} /> {loading ? "刷新中…" : "刷新"}</button>
      </div>
      {selectedIds.size > 0 && (
        <div className="archive-batch">
          <span>已选 {selectedIds.size} 个</span>
          <button type="button" className="btn-xs" onClick={() => setSelectedIds(new Set(visible.map((item) => item.id)))}>全选</button>
          <button type="button" className="btn-xs" onClick={() => setSelectedIds(new Set())}>清空</button>
          <button type="button" className="btn-xs" onClick={batchRestore}>批量恢复</button>
          <button type="button" className="btn-xs danger" onClick={batchDelete}>批量永久删除</button>
        </div>
      )}
      {loading && !items.length && <div className="sp-note">正在读取归档…</div>}
      {!loading && !visible.length && <div className="empty">暂无归档会话</div>}
      <div className="archive-list">
        {visible.map((item) => (
          <div key={item.id} className="archive-item">
            <input type="checkbox" checked={selectedIds.has(item.id)} onChange={() => toggle(item.id)} aria-label={`选择 ${item.title || item.label || item.id}`} />
            <div className="archive-item-main">
              <strong title={item.title || item.label || "未命名会话"}>{item.title || item.label || "未命名会话"}</strong>
              <small>
                {item.mode === "chat" ? "Chat" : item.mode === "review" ? "Review" : "Work"}
                {item.cwd ? ` · ${item.cwd}` : ""}
                {` · 归档于 ${formatArchiveTime(item.archivedAt)}`}
              </small>
            </div>
            <div className="archive-item-actions">
              <button type="button" className="btn-xs" onClick={() => restoreOne(item.id)}>恢复</button>
              <button type="button" className="btn-xs danger" onClick={() => deleteOne(item.id)}>永久删除</button>
            </div>
          </div>
        ))}
      </div>
      {message && <div className="sp-note archive-msg">{message}</div>}
    </div>
  );
}

export default function SettingsPanel({ onReset, project = null, projects = [], currentWorkspace = "", models = [], defaultModel = "", activeModel = "", clientId = "", threadId = "", initialSection = "model", onSessionsChanged, onModelChange, onModelsRefresh, onProjectUpdated, onProjectSelect }) {
  const { theme, setTheme, skin, setSkin } = useTheme();
  const [settingsSection, setSettingsSection] = useState("model");
  const appearance = useAppearance();
  const setAppearance = useAppearanceSetter();
  const [msgFontSize, setMsgFontSize] = useSetting("msgFontSize");
  const [commentHighlightMs, setCommentHighlightMs] = useSetting("commentHighlightMs");
  const [thinkingDefaultOpen, setThinkingDefaultOpen] = useSetting("thinkingDefaultOpen");
  const [showTimeline, setShowTimeline] = useSetting("showTimeline");
  const [integration, setIntegration] = useState(null);
  const [networkDraft, setNetworkDraft] = useState({ mode: "direct", proxyUrl: "", noProxy: "localhost,127.0.0.1,::1" });
  const [networkStatus, setNetworkStatus] = useState(null);
  const [networkSaving, setNetworkSaving] = useState(false);
  const [networkMsg, setNetworkMsg] = useState("");
  // 联网搜索配置（后端 + 各后端凭据；服务端不回传明文 Key）
  const [searchMeta, setSearchMeta] = useState({ backends: [], settings: null });
  const [searchDraft, setSearchDraft] = useState({ backend: "tavily", tavilyKey: "", searxngUrl: "", jinaKey: "", bochaKey: "" });
  const [searchSaving, setSearchSaving] = useState(false);
  const [searchTesting, setSearchTesting] = useState(false);
  const [searchSaveMsg, setSearchSaveMsg] = useState("");
  const [searchTestMsg, setSearchTestMsg] = useState("");
  const [searchTestInfo, setSearchTestInfo] = useState(null);
  const [diagnostics, setDiagnostics] = useState(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [diagnosticsMsg, setDiagnosticsMsg] = useState("");
  const [version, setVersion] = useState("");
  // 底图服务 Key（服务端不回传明文，仅状态）
  const [basemapKeys, setBasemapKeys] = useState({ tianditu: "", maptiler: "", geoapify: "" });
  const [basemapStatus, setBasemapStatus] = useState({ tianditu: false, maptiler: false, geoapify: false });
  const [basemapMsg, setBasemapMsg] = useState("");
  const [basemapSaving, setBasemapSaving] = useState(false);
  const [permissionRules, setPermissionRules] = useState(null); // { mode, defaults, user }
  const [permissionBusy, setPermissionBusy] = useState(false);

  useEffect(() => {
    if (["appearance", "model", "plans", "providers", "network", "services", "project", "archive", "advanced", "permission"].includes(initialSection)) {
      setSettingsSection(initialSection === "model" ? "providers" : initialSection === "plans" ? "providers" : initialSection);
    }
  }, [initialSection]);

  const loadPermissionRules = useCallback(async () => {
    try { setPermissionRules(await getPermissionRules()); }
    catch { setPermissionRules({ mode: "ask", defaults: [], user: [] }); }
  }, []);

  useEffect(() => { if (settingsSection === "permission") loadPermissionRules(); }, [settingsSection, loadPermissionRules]);

  const revokePermissionRule = useCallback(async (rule) => {
    setPermissionBusy(true);
    try {
      const result = await removePermissionRule(rule);
      if (Array.isArray(result?.rules)) setPermissionRules((prev) => ({ ...(prev || { mode: "ask", defaults: [] }), user: result.rules }));
    } catch (error) {
      notifyError(error.message || "撤销规则失败");
    }
    setPermissionBusy(false);
  }, []);

  const loadDiagnostics = useCallback(async () => {
    if (diagnosticsLoading) return;
    setDiagnosticsLoading(true);
    try {
      const result = await agentDiagnostics(clientId, threadId);
      setDiagnostics(result);
      setDiagnosticsMsg("");
    } catch (error) {
      setDiagnosticsMsg(`诊断读取失败 · ${error.message}`);
    } finally {
      setDiagnosticsLoading(false);
    }
  }, [clientId, threadId, diagnosticsLoading]);

  const loadPiConfiguration = useCallback(async () => {
    const [networkResult, searchResult] = await Promise.allSettled([
      agentNetworkSettings(),
      searchSettings(),
    ]);
    if (networkResult.status === "fulfilled") {
      const value = networkResult.value || {};
      setNetworkStatus(value);
      setNetworkDraft({
        mode: value.mode || "direct",
        proxyUrl: "",
        noProxy: value.noProxy || "localhost,127.0.0.1,::1",
      });
    }
    if (searchResult.status === "fulfilled") {
      const value = searchResult.value || {};
      const settings = value.settings || {};
      setSearchMeta({ backends: Array.isArray(value.backends) ? value.backends : [], settings });
      setSearchDraft((draft) => ({
        ...draft,
        backend: settings.backend || "tavily",
        searxngUrl: settings.searxngUrl || "",
      }));
    }
  }, []);

  const saveSearchConfig = useCallback(async () => {
    setSearchSaving(true);
    setSearchSaveMsg("");
    try {
      const result = await searchSettingsSave({
        backend: searchDraft.backend,
        tavilyKey: searchDraft.tavilyKey,
        searxngUrl: searchDraft.searxngUrl,
        jinaKey: searchDraft.jinaKey,
        bochaKey: searchDraft.bochaKey,
      });
      const settings = result?.settings || {};
      setSearchMeta((meta) => ({ ...meta, settings }));
      setSearchDraft((draft) => ({ ...draft, tavilyKey: "", jinaKey: "", bochaKey: "" }));
      // 配置变更后连通性会重置为未验证，旧的测试结果不再可信。
      setSearchTestInfo(null);
      setSearchTestMsg("");
      setSearchSaveMsg("配置已保存。连通性需重新测试；Agent 新回合即可使用 web_search / web_fetch。");
    } catch (error) {
      setSearchSaveMsg(`保存失败 · ${error.message}`);
    } finally {
      setSearchSaving(false);
    }
  }, [searchDraft]);

  const clearSearchCredentials = useCallback(async () => {
    const backend = searchDraft.backend;
    const label = searchMeta.backends.find((item) => item.id === backend)?.name || backend;
    if (!(await askConfirm(`确定清除「${label}」已保存的凭据/地址？清除后需重新配置才能使用该后端。`))) return;
    setSearchSaving(true);
    setSearchSaveMsg("");
    try {
      const result = await searchSettingsSave({ backend, clearCredentials: [backend] });
      const settings = result?.settings || {};
      setSearchMeta((meta) => ({ ...meta, settings }));
      setSearchDraft((draft) => ({
        ...draft,
        tavilyKey: "",
        jinaKey: "",
        bochaKey: "",
        searxngUrl: backend === "searxng" ? "" : draft.searxngUrl,
      }));
      setSearchTestInfo(null);
      setSearchTestMsg("");
      setSearchSaveMsg("已清除该后端的已保存凭据。若进程环境变量提供了同名凭据，仍会生效。");
    } catch (error) {
      setSearchSaveMsg(`清除失败 · ${error.message}`);
    } finally {
      setSearchSaving(false);
    }
  }, [searchDraft.backend, searchMeta.backends]);

  const runSearchTest = useCallback(async () => {
    setSearchTesting(true);
    setSearchTestMsg("");
    setSearchTestInfo(null);
    try {
      // 只把「与已保存值不同」的输入作为草稿测试，避免把未修改的值也当成草稿。
      const saved = searchMeta.settings || {};
      const draft = {};
      if (searchDraft.backend === "tavily" && searchDraft.tavilyKey.trim()) draft.tavilyKey = searchDraft.tavilyKey;
      if (searchDraft.backend === "jina" && searchDraft.jinaKey.trim()) draft.jinaKey = searchDraft.jinaKey;
      if (searchDraft.backend === "bocha" && searchDraft.bochaKey.trim()) draft.bochaKey = searchDraft.bochaKey;
      const draftUrl = searchDraft.searxngUrl.trim().replace(/\/+$/, "");
      if (searchDraft.backend === "searxng" && draftUrl && draftUrl !== String(saved.searxngUrl || "").replace(/\/+$/, "")) draft.searxngUrl = searchDraft.searxngUrl;
      const result = await searchSettingsTest(searchDraft.backend, Object.keys(draft).length ? draft : null);
      setSearchTestInfo(result);
      setSearchTestMsg(`${result?.ok ? "✓" : "✗"} ${result?.message || "测试完成"}`);
      // 测试会更新服务端连通性状态（草稿测试除外），刷新徽标。
      const refreshed = await searchSettings().catch(() => null);
      if (refreshed?.settings) setSearchMeta((meta) => ({ ...meta, settings: refreshed.settings }));
    } catch (error) {
      setSearchTestMsg(`测试失败 · ${error.message}`);
    } finally {
      setSearchTesting(false);
    }
  }, [searchDraft, searchMeta.settings]);

  useEffect(() => {
    const size = FONT_OPTIONS.find((f) => f.id === msgFontSize)?.size || 13;
    document.documentElement.style.setProperty("--msg-font-size", size + "px");
  }, [msgFontSize]);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/status").then((x) => x.json());
        setIntegration(r);
        if (r.version) setVersion("v" + r.version);
      } catch {}
    })();
// 已配置的供应商目录与凭据由模型设置页自己加载；这里只保留网络、搜索与诊断。
    loadPiConfiguration().catch(() => {});
    loadDiagnostics().catch(() => {});
    // 底图服务 Key 状态
    mapSettings()
      .then((r) => {
        const b = r?.basemaps || {};
        setBasemapStatus({ tianditu: !!b.tiandituKey, maptiler: !!b.maptilerKey, geoapify: !!b.geoapifyKey });
      })
      .catch(() => {});
  }, [loadPiConfiguration]);

  const saveBasemaps = async () => {
    setBasemapSaving(true);
    try {
      const r = await mapSettingsSave({
        tiandituKey: basemapKeys.tianditu.trim(),
        maptilerKey: basemapKeys.maptiler.trim(),
        geoapifyKey: basemapKeys.geoapify.trim(),
      });
      const b = r?.basemaps || {};
      setBasemapStatus({ tianditu: !!b.tiandituKey, maptiler: !!b.maptilerKey, geoapify: !!b.geoapifyKey });
      setBasemapKeys({ tianditu: "", maptiler: "", geoapify: "" });
      setBasemapMsg("已保存 ✓ 底图列表已更新，地图需刷新样式（切一次底图或重进地图）");
    } catch (e) {
      setBasemapMsg("保存失败: " + e.message);
    }
    setBasemapSaving(false);
    setTimeout(() => setBasemapMsg(""), 4000);
  };

  const saveNetworkSettings = async () => {
    if (networkSaving) return;
    if (networkDraft.mode === "manual" && !networkDraft.proxyUrl.trim() && !networkStatus?.hasProxy) {
      setNetworkMsg("手动代理模式需要填写代理地址");
      return;
    }
    setNetworkSaving(true);
    setNetworkMsg("正在应用模型网络设置…");
    try {
      const result = await agentNetworkSettingsSave({
        mode: networkDraft.mode,
        noProxy: networkDraft.noProxy,
        ...(networkDraft.proxyUrl.trim() ? { proxyUrl: networkDraft.proxyUrl.trim() } : { keepExistingProxy: true }),
      });
      setNetworkStatus(result);
      setNetworkDraft((value) => ({ ...value, proxyUrl: "", noProxy: result.noProxy || value.noProxy }));
      setNetworkMsg("网络设置已保存，新建 Agent 请求将使用该设置");
      await loadPiConfiguration();
    } catch (error) {
      setNetworkMsg(`保存失败 · ${error.message}`);
    } finally {
      setNetworkSaving(false);
    }
  };

  const diagnosticModel = String(activeModel || defaultModel || diagnostics?.model?.selected || "").trim();
  const diagnosticModelReady = Boolean(diagnosticModel && diagnostics?.model?.selectedInCatalog && diagnostics?.model?.selectedAvailable !== false);
  const diagnosticRuntimeStatus = String(diagnostics?.runtime?.health?.status || "");
  const diagnosticRuntimeReady = ["idle", "running", "busy"].includes(diagnosticRuntimeStatus);
  const credentialErrorCount = Object.keys(diagnostics?.authErrors || {}).length;
  const diagnosticFailures = Array.isArray(diagnostics?.recentFailures) ? diagnostics.recentFailures : [];
  const diagnosticCards = [
    { label: "Pi SDK", value: integration?.piPackageVersion || diagnostics?.service?.version ? "已加载" : "未加载", ok: Boolean(integration?.piPackageVersion || diagnostics?.service?.version) },
    { label: "模型目录", value: diagnosticModelReady ? "已就绪" : diagnosticModel ? "未匹配" : "未选择", ok: diagnosticModelReady },
    { label: "供应商凭据", value: credentialErrorCount ? `${credentialErrorCount} 个凭据失效` : diagnostics?.model?.authConfigured ? "已配置" : "未配置", ok: !credentialErrorCount && Boolean(diagnostics?.model?.authConfigured) },
    { label: "最近失败", value: diagnosticFailures.length ? `${diagnosticFailures.length} 条` : "无记录", ok: !diagnosticFailures.length },
  ];

  const resetAll = async () => {
    if (!(await askConfirm("确定恢复默认设置并清空界面状态？将刷新页面。"))) return;
    try {
      localStorage.removeItem("oaw_settings");
      localStorage.removeItem("oaw_ui_state_v1");
    } catch {}
    onReset?.();
    window.location.reload();
  };

  return (
    <div className="settings-panel">
      <aside className="settings-nav" aria-label="设置分类">
        <div className="settings-nav-head">
          <strong>设置</strong>
          <span>Pi 内核 {integration?.piPackageVersion || "已加载"}</span>
        </div>
        {SETTINGS_NAV.map((group) => (
          <div className="settings-nav-group" key={group.id}>
            <div className="settings-nav-title">{group.label}</div>
            {group.items.map(([id, label, icon]) => (
              <button key={id} type="button" className={`settings-nav-item${settingsSection === id ? " active" : ""}`} onClick={() => setSettingsSection(id)}>
                <Icon name={icon} size={14} />
                <span>{label}</span>
              </button>
            ))}
          </div>
        ))}
        <div className="settings-constitution-note" role="note">
          <Icon name="shield" size={12} />
          <span>运行宪法 L0 {integration?.constitutionVersion ? `v${integration.constitutionVersion}` : ""} · 内置只读（不提供编辑）</span>
        </div>
      </aside>
      <div className="settings-content">

      {settingsSection === "archive" && <ArchiveSettingsSection onSessionsChanged={onSessionsChanged} />}

      {settingsSection === "project" && <ProjectSettingsSection
        project={project}
        projects={projects}
        currentWorkspace={currentWorkspace}
        models={models}
        onProjectUpdated={onProjectUpdated}
        onProjectSelect={onProjectSelect}
      />}

      {settingsSection === "appearance" && <>
      <div className="sp-section" id="settings-appearance">
        <div className="sp-section-title"><Icon name="sun" size={12} /> 外观与品牌</div>
        <div className="sp-row">
          <span className="sp-label">主题</span>
          <div className="sp-options">
            <button className={`sp-opt ${theme === "dark" ? "active" : ""}`} onClick={() => setTheme("dark")}>暗色</button>
            <button className={`sp-opt ${theme === "light" ? "active" : ""}`} onClick={() => setTheme("light")}>亮色</button>
          </div>
        </div>
        <div className="sp-row">
          <span className="sp-label">工作台风格</span>
          <div className="sp-options sp-skins">
            {SKINS.map((s) => (
              <button
                key={s.id}
                className={`sp-opt sp-skin ${skin === s.id ? "active" : ""}`}
                onClick={() => setSkin(s.id)}
                title={s.label}
              >
                <i className={`skin-dot skin-${s.id}`} />
                {s.label}
              </button>
            ))}
          </div>
        </div>
        <div className="sp-row">
          <span className="sp-label">消息字体</span>
          <div className="sp-options">
            {FONT_OPTIONS.map((f) => (
              <button key={f.id} className={`sp-opt ${msgFontSize === f.id ? "active" : ""}`} onClick={() => setMsgFontSize(f.id)}>
                {f.label}
              </button>
            ))}
          </div>
        </div>
        <div className="sp-row">
          <span className="sp-label">批注高亮</span>
          <input
            type="range"
            min={5}
            max={60}
            step={5}
            value={Math.round(commentHighlightMs / 1000)}
            onChange={(e) => setCommentHighlightMs(Number(e.target.value) * 1000)}
            className="sp-range"
          />
          <span className="sp-val">{Math.round(commentHighlightMs / 1000)}s</span>
        </div>
      </div>

      <div className="sp-section" id="settings-marquee">
        <div className="sp-section-title"><Icon name="flow" size={12} /> 跑马灯与动效</div>
        <div className="sp-hint">运行中的会话、项目与任务名会用跑马灯滚动；对话过程的细线动效会沿用下方样式、配色和速度，改完立即生效。</div>
        <div className="sp-row">
          <span className="sp-label">样式</span>
          <div className="sp-options sp-marquee-styles">
            {MARQUEE_STYLES.map((item) => (
              <button
                key={item.id}
                className={`sp-opt ${appearance.marqueeStyle === item.id ? "active" : ""}`}
                title={item.hint}
                onClick={() => setAppearance({ marqueeStyle: item.id })}
              >{item.label}</button>
            ))}
          </div>
        </div>
        <div className="sp-row">
          <span className="sp-label">配色</span>
          <div className="sp-options sp-marquee-colors">
            {MARQUEE_COLORS.map((item) => (
              <button
                key={item.id}
                className={`sp-opt sp-color-opt color-${item.id} ${appearance.marqueeColor === item.id ? "active" : ""}`}
                title={item.hint}
                onClick={() => setAppearance({ marqueeColor: item.id })}
              ><i className={`marquee-swatch color-${item.id}`} aria-hidden="true" />{item.label}</button>
            ))}
          </div>
        </div>
        <div className="sp-row">
          <span className="sp-label">滚动速度</span>
          <div className="sp-options">
            {MARQUEE_SPEEDS.map((item) => (
              <button
                key={item.id}
                className={`sp-opt ${appearance.marqueeSpeed === item.id ? "active" : ""}`}
                onClick={() => setAppearance({ marqueeSpeed: item.id })}
              >{item.label}</button>
            ))}
          </div>
        </div>
        <div className="sp-row">
          <span className="sp-label">对话过程跑马灯</span>
          <label className="sp-toggle-label">
            <input
              type="checkbox"
              checked={appearance.activityMarqueeEnabled}
              onChange={(event) => setAppearance({ activityMarqueeEnabled: event.target.checked })}
            />
            <span>运行时显示轻量流光</span>
          </label>
        </div>
        <div className="sp-row">
          <span className="sp-label">执行过程</span>
          <div className="sp-options">
            {ACTIVITY_DISPLAY_OPTIONS.map((item) => (
              <button
                key={item.id}
                className={`sp-opt ${appearance.activityDisplay === item.id ? "active" : ""}`}
                title={item.hint}
                onClick={() => setAppearance({ activityDisplay: item.id })}
              >{item.label}</button>
            ))}
          </div>
        </div>
        <div className="sp-row">
          <span className="sp-label">回答详细程度</span>
          <div className="sp-options">
            {ANSWER_DETAIL_OPTIONS.map((item) => (
              <button
                key={item.id}
                className={`sp-opt ${appearance.answerDetail === item.id ? "active" : ""}`}
                title={item.hint}
                onClick={() => setAppearance({ answerDetail: item.id })}
              >{item.label}</button>
            ))}
          </div>
        </div>
        <div className="sp-row">
          <span className="sp-label">自动打开预览</span>
          <div className="sp-options">
            {PREVIEW_AUTO_OPEN_OPTIONS.map((item) => (
              <button
                key={item.id}
                className={`sp-opt ${appearance.previewAutoOpen === item.id ? "active" : ""}`}
                title={item.hint}
                onClick={() => setAppearance({ previewAutoOpen: item.id })}
              >{item.label}</button>
            ))}
          </div>
        </div>
        <div className="sp-row">
          <span className="sp-label">动效强度</span>
          <div className="sp-options">
            {MOTION_LEVELS.map((item) => (
              <button
                key={item.id}
                className={`sp-opt ${appearance.motionLevel === item.id ? "active" : ""}`}
                title={item.hint}
                onClick={() => setAppearance({ motionLevel: item.id })}
              >{item.label}</button>
            ))}
          </div>
        </div>
        <div className="sp-row sp-marquee-preview-row">
          <span className="sp-label">效果预览</span>
          <div className="sp-marquee-preview-stack">
            <div className="sp-marquee-preview">
              <span className="sp-marquee-dot" aria-hidden="true" />
              <跑马灯文本
                text="正在执行：把可研报告的结构梳理成清单，并逐条核对数据来源与引用"
                active
                className="sp-marquee-preview-text"
              />
              <small>执行中</small>
            </div>
            <details open className="message-process-fold run-activity-fold is-live sp-activity-marquee-preview">
              <summary><Icon name="flow" size={12} /> 对话执行过程<span>实时</span></summary>
            </details>
          </div>
        </div>
      </div>

      <div className="sp-section" id="settings-conversation">
        <div className="sp-section-title"><Icon name="tool" size={12} /> 对话行为</div>
        <div className="sp-row">
          <span className="sp-label">思考块默认展开</span>
          <input type="checkbox" checked={!!thinkingDefaultOpen} onChange={(e) => setThinkingDefaultOpen(e.target.checked)} />
        </div>
        <div className="sp-row">
          <span className="sp-label">消息目录栏</span>
          <input type="checkbox" checked={showTimeline !== false} onChange={(e) => setShowTimeline(e.target.checked)} />
        </div>
      </div>
      </>}

      {settingsSection === "providers" && (
        <模型设置页
          models={models}
          defaultModel={defaultModel}
          activeModel={activeModel}
          onModelChange={onModelChange}
          onModelsRefresh={onModelsRefresh}
          integration={integration}
        />
      )}

      {settingsSection === "network" && <div className="sp-section" id="settings-network">
        <div className="sp-section-title"><Icon name="globe" size={12} /> 网络与搜索</div>
        <div className="model-credentials-card model-network-card">
          <div className="model-credentials-head">
            <div><strong>模型网络</strong><p>只影响 Pi 模型请求，不改变地图、Office CLI 和浏览器网络。供应商连不通时先看这里。</p></div>
            <span className={`sp-badge ${networkStatus ? "ok" : "warn"}`}>{networkStatus?.mode === "manual" ? "手动代理" : networkStatus?.mode === "system" ? "系统代理" : "直接连接"}</span>
          </div>
          <div className="model-network-grid">
            <label><span>连接方式</span><select className="sp-select" value={networkDraft.mode} onChange={(event) => setNetworkDraft((value) => ({ ...value, mode: event.target.value }))}><option value="direct">直接连接</option><option value="system">读取系统环境代理</option><option value="manual">手动代理</option></select></label>
            {networkDraft.mode === "manual" && <label><span>代理地址</span><input className="sp-input" type="password" value={networkDraft.proxyUrl} onChange={(event) => setNetworkDraft((value) => ({ ...value, proxyUrl: event.target.value }))} placeholder={networkStatus?.hasProxy ? "已保存代理；留空保持不变" : "http://127.0.0.1:端口"} /></label>}
            <label className="model-network-bypass"><span>不使用代理</span><input className="sp-input" value={networkDraft.noProxy} onChange={(event) => setNetworkDraft((value) => ({ ...value, noProxy: event.target.value }))} placeholder="localhost,127.0.0.1,::1" /></label>
            <button className="btn-sm primary" onClick={saveNetworkSettings} disabled={networkSaving}>{networkSaving ? "保存中…" : "保存网络设置"}</button>
          </div>
{networkStatus?.proxy && <div className="model-config-path">当前代理：{networkStatus.proxy}</div>}
          {diagnostics?.network?.proxyFallback && <div className="model-feedback">{diagnostics.network.proxyFallback.message}</div>}
          {networkMsg && <div className="model-feedback">{networkMsg}</div>}
          <div className="sp-note">改这里只影响"连出去"的请求，不改动已配置的供应商与历史会话。供应商与代理是两件事：先在「模型供应商」确认 Key 与协议，再来这里确认能不能连出去。</div>
        </div>
        <div className="model-credentials-card model-network-card">
          <div className="model-credentials-head">
            <div><strong>联网搜索</strong><p>为 Agent 提供 web_search / web_fetch 工具；只影响联网检索，不改变本地文件能力。</p></div>
            {(() => {
              const state = searchMeta.settings?.state;
              const tone = state?.tone === "ok" ? "ok" : state?.tone === "error" ? "error" : "warn";
              return <span className={`sp-badge ${tone}`} title={state?.reason || ""}>{state?.label || "未配置"}</span>;
            })()}
          </div>
          <div className="model-network-grid">
            <label><span>搜索后端</span>
              <select className="sp-select" value={searchDraft.backend} onChange={(event) => setSearchDraft((value) => ({ ...value, backend: event.target.value }))}>
                {(searchMeta.backends.length ? searchMeta.backends : [{ id: "tavily", name: "Tavily" }]).map((backend) => (
                  <option key={backend.id} value={backend.id}>{backend.name}</option>
                ))}
              </select>
            </label>
            <button className="btn-sm" onClick={runSearchTest} disabled={searchTesting} title="测试当前选中的后端；若输入框里有尚未保存的 Key/地址，会用该草稿测试且不写入配置">{searchTesting ? "测试中…" : "测试连接"}</button>
            <button className="btn-sm primary" onClick={saveSearchConfig} disabled={searchSaving}>{searchSaving ? "保存中…" : "保存搜索配置"}</button>
            <button className="btn-sm" onClick={clearSearchCredentials} disabled={searchSaving} title="清除当前后端已保存的凭据/地址">清除凭据</button>
          </div>
          {searchDraft.backend === "tavily" && (
            <div className="model-network-grid">
              <label><span>Tavily API Key</span><input className="sp-input" type="password" value={searchDraft.tavilyKey} onChange={(event) => setSearchDraft((value) => ({ ...value, tavilyKey: event.target.value }))} placeholder={searchMeta.settings?.hasTavilyKey ? `已保存（${searchMeta.settings?.tavilyKeyMasked}）；留空保持不变` : "tvly-..."} /></label>
            </div>
          )}
          {searchDraft.backend === "searxng" && (
            <div className="model-network-grid">
              <label><span>实例地址</span><input className="sp-input" value={searchDraft.searxngUrl} onChange={(event) => setSearchDraft((value) => ({ ...value, searxngUrl: event.target.value }))} placeholder="https://你的-searxng-实例" /></label>
            </div>
          )}
          {searchDraft.backend === "jina" && (
            <div className="model-network-grid">
              <label><span>Jina API Key（可选）</span><input className="sp-input" type="password" value={searchDraft.jinaKey} onChange={(event) => setSearchDraft((value) => ({ ...value, jinaKey: event.target.value }))} placeholder={searchMeta.settings?.hasJinaKey ? `已保存（${searchMeta.settings?.jinaKeyMasked}）` : "留空则免 Key 使用（有频率限制）"} /></label>
            </div>
          )}
          {searchDraft.backend === "bocha" && (
            <div className="model-network-grid">
              <label><span>博查 API Key</span><input className="sp-input" type="password" value={searchDraft.bochaKey} onChange={(event) => setSearchDraft((value) => ({ ...value, bochaKey: event.target.value }))} placeholder={searchMeta.settings?.hasBochaKey ? `已保存（${searchMeta.settings?.bochaKeyMasked}）；留空保持不变` : "sk-..."} /></label>
            </div>
          )}
          <div className="sp-note" style={{ marginTop: 6 }}>
            {searchMeta.backends.find((backend) => backend.id === searchDraft.backend)?.hint || "Tavily 免费 1000 次/月；国内网络可切换博查，或自建 SearXNG。"}
            {searchMeta.backends.find((backend) => backend.id === searchDraft.backend)?.keyUrl ? ` 申请地址：${searchMeta.backends.find((backend) => backend.id === searchDraft.backend).keyUrl}` : ""}
          </div>
          {searchMeta.settings?.state?.reason && (
            <div className={`sp-note ${searchMeta.settings.state.tone === "error" ? "sp-note-error" : ""}`} style={{ marginTop: 6 }}>
              当前状态：{searchMeta.settings.state.reason}
              {searchMeta.settings.state.credentialSource === "env" ? "（凭据来自进程环境变量，不会写入配置文件）" : ""}
              {searchMeta.settings.state.connectivityAt ? ` · 最近测试：${new Date(searchMeta.settings.state.connectivityAt).toLocaleTimeString("zh-CN")}` : ""}
            </div>
          )}
          {searchTestMsg && (
            <div className={`model-feedback ${searchTestInfo?.ok ? "" : "warn"}`}>
              测试结果：{searchTestMsg}
              {searchTestInfo?.testedDraft ? "（本次使用未保存的草稿测试，未写入配置）" : ""}
            </div>
          )}
          {searchSaveMsg && <div className="model-feedback">保存状态：{searchSaveMsg}</div>}
        </div>
        <div className="sp-note">模型网络与联网搜索只影响"连出去"的请求；供应商的协议、Base URL 与 Key 在「模型供应商」页管理。</div>
      </div>}

      {settingsSection === "services" && <>
      <div className="sp-section" id="settings-basemap">
        <div className="sp-section-title"><Icon name="map" size={12} /> 底图服务</div>
        <div className="sp-row">
          <span className="sp-label">天地图 Key</span>
          <input
            className="sp-input"
            type="password"
            placeholder="天地图 tk（https://console.tianditu.gov.cn 申请）"
            value={basemapKeys.tianditu}
            onChange={(e) => setBasemapKeys((s) => ({ ...s, tianditu: e.target.value }))}
          />
          <span className={`sp-badge ${basemapStatus.tianditu ? "ok" : "warn"}`}>
            {basemapStatus.tianditu ? "已配置" : "未配置"}
          </span>
        </div>
        <div className="sp-row">
          <span className="sp-label">MapTiler Key</span>
          <input
            className="sp-input"
            type="password"
            placeholder="MapTiler key（https://cloud.maptiler.com 申请）"
            value={basemapKeys.maptiler}
            onChange={(e) => setBasemapKeys((s) => ({ ...s, maptiler: e.target.value }))}
          />
          <span className={`sp-badge ${basemapStatus.maptiler ? "ok" : "warn"}`}>
            {basemapStatus.maptiler ? "已配置" : "未配置"}
          </span>
        </div>
        <div className="sp-row">
          <span className="sp-label">Geoapify Key</span>
          <input
            className="sp-input"
            type="password"
            placeholder="Geoapify API key（用于等时圈）"
            value={basemapKeys.geoapify}
            onChange={(e) => setBasemapKeys((s) => ({ ...s, geoapify: e.target.value }))}
          />
          <span className={`sp-badge ${basemapStatus.geoapify ? "ok" : "warn"}`}>
            {basemapStatus.geoapify ? "已配置" : "未配置"}
          </span>
        </div>
        <div className="sp-row">
          <span className="sp-label">操作</span>
          <button className="btn-sm primary" onClick={saveBasemaps} disabled={basemapSaving}>
            {basemapSaving ? "保存中…" : "保存底图配置"}
          </button>
          {basemapMsg && <span className="sp-auth-msg">{basemapMsg}</span>}
        </div>
        <div className="sp-note">
          输入 Key 后保存即启用对应底图或等时圈服务；输入框留空保存 = 清除该 Key（对应功能随之停用）。
          高德（路网/卫星/注记）与 Esri（卫星/街道）始终可用，无需 Key。
        </div>
      </div>

      <div className="sp-section" id="settings-services">
        <div className="sp-section-title"><Icon name="cloud" size={12} /> 服务集成</div>
        <div className="sp-row">
          <span className="sp-label">officecli</span>
          <span className={`sp-badge ${integration?.officecli ? "ok" : "warn"}`}>
            {integration?.officecli ? integration.officecli : "未检测到"}
          </span>
        </div>
        <div className="sp-row">
          <span className="sp-label">Geoapify 等时圈</span>
          <span className={`sp-badge ${basemapStatus.geoapify ? "ok" : "warn"}`}>
            {basemapStatus.geoapify ? "已配置" : "未配置"}
          </span>
        </div>
        <div className="sp-row">
          <span className="sp-label">IMA 知识库</span>
          <span className="sp-badge warn">需凭证</span>
        </div>
        <div className="sp-note">等时圈优先使用 Geoapify Key，也兼容服务端 AMAP_KEY；Key 保存后立即生效。</div>
      </div>
      </>}

      {settingsSection === "permission" && <div className="sp-section" id="settings-permission">
        <div className="sp-section-title"><Icon name="shield" size={12} /> 审批与权限</div>
        <div className="sp-note">规则保存在本机全局配置 <code>.oaw/permissions.json</code>，对所有会话、项目和工作区生效，重启后仍然有效。</div>
        <div className="sp-row">
          <span className="sp-label">当前模式</span>
          <strong className="approval-mode-now">{permissionRules?.mode === "auto" ? "自动批准 · 放行原本需询问的操作，deny 规则仍生效" : "每次询问 · 写入与危险操作逐次确认"}</strong>
        </div>
        <div className="sp-section-title" style={{ marginTop: 10 }}><Icon name="list" size={12} /> 已授权的“总是允许”规则</div>
        {!permissionRules ? <div className="sp-note">正在读取…</div>
          : permissionRules.user?.length
            ? <div className="approval-rule-list">{permissionRules.user.map((rule, index) => (
                <div className="approval-rule" key={`${rule.tool}-${rule.pattern}-${index}`}>
                  <span title={`${rule.tool} ${rule.pattern}`}><code>{rule.tool}</code> · <code>{rule.pattern}</code> · {rule.action}</span>
                  <button className="btn-xs" disabled={permissionBusy} onClick={() => revokePermissionRule(rule)}>撤销</button>
                </div>
              ))}</div>
            : <div className="sp-note">暂无“总是允许”规则；审批时选择“总是允许”会在此列出。</div>}
        <div className="sp-note">撤销后，同类操作会立即恢复为逐次询问；既有的拒绝结论不会因为撤销规则而改变。</div>
      </div>}

      {settingsSection === "advanced" && <div className="sp-section" id="settings-advanced">
        <div className="sp-section-title"><Icon name="tool" size={12} /> 重置与诊断</div>
        <div className="model-credentials-card model-diagnostics-card">
          <div className="model-credentials-head">
            <div><strong>连接诊断</strong><p>把“SDK 已加载、模型已配置、凭据已配置、真实调用”分开显示，避免只看到“正在连接模型”。</p></div>
            <button className="btn-sm" onClick={loadDiagnostics} disabled={diagnosticsLoading}><Icon name="refresh" size={12} /> {diagnosticsLoading ? "读取中…" : "刷新诊断"}</button>
          </div>
          {diagnostics ? <>
            <div className="model-diagnostics-grid">
              {diagnosticCards.map((item) => <span key={item.label} className={item.ok ? "ok" : "warn"}><i className={`status-dot ${item.ok ? "" : "idle"}`} /><span>{item.label}</span><strong>{item.value}</strong></span>)}
            </div>
            <div className="model-diagnostics-meta">
              <span>服务 v{diagnostics.service?.version || integration?.version || "未知"} · PID {diagnostics.service?.pid || "未知"}</span>
              <span>Runtime：{diagnosticRuntimeStatus || "未创建"}{diagnostics.runtime?.health?.message ? ` · ${diagnostics.runtime.health.message}` : diagnosticRuntimeReady ? " · 可用" : ""}</span>
              <span>当前模型：{diagnosticModel || "未选择"}</span>
            </div>
            {diagnostics.model?.catalogError && <div className="model-diagnostics-error">模型目录读取失败：{diagnostics.model.catalogError}</div>}
            {diagnosticFailures.length > 0 && <details className="model-diagnostics-failures">
              <summary>最近失败 {diagnosticFailures.length} 条</summary>
              {diagnosticFailures.slice(0, 3).map((failure, index) => <div key={`${failure.requestId || failure.timestamp || "failure"}-${index}`}><code>{failure.errorCode || failure.code || "MODEL_ERROR"}</code><span>{failure.message || "未提供错误信息"}{failure.hint ? ` · ${failure.hint}` : ""}</span></div>)}
            </details>}
          </> : <div className="model-diagnostics-empty">{diagnosticsLoading ? "正在读取服务、模型目录和 Runtime 状态…" : "尚未读取诊断状态"}</div>}
          {diagnosticsMsg && <div className="model-feedback">{diagnosticsMsg}</div>}
          <div className="sp-note">诊断接口只返回版本、状态、错误码和掩码信息，不返回 API Key；Runtime 尚未创建通常表示还没有在当前会话启动 Agent。</div>
        </div>
        <div className="sp-section-title" style={{ marginTop: 12 }}><Icon name="menu" size={12} /> 高级</div>
        <div className="sp-note">命令面板：按 Ctrl/Cmd+K，或点击左侧顶部搜索按钮打开。</div>
        <button className="sp-danger" onClick={resetAll}>重置界面状态与设置</button>
        <div className="sp-note">字体：OPPO Sans 4.0（版权归 Guangdong OPPO Mobile Telecommunications Corp., Ltd. 所有），依据 OPPO Sans Fonts License Agreement 随软件内嵌。</div>
        <div className="sp-note">版本 {version || "v0.10.3"}</div>
      </div>
      }
      </div>
    </div>
  );
}
