import React, { lazy, Suspense, useState, useCallback, useEffect, useRef } from "react";
import SessionSidebar from "./components/SessionSidebar.jsx";
import ChatPanel, { normalizeHistoryMessages } from "./components/ChatPanel.jsx";
import { mergeRunSummaries } from "./运行展示投影.js";
import { applyToolMetadata } from "./工具展示.js";
import Resizer from "./components/Resizer.jsx";
const SkillsManager = lazy(() => import("./components/SkillsManager.jsx"));
const AgentMarket = lazy(() => import("./components/AgentMarket.jsx"));
const IntegrationsCenter = lazy(() => import("./components/IntegrationsCenter.jsx"));
const KnowledgeBase = lazy(() => import("./components/KnowledgeBase.jsx"));
const TemplateLibrary = lazy(() => import("./components/TemplateLibrary.jsx"));
const MapPanel = lazy(() => import("./components/MapPanel.jsx"));
const CommandPalette = lazy(() => import("./components/CommandPalette.jsx"));
// 文档预览依赖 docx-preview / pptxviewjs / x-data-spreadsheet 等重库，按需加载
const DocViewer = lazy(() => import("./components/DocViewer.jsx"));
import Icon from "./components/Icon.jsx";
import { isMotionReduced, useAppearance } from "./界面外观.js";
import Logo from "./components/Logo.jsx";
import TaskCenter from "./components/任务中心.jsx";
import WorkProductPanel, { ArtifactPanel, RunChangesPanel } from "./components/工作产物面板.jsx";
import 画布标签栏 from "./components/画布标签栏.jsx";
import 文件树抽屉 from "./components/文件树抽屉.jsx";
import { isStaleChunkError, recoverFromStaleChunk } from "./分包恢复.js";
import BrowserPanel from "./components/内置浏览器面板.jsx";
import SettingsPanel from "./components/SettingsPanel.jsx";
import MemoryTab from "./components/MemoryTab.jsx";
import 对象栏 from "./components/对象栏.jsx";
import 工作流启动器 from "./components/工作流启动器.jsx";
import 子代理详情面板 from "./components/子代理详情面板.jsx";
import TeamHeaderChip from "./components/TeamHeaderChip.jsx";
import TeamPanel from "./components/TeamPanel.jsx";
import MiniMapPreview from "./components/MiniMapPreview.jsx";
import { createDocTab, createViewTab, createSubagentTab, openCanvasTab, closeCanvasTab, reorderCanvasTabs, loadCanvasState, saveCanvasState, saveCanvasWidth, docTabId } from "./画布状态.js";
import { sideDrawerAllowed } from "./画布抽屉.js";
import { useTheme } from "./theme.jsx";
import { loadUIState, saveUIState } from "./persist-ui.js";
import { acquireStream } from "./长连接预算.js";
import { createGlobalEventsLease } from "./跨标签页流租约.js";
import { listFiles, listModels, refreshModels, listSessions, listProjects, listRuns, listWorkspaces, switchWorkspace, deleteSession, deleteSessions, archiveSession, archiveSessions, renameSession, getSession, getClientId, getTabId, createAgentThread, resumeAgentThread, markAgentEventsRead, forkSession, pinSession, freezeSession, cancelRun, updateSessionMapContext } from "./api.js";
import { buildDocUrls, makeFileIdentity, mergeFileIdentity, fileIdentityKey, identityMatches } from "./文件地址.js";
import { mergeMapContext, normalizeMapView } from "./地图/地图上下文.js";
import FeedbackHost, { notifyError, askConfirm } from "./components/Feedback.jsx";
import 提示气泡 from "./components/提示气泡.jsx";
import { initRuntimeFlags, flag, flagsReady } from "./运行开关.js";
import { watchBuildChange } from "./构建版本.js";

function historyReferences(text = "") {
  const refs = [];
  const seen = new Set();
  const add = (kind, target, source) => {
    const value = String(target || "").trim();
    if (!value) return;
    const id = `history_ref_${kind}_${value}`;
    if (seen.has(id)) return;
    seen.add(id);
    refs.push({ id, kind, target: value, source });
  };
  for (const m of String(text).matchAll(/@(知识库目录|知识库|模板目录|模板|文件)\[([^\]]+)\]/g)) {
    add({"知识库目录":"knowledge_dir", "知识库":"knowledge", "模板目录":"template_dir", "模板":"template", "文件":"file"}[m[1]], m[2], m[0]);
  }
  for (const m of String(text).matchAll(/(^|[\s(])@([^\s@，。！？\]}]+)/g)) {
    const target = m[2].replace(/[),;。！？]+$/, "");
    if (target.includes("/") || target.includes("\\") || /\.(docx|xlsx|pptx|pdf|csv|json|md|markdown|txt|html|htm)$/i.test(target)) add("file", target, `@${target}`);
  }
  for (const m of String(text).matchAll(/&会话\[([^\]]+)\]/g)) add("session", m[1], m[0]);
  return refs;
}

function cleanPersistedMessage(text = "") {
  const source = String(text || "");
  const inlineTaskGoal = source.match(/^#{1,6}\s*当前任务目标\s*[:：]\s*([^\n]+)/i);
  if (inlineTaskGoal?.[1]) return inlineTaskGoal[1].trim();
  const envelopeGoal = source.match(/^\s*#{1,6}\s*当前任务(?:\s+|\n)+(?:目标|任务目标)\s*[:：]\s*([\s\S]*?)(?=(?:\s+|\n)-?\s*(?:模式|引用|输出要求|当前文件|工作流)\s*[:：]|$)/i);
  if (envelopeGoal?.[1]) return envelopeGoal[1].trim();
  const goal = source.match(/(?:^|\n)\s*-?\s*(?:目标|任务目标)\s*[:：]\s*([\s\S]*?)(?=\n\s*-?\s*(?:模式|引用|输出要求|当前文件|工作流)\s*[:：]|$)/i);
  if (goal?.[1]) return goal[1].trim();
  return source.replace(/^##\s*当前任务[\s\S]*?\n边界：[^\n]+\n\n?/i, "").trim();
}

/**
 * 懒加载模块的局部错误边界。
 *
 * 全局 AppErrorBoundary 会把任何模块渲染错误变成整页“应用出错”。懒加载模块
 * （地图、知识库、模板库等）在**前端重建后**最容易因为旧 chunk 失效而抛错，
 * 这时只应影响当前模块，并给用户“重试/刷新”的出口，而不是整站白屏。
 *
 * 分包类错误（isStaleChunkError）沿用一次性自动刷新；普通组件错误则保留在本模块内，
 * 关闭再打开模块即可重新挂载（错误边界随条件渲染卸载而复位）。
 */
class ModuleBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error(`[module:${this.props.label || "模块"}]`, error, info);
    if (isStaleChunkError(error)) recoverFromStaleChunk(error?.message);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const message = this.state.error?.message || "未知错误";
    return (
      <div className="module-error" role="alert">
        <div className="module-error-title">「{this.props.label || "模块"}」加载失败</div>
        <div className="module-error-text">{message}</div>
        <div className="module-error-actions">
          <button type="button" className="btn-sm" onClick={() => this.setState({ error: null })}>重新加载模块</button>
          <button type="button" className="btn-sm" onClick={() => window.location.reload()}>刷新页面</button>
        </div>
      </div>
    );
  }
}

function DeferredModule({ children, label = "模块" }) {
  return (
    <Suspense fallback={<div className="module-loading">正在加载{label}…</div>}>
      <ModuleBoundary label={label}>{children}</ModuleBoundary>
    </Suspense>
  );
}

function RefreshBloom() {
  const [visible, setVisible] = useState(() => !isMotionReduced());
  const [opened, setOpened] = useState(false);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (!visible) return undefined;
    const frame = window.requestAnimationFrame(() => setOpened(true));
    const closeTimer = window.setTimeout(() => setClosing(true), 850);
    const removeTimer = window.setTimeout(() => setVisible(false), 1200);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(closeTimer);
      window.clearTimeout(removeTimer);
    };
  }, [visible]);

  if (!visible) return null;
  return (
    <div className={`app-refresh-bloom ${opened ? "is-open" : ""} ${closing ? "is-closing" : ""}`} aria-hidden="true">
      <Logo size={56} withBackground={false} markColor="currentColor" className="app-refresh-bloom-mark" />
    </div>
  );
}

// 全局错误边界
class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("App error:", error, errorInfo);
    // 分包过期导致的加载失败：自动刷新一次，不再停留在错误页
    if (isStaleChunkError(error)) recoverFromStaleChunk(error?.message);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="app-error">
          <div className="app-error-content">
            <div className="app-error-icon"><Icon name="warning" size={32} /></div>
            <div className="app-error-title">应用出错</div>
            <div className="app-error-text">{this.state.error?.message || "未知错误"}</div>
            <button className="btn primary" onClick={() => window.location.reload()}>
              刷新页面
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

let histSeq = 0;
const histId = () => `h${++histSeq}`;

function historyImageData(block) {
  if (!block) return null;
  const source = block.source || block.image || block;
  const data = source?.data || block.data || source?.url || block.url;
  if (!data) return null;
  if (String(data).startsWith("data:")) return String(data);
  const mediaType = source?.mediaType || source?.mimeType || block.mediaType || block.mimeType || "image/png";
  return `data:${mediaType};base64,${data}`;
}

function entryCreatedAt(entry, message) {
  return entry?.timestamp || entry?.createdAt || entry?.time || message?.timestamp || message?.createdAt || null;
}

// v0.12.5：历史消息映射抽成纯函数，首屏与“加载更早”共用同一份规则。
// entryId/parentId 保留 Pi 会话树坐标，供编辑/分叉/regenerate 精确定位。
function buildHistoryMessages(entries = []) {
  const msgs = [];
  const toolBlocks = new Map();
  for (const e of entries) {
    if (e.type !== "message" || !e.message) continue;
    const m = e.message;
    const role = m.role === "assistant" ? "assistant" : m.role === "user" ? "user" : m.role;
    if (role === "toolResult" || role === "tool_result") {
      const output = typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content.filter((b) => b?.type === "text").map((b) => b.text || "").join("\n")
          : JSON.stringify(m.content || m.output || "", null, 2);
      const block = toolBlocks.get(m.toolCallId);
      if (block) {
        block.output = output;
        block.result = output;
        block.done = true;
        block.isError = !!m.isError;
      } else {
        // 老会话可能没有可配对的 toolCallId：挂到最近一条 Agent 消息，仍不显示为用户消息。
        const lastAssistant = [...msgs].reverse().find((item) => item.role === "assistant");
        if (lastAssistant) lastAssistant.blocks.push({
          type: "tool", id: histId(), name: m.toolName || "tool result", input: "",
          output, result: output, done: true, isError: !!m.isError, duration: null,
        });
      }
      continue;
    }
    if (role !== "assistant" && role !== "user") continue;
    let text = "";
    const blocks = [];
    const images = [];
    if (typeof m.content === "string") text = m.content;
    else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === "text" || b.type === "input_text") text += (text ? "\n" : "") + (b.text || b.content || "");
        else if (b.type === "image" || b.type === "input_image") {
          const src = historyImageData(b);
          if (src) images.push(src);
        } else if (b.type === "thinking") {
          // 空 thinking（只有签名/被省略内容）不能变成一条展开后全白的思考行。
          const thinkingText = b.thinking || b.text || "";
          if (String(thinkingText).trim()) blocks.push({ type: "thinking", text: thinkingText });
        }
        else if (b.type === "toolCall") {
          const callId = b.id || b.toolCallId || histId();
          const rawInput = b.input ?? b.arguments ?? b.params ?? "";
          const input = typeof rawInput === "string" ? rawInput : JSON.stringify(rawInput, null, 2);
          const block = {
            type: "tool", id: callId, name: b.toolName || b.name || "tool", input,
            output: "", result: "", done: false, isError: false, duration: null,
          };
          blocks.push(block);
          toolBlocks.set(callId, block);
        }
      }
    }
    // 若 assistant 有纯文本且没有 text block，追加为文本块；用户消息仍保留原始文本。
    if (role === "assistant" && text && !blocks.some((b) => b.type === "text")) blocks.push({ type: "text", text });
    const displayText = role === "user" ? cleanPersistedMessage(text) : text;
    // 任务封装里的“当前工作文件: （无）”只是占位，不是真实文件；否则恢复会话后
    // 用户气泡会凭空多出一行“当前文件:（无）”，与实时态不一致。
    const currentDocMatch = text.match(/当前(?:打开|工作)文件:\s*([^\]\n]+)/);
    const currentDocValue = currentDocMatch?.[1]?.trim() || "";
    const currentDoc = /^(?:[（(]无[）)]|none|null|[—-])$/i.test(currentDocValue) ? null : currentDocValue || null;
    // 历史 assistant 条目自带当轮 provider/model；带上它，恢复后不会被当前选中的模型覆盖。
    const entryModel = role === "assistant" && m.provider && m.model ? `${m.provider}/${m.model}` : (m.model || "");
    msgs.push({
      id: e.id, role, text: displayText, images, blocks, references: historyReferences(text),
      currentDoc, status: "done", createdAt: entryCreatedAt(e, m), model: entryModel,
      entryId: e.id || null, parentId: e.parentId || null,
    });
  }
  return msgs;
}

/**
 * Run 摘要卡（"本轮任务完成/失败…"）转成消息。
 *
 * 首屏与"加载更早"必须共用同一份规则：此前分页路径漏了这一步，
 * 旧页缺 runSummary 会让 associateRunMessages 找不到本轮 Run，
 * 已加载的旧轮次因此退回旧渲染形态（与首屏不一致）。
 *
 * @param {Array} runs listRuns 返回的 Run 列表
 * @returns {Array} 可直接交给 mergeRunSummaries 的摘要消息
 */
function readableRunError(error) {
  const raw = String(error || "").trim();
  if (!raw) return "";
  const message = raw.match(/"message"\s*:\s*"([^"]+)"/)?.[1] || "";
  const status = raw.match(/\b(?:4|5)\d\d\b/)?.[0] || "";
  if (message) return [status, message].filter(Boolean).join(" ");
  return raw.replace(/\s+/g, " ").slice(0, 240);
}

/** 失败摘要只有泛化文案时，把 Run 的真实错误带到卡片上，避免用户只看到“任务执行失败”。 */
function failedRunSummary(run = {}) {
  if (run.status !== "failed") return "";
  const current = String(run.summary || "").trim();
  if (current && current !== "任务执行失败") return "";
  const reason = readableRunError(run.error || run.completion?.error);
  return reason ? `任务执行失败：${reason}` : "";
}

function buildRunSummaryMessages(runs = []) {  return [...(runs || [])]
    .filter((run) => run?.status)
    .filter((run, index, list) => list.findIndex((item) => item.id === run.id) === index)
    .sort((a, b) => String(a.startedAt || "").localeCompare(String(b.startedAt || "")))
    .map((run, index, list) => ({
      id: `run-summary-${run.id}`,
      role: "system",
      text: failedRunSummary(run) || run.summary || run.finalText || (run.status === "running" ? "本轮任务仍在执行中" : `本轮任务${run.status === "failed" ? "失败" : run.status === "cancelled" ? "已取消" : "完成"}，处理 ${run.artifactCount ?? run.artifacts?.length ?? 0} 个文件`),
      error: run.error || run.completion?.error || "",
      products: (run.artifacts || []).map((a) => a.path).filter(Boolean),
      artifacts: run.artifacts || [],
      runId: run.id,
      runStatus: run.status,
      references: run.references || [],
      task: run.task || null,
      status: run.status === "running" ? "streaming" : "done",
      summary: true,
      runIndex: index + 1,
      runCount: list.length,
      runMode: run.task?.mode || "agent",
      // 完成语义：显式 complete_task 或服务端推断结果；失败时补真实错误，卡片不再只显示泛化文案。
      completion: (() => {
        const failure = failedRunSummary(run);
        return failure
          ? { ...(run.completion || { status: "failed", source: "inferred" }), summary: failure }
          : (run.completion || null);
      })(),
      finalText: run.finalText || "",
      summarySource: run.summarySource || "",
      durationMs: Number(run.durationMs) || 0,
      stepCount: Number(run.stepCount) || 0,
      toolCount: Number(run.toolCount) || 0,
      artifactCount: Number(run.artifactCount) || (run.artifacts?.length || 0),
      eventCount: Array.isArray(run.events) ? run.events.length : 0,
      // 历史首屏不拉完整事件：listRuns 的 includeEvents 默认只给活跃 Run 与最新一条，
      // 这里也只消费已随列表返回的 events（多数为空），展开过程时再按 runId 拉取，
      // 避免一次传输 2–3MB 事件流。
      events: Array.isArray(run.events) ? run.events.map((event, eventIndex) => ({
        ...event,
        key: `history:${run.id}:${event.seq || eventIndex}`,
      })) : [],
      expanded: true,
      startedAt: run.startedAt || null,
      finishedAt: run.finishedAt || null,
      createdAt: run.finishedAt || run.startedAt || null,
    }));
}

/**
 * 孤儿尾部补卡（2026-11-06）：取消/中断后仍会有 assistant 消息继续落盘，但它们晚于
 * 最后一次 Run 的 finishedAt，没有任何 Run 记录可归属 → `associateRunMessages` 找不到
 * 本轮，于是**每条消息各自退回一个「思考与工具过程」折叠头**（实测：取消后 6 条消息
 * 各成一个折叠块，界面完全变形）。这里为「最后一张运行卡之后的 assistant」合成一张
 * 「运行记录缺失（可能被中断）」卡，让这些消息归到同一轮，只渲染一个折叠头。
 */
function buildOrphanRunCards(messages = [], runCards = []) {
  const timeOf = (value) => Date.parse(value || "") || 0;
  const lastEnd = (Array.isArray(runCards) ? runCards : [])
    .reduce((max, card) => Math.max(max, timeOf(card?.finishedAt || card?.startedAt)), 0);
  const orphans = (Array.isArray(messages) ? messages : [])
    .filter((message) => message?.role === "assistant" && (!lastEnd || timeOf(message.createdAt) > lastEnd));
  if (!orphans.length) return [];
  const first = orphans[0];
  const last = orphans[orphans.length - 1];
  const runId = `run-orphan-${String(first.id || last.id || "tail")}`;
  return [{
    id: `run-summary-${runId}`,
    role: "system",
    summary: true,
    runId,
    runStatus: "cancelled",
    text: "本轮运行记录缺失（可能被中断），以下是过程与结论。",
    status: "done",
    runMode: "agent",
    completion: null,
    events: [],
    artifacts: [],
    references: [],
    task: null,
    startedAt: first.createdAt || null,
    finishedAt: last.createdAt || null,
    createdAt: last.createdAt || null,
    durationMs: 0,
    stepCount: orphans.length,
    toolCount: 0,
    artifactCount: 0,
    eventCount: 0,
    runIndex: (Array.isArray(runCards) ? runCards.length : 0) + 1,
    runCount: (Array.isArray(runCards) ? runCards.length : 0) + 1,
    synthetic: true,
  }];
}

function sameWorkspacePath(a, b) {
  if (!a || !b) return false;
  const normalize = (value) => String(value).replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase();
  return normalize(a) === normalize(b);
}

// 取路径末段作为文件树匹配键：Agent 产物路径可能是绝对/相对/带子目录，
// 文件树只显示当前目录的文件，用末段名做短时高亮匹配最稳（仅用于视觉提示，不参与业务判断）。
function fileBasename(value) {
  const parts = String(value || "").replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

// 路径末段：工作区面板只显示目录名，完整路径放 title。
function pathBaseName(value) {
  const text = String(value || "").replace(/[\\/]+$/, "");
  return text.split(/[\\/]/).pop() || text;
}

const GLOBAL_EVENT_NOTICES = new Set(["run_finished", "run_recovered", "run_cancel_requested", "agent_error", "ask_user"]);
// 启动加载分区文案：失败提示与重试按钮按分区说明，避免只报一句笼统错误。
const LOAD_SCOPE_LABELS = { files: "文件列表", sessions: "会话列表", projects: "项目列表", workspaces: "工作区列表" };

// 文件列表的瞬时错误：服务端已能区分 503/timeout/权限；这类错误先重试一次，
// 不直接弹“读取失败”。404 单独处理为“目录已不存在”，回到工作区根目录。
function isTransientFilesError(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || "");
  return code === "FILES_TRANSIENT"
    || /HTTP 5\d\d/.test(message)
    || /未响应|连接被后台长连接占满|Failed to fetch|network/i.test(message);
}

function isNotFoundFilesError(error) {
  return String(error?.code || "") === "FILES_NOT_FOUND" || /HTTP 404/.test(String(error?.message || ""));
}

const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

export default function App() {
  const [files, setFiles] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [unreadByThread, setUnreadByThread] = useState({});
  const [eventVersion, setEventVersion] = useState(0);
  const [artifactVersion, setArtifactVersion] = useState(0);
  const [tabs, setTabs] = useState([]); // [{ id, name, identity, kind, url?, sheets?, grids?, content? }]
  const [activeTab, setActiveTab] = useState(null); // 当前激活标签的 id（工作区 + 相对路径）
  const current = activeTab ? tabs.find((t) => (t.id || t.name) === activeTab) || null : null;
  // 侧栏“主动收起”偏好：只有用户在宽屏下主动收起才在刷新后保留。
  // 旧版本把窄屏自动收起也写成 sidebarOpen:false，刷新后侧栏会一直消失；
  // 缺 marker 的旧状态按展开处理，让已经“消失”的侧栏自动回来。
  const sidebarManualCollapsedRef = useRef(loadUIState()?.sidebarManualCollapsed === true);
  const [sidebarOpen, setSidebarOpen] = useState(() => !sidebarManualCollapsedRef.current);
  const [activeModule, setActiveModule] = useState(null); // 0.10 统一模块入口
  const [settingsModuleTab, setSettingsModuleTab] = useState("settings");
  const [settingsSection, setSettingsSection] = useState("model");
  const [mapChatVisible, setMapChatVisible] = useState(true); // 地图模式保留 Agent 对话，可独立隐藏
  // B03：右栏页签（预览 / 改动 / 产物）；改动与产物默认看“本轮”，可切回“会话”
  const [changesRunId, setChangesRunId] = useState("");
  const [artifactScope, setArtifactScope] = useState("session");
  const [artifactSegment, setArtifactSegment] = useState("artifacts");
  // 自动打开被“用户正在看别的文件/正在输入”挡住时，记录新产物入口，避免静默丢失。
  const [artifactNotice, setArtifactNotice] = useState(null); // { path, name, runId, at }
  const [browserFullscreen, setBrowserFullscreen] = useState(false);
  // Agent Teams：ChatPanel 的 team_* 事件投影；顶栏 chip 与画布“团队”标签共用。
  const [agentTeam, setAgentTeam] = useState(null);
  const teamSourceRef = useRef("event");
  const teamDismissedRef = useRef("");
  const teamTabIdRef = useRef("");
  const handleTeamChange = useCallback((next, meta = {}) => {
    teamSourceRef.current = meta?.source === "hydrate" ? "hydrate" : "event";
    setAgentTeam(next || null);
  }, []);
  // 工作区画布：一个容器 + 浏览器式标签，取代 previewOpen/browserPanelOpen/filesTabOpen/newchatTabOpen 四个独立开关。
  const [canvasTabs, setCanvasTabs] = useState([]);
  const [canvasActiveId, setCanvasActiveId] = useState("");
  const [canvasCollapsed, setCanvasCollapsed] = useState(false);
  const [canvasMaximized, setCanvasMaximized] = useState(false);
  const [canvasSideOpen, setCanvasSideOpen] = useState(false);
  const [canvasBooted, setCanvasBooted] = useState(false);
  const pendingDocRestoreRef = useRef([]);
  const pendingActiveCanvasIdRef = useRef("");
  const openDocRef = useRef(null);
  const canvasTabsRef = useRef([]);
  const canvasOpen = canvasTabs.length > 0 && !canvasCollapsed;
  const activeCanvasTab = canvasTabs.find((tab) => tab.id === canvasActiveId) || canvasTabs[canvasTabs.length - 1] || null;
  const workspaceTab = activeCanvasTab?.kind || "";
  const browserOpen = canvasTabs.some((tab) => tab.kind === "browser");
  const objectsOpen = canvasTabs.some((tab) => tab.kind === "objects");
  const workflowsOpen = canvasTabs.some((tab) => tab.kind === "workflows");
  const mapPreviewTab = canvasTabs.find((tab) => tab.kind === "mapPreview") || null;
  // 地图文件（agent 写入/用户保存）变更时递增；只影响预览刷新，不重挂 MapViewer。
  const [mapPreviewRevision, setMapPreviewRevision] = useState(0);
  // 文件树抽屉只服务文档/产物/改动；切到浏览器/对象/工作流/地图预览时自动收起，切回允许的标签再恢复。
  const canvasSideVisible = canvasSideOpen && sideDrawerAllowed(activeCanvasTab?.kind);
  const canvasSideOpenRef = useRef(canvasSideOpen);
  canvasSideOpenRef.current = canvasSideOpen;
  const previousCanvasKindRef = useRef(activeCanvasTab?.kind || "");
  const sideOpenBeforeHideRef = useRef(false);
  useEffect(() => {
    const kind = activeCanvasTab?.kind || "";
    const previous = previousCanvasKindRef.current;
    if (kind === previous) return;
    previousCanvasKindRef.current = kind;
    if (!sideDrawerAllowed(kind)) {
      if (canvasSideOpenRef.current) {
        sideOpenBeforeHideRef.current = true;
        setCanvasSideOpen(false);
      }
      return;
    }
    if (sideOpenBeforeHideRef.current) {
      sideOpenBeforeHideRef.current = false;
      setCanvasSideOpen(true);
    }
  }, [activeCanvasTab?.kind]);
  // 用户手动关掉浏览器侧栏后，本轮不再自动弹开（否则每个 browser_* 工具都会把它重新拉起来）。
  const browserAutoOpenBlockedRef = useRef(false);
  // 运行开关快照到达后的重渲染触发器（值本身不参与渲染，只用来让 flag() 派生的状态重算）。
  const [, setFlagsTick] = useState(0);

  // 反馈基座/运行开关：挂载即拉取 /api/status 的 runtimeFlags 快照；拉取失败保持全关（= 基线行为）。
  useEffect(() => {
    initRuntimeFlags().then(() => {
      // Qoder P0-4（开关 qoderStyle，默认关）：仅在开关打开时给 <html> 打标，
      // 由 styles.css 末尾的 opt-in 令牌层接管配色；关掉即移除标记，外观立即回到 pi-dark 基线。
      const root = document.documentElement;
      if (flag("qoderStyle")) root.setAttribute("data-oaw-style", "qoder");
      else root.removeAttribute("data-oaw-style");
      // P2-4（开关 visualEffectsOff，默认关）：打开时给 <html> 打标，
      // 由 styles.css 末尾的特效降级块去掉背景模糊与长动效；关掉即移除标记、特效立即恢复。
      if (flag("visualEffectsOff")) root.setAttribute("data-visual-effects", "off");
      else root.removeAttribute("data-visual-effects");
      // 快照到达后触发一次重渲染：P1-8 对象栏等由 flag() 派生出的 React 状态需要重算
      // （快照到达前 flag() 一律为关，不重算就会一直停在「关闭」分支）。
      setFlagsTick((value) => value + 1);
    });
  }, []);

  useEffect(() => {
    canvasTabsRef.current = canvasTabs;
  }, [canvasTabs]);

  // 工具展示映射（verb / icon）：唯一事实源是服务端 工具元数据.presentation，
  // 经 /api/harness/tools 下发。拉取失败静默，工具卡回落 ChatPanel 内置映射。
  useEffect(() => {
    let cancelled = false;
    fetch("/api/harness/tools")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && Array.isArray(data?.tools)) applyToolMetadata(data.tools);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!browserOpen) setBrowserFullscreen(false);
  }, [browserOpen]);

  // ≤768px 时侧栏与画布都是覆盖层：自动收起抽屉，避免盖住对话输入区。
  // 自动收起不算用户的“主动收起”偏好；回到宽屏时若用户没主动收起就自动恢复。
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const enforceNarrowLayout = () => {
      if (window.innerWidth <= 768) setSidebarOpen(false);
      else if (!sidebarManualCollapsedRef.current) setSidebarOpen(true);
    };
    enforceNarrowLayout();
    window.addEventListener("resize", enforceNarrowLayout);
    return () => window.removeEventListener("resize", enforceNarrowLayout);
  }, []);
  const [conversationMode, setConversationMode] = useState("chat");
  const [conversationPhase, setConversationPhase] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(false); // 命令面板（Ctrl/Cmd+K）
  const [clientId] = useState(getClientId);
  const [threadId, setThreadId] = useState(() => {
    const saved = localStorage.getItem("oaw_thread_id");
    if (saved) return saved;
    const id = `thread-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
    localStorage.setItem("oaw_thread_id", id);
    return id;
  });
  const [mapContexts, setMapContexts] = useState({});
  const currentMapContext = mapContexts[threadId] || null;
  const currentMapProject = currentMapContext?.mapProject || "zhejiang-map";
  // 主界面只要会话已绑定地图，也必须把项目/视口交给 Agent；否则地图工具会回退
  // zhejiang-map，预览里的项目永远收不到改动。地图模块保留默认项目兜底。
  const boundMapProject = activeModule === "map"
    ? currentMapProject
    : String(currentMapContext?.mapProject || "");
  // 地图会话持久化：记录上次成功写入的 payload，避免每 30s 刷新重复写 header。
  const mapPersistRef = useRef({ last: "" });

  const canvasTabManualAtRef = useRef(0); // 用户最近一次手动切换画布标签的时间
  const focusCanvasAfterCloseRef = useRef(false);
  const [browserActivityPing, setBrowserActivityPing] = useState(0); // 手关浏览器后的活动徽标
  const [canvasWidth, setCanvasWidth] = useState(420);
  const [canvasSideWidth, setCanvasSideWidth] = useState(260);

  const openCanvasView = useCallback((kind, payload = {}) => {
    const tab = createViewTab(kind, payload);
    setCanvasTabs((prev) => openCanvasTab(prev, tab).tabs);
    setCanvasActiveId(tab.id);
    setCanvasCollapsed(false);
  }, []);

  const openTeamTab = useCallback(() => {
    if (!agentTeam) return;
    teamDismissedRef.current = "";
    const tab = createViewTab("team", { teamId: agentTeam.id });
    tab.badge = agentTeam.status === "closed" ? undefined : (agentTeam.counts?.activeMembers ?? 1);
    tab.badgeTitle = `团队 ${agentTeam.counts?.activeMembers || 0}/${agentTeam.counts?.members || 0}`;
    tab.alert = ["attention", "failed"].includes(String(agentTeam.status || ""));
    setCanvasTabs((prev) => openCanvasTab(prev, tab).tabs);
    setCanvasActiveId(tab.id);
    setCanvasCollapsed(false);
    window.setTimeout(() => {
      const title = document.getElementById("team-panel-title");
      if (title) title.focus();
    }, 40);
  }, [agentTeam]);

  // 团队标签跟随当前 Run：自动补建但不抢焦点；用户显式关闭后只通过 chip 重开。
  useEffect(() => {
    if (!agentTeam?.id) {
      setCanvasTabs((prev) => prev.filter((tab) => tab.kind !== "team"));
      setCanvasActiveId((prev) => (prev === "view:team" ? "" : prev));
      teamTabIdRef.current = "";
      return;
    }
    if (teamTabIdRef.current !== agentTeam.id) {
      teamTabIdRef.current = agentTeam.id;
      teamDismissedRef.current = "";
    }
    const hadTabs = canvasTabsRef.current.length > 0;
    // 刷新/切回会话时从历史事件恢复团队：画布原本没有其他标签就主动展示团队面板，
    // 否则用户会以为“刷新后团队消失了”。实时 team_started 仍然不抢焦点。
    const shouldAutoOpen = teamSourceRef.current === "hydrate" && !hadTabs;
    const badge = agentTeam.status === "closed" ? undefined : (agentTeam.counts?.activeMembers ?? 1);
    const alert = ["attention", "failed"].includes(String(agentTeam.status || ""));
    setCanvasTabs((prev) => {
      const existing = prev.find((tab) => tab.kind === "team");
      if (existing) {
        return prev.map((tab) => tab.kind === "team"
          ? { ...tab, badge, badgeTitle: `团队 ${badge}/${agentTeam.counts?.members || 0}`, alert }
          : tab);
      }
      if (teamDismissedRef.current === agentTeam.id) return prev;
      const tab = createViewTab("team", { teamId: agentTeam.id });
      tab.badge = badge;
      tab.badgeTitle = `团队 ${badge}/${agentTeam.counts?.members || 0}`;
      tab.alert = alert;
      return openCanvasTab(prev, tab).tabs;
    });
    if (shouldAutoOpen) {
      setCanvasActiveId("view:team");
      setCanvasCollapsed(false);
    } else if (!hadTabs) {
      // 实时 team_started：只出现 chip，不等同于“打开画布”，保留收起状态。
      setCanvasCollapsed(true);
    }
    // canvasBooted：刷新时画布恢复会先整体替换 tabs，团队标签要在恢复完成后补回来。
    // 注意不要依赖 currentWorkspace：它在本组件更后面才声明，放进依赖数组会触发 TDZ。
  }, [agentTeam, canvasBooted]);

  const activateCanvasTabById = useCallback((id) => {
    if (!id) return;
    canvasTabManualAtRef.current = Date.now();
    setCanvasActiveId(id);
    setCanvasCollapsed(false);
  }, []);

  const closeCanvasTabById = useCallback(async (id) => {
    const tab = canvasTabs.find((item) => item.id === id);
    if (tab?.kind === "doc" && tab.dirty) {
      const ok = await askConfirm(`「${tab.title || "文档"}」有未保存修改，仍要关闭吗？`);
      if (!ok) return;
    }
    const result = closeCanvasTab(canvasTabs, canvasActiveId, id);
    setCanvasTabs(result.tabs);
    setCanvasActiveId(result.activeId);
    if (tab?.kind === "team") {
      // 关闭只销毁视图，不结束团队；同一 Run 内不自动复活，chip 可重新打开。
      teamDismissedRef.current = agentTeam?.id || tab.payload?.teamId || "";
    }
    if (tab?.kind === "doc") {
      if (activeTab === tab.docId) {
        if (docAbortRef.current) { try { docAbortRef.current.abort(); } catch {} docAbortRef.current = null; }
        docRequestSeqRef.current += 1;
      }
      setTabs((prev) => prev.filter((item) => (item.id || item.name) !== tab.docId));
    }
    if (tab?.kind === "browser") {
      browserAutoOpenBlockedRef.current = true;
      setBrowserFullscreen(false);
    }
    focusCanvasAfterCloseRef.current = true;
  }, [activeTab, canvasActiveId, canvasTabs, agentTeam?.id]);

  useEffect(() => {
    if (!focusCanvasAfterCloseRef.current) return;
    focusCanvasAfterCloseRef.current = false;
    const nextTab = canvasActiveId ? document.querySelector(".canvas-tab.active .canvas-tab-main") : null;
    (nextTab || previewToggleRef.current)?.focus?.();
  }, [canvasActiveId, canvasTabs]);

  const handleDocDirtyChange = useCallback((dirty) => {
    const docId = activeTab;
    if (!docId) return;
    setCanvasTabs((prev) => prev.map((tab) => (
      tab.kind === "doc" && tab.docId === docId ? { ...tab, dirty: Boolean(dirty) } : tab
    )));
  }, [activeTab]);

  const clearDocumentTabs = useCallback(() => {
    setTabs([]);
    setActiveTab(null);
    setCanvasTabs((prev) => prev.filter((tab) => tab.kind !== "doc"));
    setCanvasActiveId((prev) => (String(prev || "").startsWith("doc:") ? "" : prev));
  }, []);

  useEffect(() => {
    const tab = canvasTabs.find((item) => item.id === canvasActiveId);
    if (tab?.kind === "doc" && tab.docId && activeTab !== tab.docId) setActiveTab(tab.docId);
  }, [activeTab, canvasActiveId, canvasTabs]);

  const handleBrowserActivity = useCallback(() => {
    if (browserAutoOpenBlockedRef.current) {
      // O-P3（OAW_BROWSER_BADGE，默认关）：手关后不再静默丢弃本轮浏览器活动，顶栏开关亮徽标
      if (flag("browserBadge")) setBrowserActivityPing((value) => value + 1);
      return;
    }
    setBrowserActivityPing(0);
    openCanvasView("browser");
  }, [openCanvasView]);

  const closeBrowserPanel = useCallback(() => {
    browserAutoOpenBlockedRef.current = true;
    closeCanvasTabById("view:browser");
  }, [closeCanvasTabById]);



  const [models, setModels] = useState([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [selectedModel, setSelectedModel] = useState(() => localStorage.getItem("oaw_model") || "");
  const [workspaces, setWorkspaces] = useState([]);
  const [projects, setProjects] = useState([]);
  const [currentWorkspace, setCurrentWorkspace] = useState("");
  // 启动加载状态：files/sessions/projects/workspaces 各自记录 ready/error，
  // 失败时保留上一次可用数据并给出可重试的提示，而不是静默伪装成空结果。
  const [loadStatus, setLoadStatus] = useState({ files: "loading", sessions: "loading", projects: "loading", workspaces: "loading" });
  const [loadErrors, setLoadErrors] = useState({});
  // 构建版本守卫：服务端换了新构建就提示刷新（dist 保留历史包，旧页面不会自己失效）。
  const [staleBuild, setStaleBuild] = useState(null);
  useEffect(() => watchBuildChange((info) => setStaleBuild(info)), []);
  const currentProject = projects.find((project) => sameWorkspacePath(project.rootPath, currentWorkspace)) || null;

  const canvasRestoreRef = useRef("");
  useEffect(() => {
    if (!currentWorkspace || canvasRestoreRef.current === currentWorkspace) return;
    canvasRestoreRef.current = currentWorkspace;
    const saved = loadCanvasState(currentWorkspace);
    const savedDocs = (saved.tabs || []).filter((tab) => tab.kind === "doc" && tab.payload?.name).map((tab) => String(tab.payload.name));
    pendingDocRestoreRef.current = savedDocs;
    pendingActiveCanvasIdRef.current = saved.activeId || "";
    const allowed = (saved.tabs || [])
      .filter((tab) => tab.kind !== "doc" && tab.kind !== "subagent")
      .filter((tab) => tab.kind !== "objects" || flag("qoderObjectBar"))
      .filter((tab) => tab.kind !== "workflows" || flag("domainWorkflows"));
    setCanvasTabs(allowed);
    setCanvasActiveId(saved.activeId && allowed.some((tab) => tab.id === saved.activeId) ? saved.activeId : (allowed[allowed.length - 1]?.id || ""));
    setCanvasMaximized(Boolean(saved.maximized));
    setCanvasSideOpen(saved.side?.kind === "files");
    setCanvasWidth(saved.width || 420);
    setCanvasSideWidth(saved.sideWidth || 260);
    try {
      document.documentElement.style.setProperty("--canvas-w", `${saved.width || 420}px`);
      document.documentElement.style.setProperty("--canvas-side-w", `${saved.sideWidth || 260}px`);
    } catch {}
    setCanvasBooted(true);
  }, [currentWorkspace]);

  useEffect(() => {
    if (!canvasBooted || !currentWorkspace) return;
    saveCanvasState(currentWorkspace, {
      tabs: canvasTabs,
      activeId: canvasActiveId,
      maximized: canvasMaximized,
      side: { kind: canvasSideOpen ? "files" : null, width: canvasSideWidth },
      width: canvasWidth,
      sideWidth: canvasSideWidth,
    });
  }, [canvasActiveId, canvasBooted, canvasMaximized, canvasSideOpen, canvasSideWidth, canvasTabs, canvasWidth, currentWorkspace]);
  const [currentDir, setCurrentDir] = useState(""); // 相对路径子目录
  const currentDirRef = useRef(""); // 与 currentDir 同步的最新值，供无参 refreshFiles 使用
  const currentWorkspaceRef = useRef(""); // 与 currentWorkspace 同步：文件请求必须带上它，避免用旧闭包值
  const filesRef = useRef([]); // 与 files 同步：工作区切换失败时用它恢复原列表，不给回调加 files 依赖
  const [changedFiles, setChangedFiles] = useState(() => new Set()); // 本轮刚被改动的文件名（短时高亮文件树）
  const [historyMessages, setHistoryMessages] = useState(null); // 加载的历史会话消息
  const [historyThreadId, setHistoryThreadId] = useState(null); // 当前历史消息对应的 thread，避免切换 effect 覆盖恢复内容
  // OAW_REPLAY_RECOVER（F2，默认关）：冷启动探测到保存的 thread 仍有执行中的 Run 时，
  // 提示用户可加载该会话完整历史（不改动「刷新不自动恢复会话」的已批准规则，仅补运行中例外入口）。
  const [restoredRunHint, setRestoredRunHint] = useState(null);
  const restoredRunProbedRef = useRef(false);
  const [historyWindow, setHistoryWindow] = useState(null); // 服务端为长会话返回的展示窗口信息
  // 历史会话切换中的加载态：缓存未命中时用它驱动骨架屏，替代此前的空白等待。
  const [historyLoading, setHistoryLoading] = useState(false);
  // v0.13.2：当前会话已加载助手消息里的外部链接（ChatPanel 提取，Links 页签展示）。
  const [chatLinks, setChatLinks] = useState([]);
  const [sessionResumeError, setSessionResumeError] = useState(null); // { sessionId, message } Agent 恢复失败时历史只读
  // 历史可以先展示，但只有 Agent 恢复成功后才允许发送/连接对话流；
  // 否则 SSE 可能在恢复完成前创建一个新的空 runtime。
  const [agentReady, setAgentReady] = useState(true);
  // 新建会话的进行中/失败状态（交互 2）：失败必须可见，且不得清空旧会话。
  const [creatingSession, setCreatingSession] = useState(false);
  const [newSessionError, setNewSessionError] = useState(null); // { message, workspace }
  // 工作区切换失败（交互 8）：保留原状态并提示原因，不再静默 refreshFiles。
  const [workspaceSwitchError, setWorkspaceSwitchError] = useState(null); // { message, workspace }
  const [sessionResumeRetrying, setSessionResumeRetrying] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState(null); // 当前会话 id（用于界面恢复）
  const currentSession = sessions.find((session) => session.id === currentSessionId) || null;
  // 团队清空由 ChatPanel 的 thread 切换统一负责（它就是投影来源）；App 不再按
  // currentSessionId 二次清空，避免与 ChatPanel 恢复/拉取团队的事件竞争。
  const [docLoading, setDocLoading] = useState(false); // 文档加载中
  const restoredRef = useRef(false); // 界面状态恢复标记（避免重复/过早保存）
  const sessionsRef = useRef([]);
  const sessionsRefreshRef = useRef(null);
  // 刷新在飞又收到 Run 事件时的补刷标记与复用 promise（多任务运行动画跟随）。
  const sessionsRefreshPendingRef = useRef(false);
  const sessionsRefreshRequeuedPromiseRef = useRef(null);
  const projectsRefreshRef = useRef(null);
  const eventRefreshTimerRef = useRef(null);
  const eventBatchTimerRef = useRef(null);
  const eventBatchRef = useRef({ updates: 0, artifacts: 0 });
  const sessionHistoryCacheRef = useRef(new Map());
  const sessionHistoryMetaRef = useRef(new Map());
  // v0.12.5：每个会话的“加载更早”游标（before 指向服务端 active-leaf 条目下标）。
  const sessionHistoryCursorRef = useRef(new Map());
  const chatInputRef = useRef(null); // 引用 ChatPanel 输入框（@ 按钮插入）
  const mapBridgeRef = useRef(null); // 地图模式复用同一个 ChatPanel，保持消息与 SSE 事件流连续
  const sessionLoadSeqRef = useRef(0);
  const workspaceSwitchSeqRef = useRef(0);
  // 统一导航代际（交互 8）：项目/工作区/会话/新建共享一条失效边界；
  // 任一导航都会推进它，异步返回后若不匹配就丢弃，避免逆序响应互相覆盖。
  const navGenerationRef = useRef(0);
  const newSessionInFlightRef = useRef(false);
  const filesRequestSeqRef = useRef(0);
  // 文件列表刷新合并：同一时刻只保留一个在途请求，后续请求记为 pending，
  // 完成后只补一次；避免 file_changed 风暴把控制面连接池打满。
  const filesRefreshRef = useRef(null);
  const filesPendingDirRef = useRef(null);
  const filesFailureStreakRef = useRef(0);
  const docRequestSeqRef = useRef(0);
  const docAbortRef = useRef(null); // 打开文件请求的中止器：切文件/关标签/切工作区时取消旧请求
  const currentThreadRef = useRef(threadId);
  const eventCursorRef = useRef(Number(localStorage.getItem("oaw_event_cursor") || 0));
  const eventNoticeKeysRef = useRef(new Set());
  const autoOpenedRunRef = useRef(new Set());
  const changedFilesTimerRef = useRef(null);
  // file_changed 会成串到达：合并 500ms 后统一刷新文件树/当前预览，
  // 避免同一文件在一次任务里被反复 open() 重渲染。
  const pendingFileChangesRef = useRef(new Set());
  const fileChangeTimerRef = useRef(null);
  const previewToggleRef = useRef(null);
  const taskCenterRef = useRef(null);
  const topbarToolsRef = useRef(null);
  const [topbarMenuOpen, setTopbarMenuOpen] = useState(false);
  const pendingChatInsertRef = useRef([]);
  const { theme, toggleTheme } = useTheme();

  // 所有功能模块共用一个互斥入口，避免知识库、地图、智能体广场等弹层叠在一起。
  const closeExternalModules = useCallback(() => {
    setActiveModule(null);
  }, []);
  const openExternalModule = useCallback((module) => {
    setActiveModule(module);
  }, []);

  // 外部模块打开时主 ChatPanel 会卸载；先暂存 @ 引用，待回到对话后再写入，
  // 避免“点击调用但输入框没有任何内容”的竞态。
  const insertChatText = useCallback((value) => {
    const text = String(value || "").trim();
    if (!text) return;
    if (chatInputRef.current?.insertText) {
      chatInputRef.current.insertText(text);
      return;
    }
    pendingChatInsertRef.current.push(text);
  }, []);

  useEffect(() => {
    if (activeModule || !pendingChatInsertRef.current.length) return undefined;
    const timer = window.setTimeout(() => {
      const pending = pendingChatInsertRef.current.splice(0);
      if (!chatInputRef.current?.insertText) {
        pendingChatInsertRef.current.unshift(...pending);
        return;
      }
      pending.forEach((text) => chatInputRef.current.insertText(text));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeModule]);

  // 设置面板的“刷新模型”需要走一次供应商网络刷新；启动、定时轮询和切回标签页
  // 只读已缓存目录：POST /api/models/refresh 会重置共享 ModelRuntime 并等待网络
  // 往返（实测约 1 秒），既拖慢首屏，也会在会话进行中打断运行时预热。
  const refreshModelCatalog = useCallback(async () => {
    const data = await refreshModels();
    setModels(data.models || []);
    setDefaultModel(data.default || "");
    return data;
  }, []);

  const syncModelCatalog = useCallback(async () => {
    const data = await listModels();
    setModels(data.models || []);
    setDefaultModel(data.default || "");
    return data;
  }, []);

  useEffect(() => {
    currentThreadRef.current = threadId;
  }, [threadId]);

  // @ 按钮：把文件/文件夹路径插入到对话输入框
  const handleAtMention = useCallback((rel, isDir) => {
    const marker = isDir ? rel + "/" : rel;
    insertChatText(`@${marker}`);
  }, [insertChatText]);

  // 知识库 / Skills 的只读 Chat 转 Agent：关闭入口后把问题、引用和上下文
  // 交给主 ChatPanel，用户确认后再发送，避免检索入口隐式产生写入。
  const handlePromoteToAgent = useCallback((payload = {}) => {
    closeExternalModules();
    window.setTimeout(() => chatInputRef.current?.startAgentTask?.(payload), 120);
  }, [closeExternalModules]);

  // 新建会话：清空历史消息和当前文档。
  // 交互 2：所有 UI 入口统一零参数调用；历史实现直接把入口当 workspace 传，
  // React 点击事件被序列化成 cwd，抛出 "Converting circular structure to JSON"，
  // 而失败又被吞掉、界面照常切换，用户看到的是"清空了但没有新会话"。
  // 现在：只接受字符串工作区，连续点击去重，失败保留旧会话与草稿并给出可重试提示，
  // 成功后才提交 thread 与清空旧上下文。
  const handleNewSession = useCallback(async (workspaceArg, options = {}) => {
    const requested = typeof workspaceArg === "string" ? workspaceArg.trim() : "";
    const targetWorkspace = requested || currentWorkspaceRef.current || currentWorkspace;
    if (newSessionInFlightRef.current) return null;
    newSessionInFlightRef.current = true;
    // 导航代际（交互 8）：与工作区切换、选择历史共享同一条失效边界，
    // await 返回后若用户已经做了别的导航，这次结果必须丢弃。
    const generation = ++navGenerationRef.current;
    setCreatingSession(true);
    setNewSessionError(null);
    const next = `thread-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
    let created = null;
    try {
      // 先让后端创建并固定 session/workspace，再切换前端 thread，避免 SSE 先创建一个错误 cwd 的空 Agent。
      const project = projects.find((item) => sameWorkspacePath(item.rootPath, targetWorkspace));
      // v0.13.7 Agent 继承：options.agentId 非空时随 /api/agent/new 落盘到会话 header。
      const inheritedAgentId = String(options?.agentId || "").trim();
      created = await createAgentThread(clientId, next, targetWorkspace || undefined, {
        projectId: project?.id || null,
        ...(inheritedAgentId ? { agentId: inheritedAgentId } : {}),
      });
    } catch (e) {
      newSessionInFlightRef.current = false;
      setCreatingSession(false);
      if (generation === navGenerationRef.current) {
        // 保留旧会话、标签与未发送输入，只提示失败原因并提供重试。
        setNewSessionError({ message: e?.message || "创建新会话失败", workspace: targetWorkspace || "" });
      }
      return null;
    }
    if (generation !== navGenerationRef.current) {
      newSessionInFlightRef.current = false;
      setCreatingSession(false);
      return null;
    }
    // 新会话已经由当前 Chat 状态立即接管；历史列表刷新延后，避免工作区切换
    // 立刻触发一次全量 JSONL 扫描，阻塞刚完成的界面切换。
    window.setTimeout(() => refreshSessions(), 600);
    setThreadId(next);
    localStorage.setItem("oaw_thread_id", next);
    setHistoryMessages(null);
    setHistoryThreadId(null);
    setSessionResumeError(null);
    setAgentReady(true);
    setHistoryWindow(null);
    setSessionResumeError(null);
    // 切会话时丢弃在途的文件打开请求与已打开标签，避免旧结果写入新会话预览。
    docRequestSeqRef.current += 1;
    if (docAbortRef.current) { try { docAbortRef.current.abort(); } catch {} docAbortRef.current = null; }
    clearDocumentTabs();
    // 交互 5：目录归根必须与列表同一次导航——清掉旧子目录项并读根列表，
    // 否则根目录下仍显示旧子目录内容，点开会按新的根路径解释。
    currentDirRef.current = "";
    setCurrentDir("");
    setFiles([]);
    void refreshFiles("");
    setCurrentSessionId(created?.sessionId || null);
    setMapContexts((prev) => ({ ...prev, [next]: null }));
    // 新会话没有地图绑定：关闭上一条会话留下的地图预览，避免预览项目与当前会话不一致。
    setCanvasTabs((prev) => {
      if (!prev.some((tab) => tab.kind === "mapPreview")) return prev;
      return prev.filter((tab) => tab.kind !== "mapPreview");
    });
    setCanvasActiveId((prev) => (prev === "view:mapPreview" ? "" : prev));
    lastSessionIdRef.current = created?.sessionId || null;
    newSessionInFlightRef.current = false;
    setCreatingSession(false);
    return created;
    // 不把 refreshFiles / refreshSessions 列入依赖：它们在下方才声明，依赖数组在
    // 渲染期求值会命中 TDZ；两者都是依赖稳定的 useCallback，闭包捕获始终有效。
  }, [clientId, currentWorkspace, projects]);

  const setScopeStatus = useCallback((scope, status) => {
    setLoadStatus((prev) => (prev[scope] === status ? prev : { ...prev, [scope]: status }));
  }, []);

  const setScopeError = useCallback((scope, error) => {
    const message = error ? (error.message || "网络请求失败") : "";
    setLoadErrors((prev) => {
      if (!message) return prev[scope] ? { ...prev, [scope]: "" } : prev;
      return prev[scope] === message ? prev : { ...prev, [scope]: message };
    });
  }, []);

  const refreshFiles = useCallback(async (dir) => {
    const requestedDir = typeof dir === "string" ? dir : currentDirRef.current;
    const requestedWorkspace = currentWorkspaceRef.current;

    // 已有在途请求：只记下最新目录，等当前请求结束后补一次。
    if (filesRefreshRef.current) {
      filesPendingDirRef.current = requestedDir;
      return filesRefreshRef.current;
    }

    const requestSeq = ++filesRequestSeqRef.current;
    setScopeStatus("files", "loading");

    const attempt = async () => {
      try {
        return { ok: true, result: await listFiles(requestedDir, requestedWorkspace) };
      } catch (error) {
        return { ok: false, error };
      }
    };
    const isStale = () => requestSeq !== filesRequestSeqRef.current
      || requestedDir !== currentDirRef.current
      || !sameWorkspacePath(requestedWorkspace, currentWorkspaceRef.current);

    const run = async () => {
      let outcome = await attempt();
      // 瞬时错误先重试一次；只对“重试后仍失败”的持续错误提示。
      if (!outcome.ok && isTransientFilesError(outcome.error) && !isStale()) {
        await wait(400);
        if (isStale()) return;
        outcome = await attempt();
      }
      if (isStale()) return;

      if (!outcome.ok) {
        const error = outcome.error;
        // 当前目录被删除/改名：回到工作区根目录，避免一直停留在不存在的目录。
        if (isNotFoundFilesError(error) && requestedDir) {
          filesFailureStreakRef.current = 0;
          currentDirRef.current = "";
          setCurrentDir("");
          setScopeStatus("files", "loading");
          setScopeError("files", null);
          filesPendingDirRef.current = "";
          return;
        }
        filesFailureStreakRef.current += 1;
        setScopeStatus("files", "error");
        // 第一次瞬时失败保留旧列表、不弹横幅；连续失败才提示。
        if (filesFailureStreakRef.current >= 2) setScopeError("files", error);
        return;
      }

      const result = outcome.result;
      // 服务端回显的来源与页面不一致：判定为身份错位，阻止把它当当前目录展示。
      if (result.workspace && requestedWorkspace && !sameWorkspacePath(result.workspace, requestedWorkspace)) {
        filesFailureStreakRef.current += 1;
        setScopeStatus("files", "error");
        if (filesFailureStreakRef.current >= 2) {
          setScopeError("files", new Error(`文件列表来源与当前工作区不一致（${result.workspace}）`));
        }
        return;
      }
      filesFailureStreakRef.current = 0;
      setFiles(result.files || []);
      setScopeStatus("files", "ready");
      setScopeError("files", null);
    };

    let promise;
    promise = run().finally(() => {
      if (filesRefreshRef.current === promise) filesRefreshRef.current = null;
      const pendingDir = filesPendingDirRef.current;
      filesPendingDirRef.current = null;
      // 同一目录不重复补拉；切换目录/工作区时才补一次。
      if (pendingDir !== null && pendingDir !== requestedDir) {
        void refreshFiles(pendingDir);
      }
    });
    filesRefreshRef.current = promise;
    return promise;
  }, [setScopeError, setScopeStatus]);

  // 同步工作区 ref：文件请求由回调发起，若只依赖闭包里的 currentWorkspace，
  // 工作区刚切换时仍可能用旧值（交互 8 的失效边界之一）。
  useEffect(() => { currentWorkspaceRef.current = currentWorkspace; }, [currentWorkspace]);
  // 同理同步文件列表：切换失败要能恢复原列表，但不能让回调依赖 files 频繁重建。
  useEffect(() => { filesRef.current = files; }, [files]);

  const refreshSessions = useCallback(async () => {
    // 多任务并行时多个 Run 事件可能挨着到达：请求在飞又收到新事件时，
    // 结束后必须再刷一次，否则单飞复用了包含旧 runStatus 的快照
    // （2026-11-03-001 P0-3：会话栏动画“跟不上节奏”的一半根因）。
    if (sessionsRefreshRef.current) {
      sessionsRefreshPendingRef.current = true;
      return sessionsRefreshRequeuedPromiseRef.current || sessionsRefreshRef.current;
    }
    const request = listSessions()
      .then(async (data) => {
        const next = data.sessions || [];
        setSessions(next);
        setScopeStatus("sessions", "ready");
        setScopeError("sessions", null);
        return next;
      })
      .catch((error) => {
        // 保留上一次可用会话列表，不用空数组冒充“没有会话”。
        setScopeStatus("sessions", "error");
        setScopeError("sessions", error);
        return null;
      });
    sessionsRefreshRef.current = request;
    try {
      const result = await request;
      // 在飞期间又收到 Run 事件：立即补一次刷新，保证新任务的状态能落到列表里。
      if (sessionsRefreshPendingRef.current) {
        sessionsRefreshPendingRef.current = false;
        const requeued = refreshSessions();
        sessionsRefreshRequeuedPromiseRef.current = requeued;
        try { return await requeued; } finally { sessionsRefreshRequeuedPromiseRef.current = null; }
      }
      return result;
    }
    finally {
      if (sessionsRefreshRef.current === request) sessionsRefreshRef.current = null;
      sessionsRefreshPendingRef.current = false;
    }
  }, [setScopeError, setScopeStatus]);

  // 根级事件订阅：当前对话继续使用原有 thread SSE，App 额外监听所有 thread 的重要状态，
  // 让切换后的后台任务仍能刷新历史和未读提示。
  useEffect(() => {
    let source;
    let reconnectTimer = null;
    let retryDelay = 800;
    let cancelled = false;
    let leaderActive = false;
    let slot = null;
    // 全局事件流由跨标签页 leader 持有；follower 通过 BroadcastChannel 接收。
    // 不支持 BroadcastChannel 的环境会退化为每个标签页各自连接（原行为）。
    const cursorKey = "oaw_event_cursor";
    const flushEventBatch = () => {
      eventBatchTimerRef.current = null;
      const pending = eventBatchRef.current;
      eventBatchRef.current = { updates: 0, artifacts: 0 };
      if (pending.updates) setEventVersion((value) => value + pending.updates);
      if (pending.artifacts) setArtifactVersion((value) => value + pending.artifacts);
    };
    const scheduleEventBatch = (artifact = false) => {
      eventBatchRef.current.updates += 1;
      if (artifact) eventBatchRef.current.artifacts += 1;
      if (!eventBatchTimerRef.current) eventBatchTimerRef.current = window.setTimeout(flushEventBatch, 100);
    };
    const scheduleReconnect = () => {
      if (cancelled || !leaderActive || reconnectTimer) return;
      try { source?.close(); } catch {}
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        if (leaderActive) connect();
      }, retryDelay);
      retryDelay = Math.min(5000, retryDelay * 2);
    };
    // 事件处理与连接解耦：leader 收到 SSE 后本地处理并广播；follower 直接处理广播。
    const handlePayload = (payload) => {
      try {
        const event = payload?.event || payload;
        const seq = Number(event?.seq || 0);
        if (!seq || seq <= eventCursorRef.current) return;
        eventCursorRef.current = seq;
        localStorage.setItem(cursorKey, String(seq));
        const isCurrentThread = !event.threadId || event.threadId === currentThreadRef.current;
        scheduleEventBatch(isCurrentThread && ["run_finished", "file_changed", "artifact_published", ...(flag("stagedVisible") ? ["artifact_staged"] : [])].includes(event.type));
        const thread = event.threadId || "";
        const noticeKey = `${thread}:${event.runId || "event"}:${event.type}`;
        if (thread && thread !== currentThreadRef.current && GLOBAL_EVENT_NOTICES.has(event.type) && !eventNoticeKeysRef.current.has(noticeKey)) {
          eventNoticeKeysRef.current.add(noticeKey);
          setUnreadByThread((prev) => ({ ...prev, [thread]: (prev[thread] || 0) + 1 }));
        }
        // 会话栏/项目卡的运行动画必须跟着 Run 状态走（2026-11-03-001 P0-3）：
        // 此前只在 run_finished 等结束事件刷新，2–3 个任务并行时“刚开始”的
        // 会话一直显示旧状态（绿色完成点），用户反馈“动画跟不上节奏”。
        if (["run_started", "run_admitted", "agent_started", "agent_queued", "run_finished", "run_recovered", "run_cancel_requested", "agent_error"].includes(event.type)) {
          // 新一轮开始前恢复"浏览器侧栏可自动展开"：用户上一轮手动关掉的状态不跨轮传递。
          if (event.type === "run_finished") browserAutoOpenBlockedRef.current = false;
          // 后台 Run 结束后历史缓存必须失效：否则切回该会话会先显示上一轮旧消息。
          if (event.type === "run_finished") {
            const finishedSessionId = String(event.sessionId || event.data?.sessionId || "");
            if (finishedSessionId) sessionHistoryCacheRef.current.delete(finishedSessionId);
            else sessionHistoryCacheRef.current.clear();
          }
          if (!eventRefreshTimerRef.current) {
            eventRefreshTimerRef.current = window.setTimeout(() => {
              eventRefreshTimerRef.current = null;
              if (document.visibilityState === "visible") refreshSessions();
            }, 180);
          }
        }
      } catch {}
    };
    const connect = async () => {
      if (cancelled || !leaderActive) return;
      if (!slot) slot = acquireStream("agent-events", { essential: true, priority: 2, label: "全局事件流" });
      let cursor = eventCursorRef.current;
      if (!localStorage.getItem(cursorKey)) {
        try {
          const state = await fetch(`/api/agent/events/state?client=${encodeURIComponent(clientId)}`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json());
          if (Number.isFinite(Number(state.latest))) cursor = Number(state.latest);
          eventCursorRef.current = cursor;
          localStorage.setItem(cursorKey, String(cursor));
        } catch {}
      }
      if (cancelled || !leaderActive) return;
      source = new EventSource(`/api/agent/events?client=${encodeURIComponent(clientId)}&tab=${encodeURIComponent(getTabId())}&after=${encodeURIComponent(cursor)}`);
      slot?.attach(() => source?.close());
      source.onopen = () => { retryDelay = 800; };
      source.onmessage = (message) => {
        try {
          const payload = JSON.parse(message.data || "{}");
          handlePayload(payload);
          lease.publish(payload);
        } catch {}
      };
      // 服务端在回放结束后会下发具名 open 事件（cursor/latest/earliest/truncated）。
      // 它与 EventSource 传输层的 open 事件同名：传输层事件没有 data，这里按 data 区分。
      source.addEventListener("open", (message) => {
        if (cancelled) return;
        const raw = message?.data;
        if (!raw) return;
        try {
          const payload = JSON.parse(raw);
          if (!payload?.truncated) return;
          // 回放窗口与本地游标已不连续（服务端只能返回最近 N 条）：把本地游标
          // 对齐服务端最新，并立即做一次全量刷新，而不是静默漏掉中间事件。
          const latest = Number(payload.latest || 0);
          if (latest > eventCursorRef.current) {
            eventCursorRef.current = latest;
            localStorage.setItem(cursorKey, String(latest));
          }
          scheduleEventBatch(true);
          if (document.visibilityState === "visible") window.setTimeout(() => refreshSessions(), 180);
        } catch {}
      });
      source.onerror = scheduleReconnect;
    };
    let lease = null;
    const startLeaderStream = () => {
      if (leaderActive || cancelled) return;
      leaderActive = true;
      void connect();
    };
    const stopLeaderStream = () => {
      leaderActive = false;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      try { source?.close(); } catch {}
      source = null;
      slot?.release();
      slot = null;
    };
    lease = createGlobalEventsLease({
      onStart: startLeaderStream,
      onStop: stopLeaderStream,
      onEvent: handlePayload,
    });
    return () => {
      cancelled = true;
      lease?.stop();
      leaderActive = false;
      source?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (eventBatchTimerRef.current) {
        clearTimeout(eventBatchTimerRef.current);
        eventBatchTimerRef.current = null;
      }
      eventBatchRef.current = { updates: 0, artifacts: 0 };
      if (eventRefreshTimerRef.current) {
        clearTimeout(eventRefreshTimerRef.current);
        eventRefreshTimerRef.current = null;
      }
      slot?.release();
    };
  }, [clientId, refreshSessions]);

  const refreshProjects = useCallback(async () => {
    if (projectsRefreshRef.current) return projectsRefreshRef.current;
    setScopeStatus("projects", "loading");
    const request = listProjects()
      .then((data) => {
        const next = data.projects || [];
        setProjects(next);
        setScopeStatus("projects", "ready");
        setScopeError("projects", null);
        return next;
      })
      .catch((error) => {
        // 保留上一次可用项目列表，不把失败表现成“没有项目”。
        setScopeStatus("projects", "error");
        setScopeError("projects", error);
        return null;
      });
    projectsRefreshRef.current = request;
    try { return await request; }
    finally {
      if (projectsRefreshRef.current === request) projectsRefreshRef.current = null;
    }
  }, [setScopeError, setScopeStatus]);

  const refreshWorkspaces = useCallback(async () => {
    setScopeStatus("workspaces", "loading");
    try {
      const data = await listWorkspaces();
      const list = data.workspaces || [];
      setWorkspaces(list);
      setScopeStatus("workspaces", "ready");
      setScopeError("workspaces", null);
      const savedWorkspace = loadUIState()?.workspace;
      const restored = list.find((item) => sameWorkspacePath(item.path, savedWorkspace));
      if (restored) setCurrentWorkspace(restored.path);
      else if (list[0]) setCurrentWorkspace(list[0].path);
      return list;
    } catch (error) {
      // 保留上一次可用工作区，避免界面卡在“等待工作区列表就绪”。
      setScopeStatus("workspaces", "error");
      setScopeError("workspaces", error);
      return null;
    }
  }, [setScopeError, setScopeStatus]);

  const retryStartupLoads = useCallback(() => {
    const failed = Object.keys(loadErrors).filter((scope) => loadErrors[scope]);
    if (!failed.length || failed.includes("files")) refreshFiles();
    if (!failed.length || failed.includes("sessions")) refreshSessions();
    if (!failed.length || failed.includes("projects")) refreshProjects();
    if (!failed.length || failed.includes("workspaces")) refreshWorkspaces();
  }, [loadErrors, refreshFiles, refreshSessions, refreshProjects, refreshWorkspaces]);

  // 地图会话恢复：会话列表带回 header.mapProject/mapView；当前线程尚未绑定项目时回填。
  useEffect(() => {
    if (!Array.isArray(sessions) || !sessions.length) return;
    const matched = sessions.find((item) => (item.threadId || item.id) === threadId || item.id === currentSessionId);
    if (!matched || (!matched.mapProject && !matched.mapView)) return;
    setMapContexts((prev) => {
      const existing = prev[threadId];
      if (existing?.mapProject) return prev;
      return {
        ...prev,
        [threadId]: mergeMapContext(existing || {}, {
          mapProject: matched.mapProject || "",
          ...(matched.mapView || {}),
        }),
      };
    });
  }, [sessions, threadId, currentSessionId]);

  // 地图会话持久化：项目/视口变化 1.5s 后写入 session header；内容相同跳过。
  useEffect(() => {
    if (!currentSessionId || !currentMapContext) return undefined;
    const mapProject = String(currentMapContext.mapProject || "");
    const mapView = normalizeMapView(currentMapContext);
    if (!mapProject && !Object.keys(mapView).length) return undefined;
    const serialized = JSON.stringify({ mapProject, mapView });
    if (mapPersistRef.current.last === serialized) return undefined;
    const timer = window.setTimeout(() => {
      updateSessionMapContext(currentSessionId, mapProject, mapView)
        .then(() => { mapPersistRef.current.last = serialized; })
        .catch(() => {});
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [currentSessionId, currentMapContext]);

  // 预览标签跟随当前会话的地图项目：只更新 payload，不激活标签、不抢占已有画布。
  // 会话解绑时关闭预览；空画布且已绑定项目时自动打开（与选择会话的既有策略一致）。
  useEffect(() => {
    // 新会话在落盘 header 之前 currentSessionId 可能为空，但视口上报已经能确定
    // 当前线程的地图项目；预览仍应打开，因此会话键回退到 threadId。
    const sessionKey = currentSessionId || threadId;
    if (!sessionKey) return;
    const project = String(currentMapContext?.mapProject || "");
    const openTabs = canvasTabsRef.current || [];
    const preview = openTabs.find((tab) => tab.kind === "mapPreview") || null;
    if (!project) {
      if (!preview) return;
      setCanvasTabs((prev) => prev.filter((tab) => tab.kind !== "mapPreview"));
      setCanvasActiveId((prev) => (prev === "view:mapPreview" ? "" : prev));
      return;
    }
    if (preview) {
      const previewSession = String(preview.payload?.sessionId || "");
      if (previewSession && previewSession !== String(currentSessionId || "") && previewSession !== String(threadId || "")) return;
      if (String(preview.payload?.project || "") === project) return;
      setCanvasTabs((prev) => prev.map((tab) => (tab.kind === "mapPreview"
        ? { ...tab, payload: { ...tab.payload, project, sessionId: sessionKey } }
        : tab)));
      return;
    }
    if (activeModule === "map") return;
    if (openTabs.length > 0) return;
    openCanvasView("mapPreview", { project, view: currentMapContext, sessionId: sessionKey });
  }, [currentSessionId, threadId, currentMapContext?.mapProject, activeModule, openCanvasView]);

  useEffect(() => {
    refreshFiles();
    refreshSessions();
    refreshProjects();
    let modelTimer;
    const sessionTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") refreshSessions();
    }, 30000);
    const projectTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") refreshProjects();
    }, 60000);
    const syncModels = async () => {
      try {
        await syncModelCatalog();
      } catch {
        // 扫描失败时保留上一次列表，避免模型下拉框瞬间清空。
      }
    };
    syncModels();
    modelTimer = window.setInterval(syncModels, 60_000);
    const onVisibility = () => { if (document.visibilityState === "visible") syncModels(); };
    document.addEventListener("visibilitychange", onVisibility);
    refreshWorkspaces();
    return () => {
      window.clearInterval(modelTimer);
      window.clearInterval(sessionTimer);
      window.clearInterval(projectTimer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refreshFiles, refreshSessions, refreshProjects, refreshWorkspaces, syncModelCatalog]);

  // 全局 Ctrl/Cmd+K 切换命令面板
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 切换工作区
  const handleWorkspaceChange = useCallback(async (dir) => {
    const requestedPath = String(dir || "").trim();
    if (!requestedPath || sameWorkspacePath(requestedPath, currentWorkspace)) return;
    const switchSeq = ++workspaceSwitchSeqRef.current;
    // 工作区切换同样推进统一导航代际：在途的新建/历史加载结果不得再写入。
    navGenerationRef.current += 1;
    // 记下失败时要恢复的原状态：切换未成功前不应让用户丢掉当前目录。
    const previousDir = currentDirRef.current;
    const previousFiles = filesRef.current;
    // 先清空旧工作区的视图，避免等待服务端时继续操作旧文件。
    currentDirRef.current = "";
    setCurrentDir("");
    setFiles([]);
    // 切工作区时中止在途打开请求并清空标签，旧工作区的预览结果不得写入。
    docRequestSeqRef.current += 1;
    if (docAbortRef.current) { try { docAbortRef.current.abort(); } catch {} docAbortRef.current = null; }
    clearDocumentTabs();
    setHistoryMessages(null);
    setHistoryWindow(null);
    setCurrentSessionId(null);
    try {
      const r = await switchWorkspace(requestedPath);
      if (switchSeq !== workspaceSwitchSeqRef.current) return;
      // 先同步 ref 再触发任何文件请求：refreshFiles 与 handleNewSession 都从
      // currentWorkspaceRef 取身份，晚一拍就会把新工作区的请求发到旧路径上。
      currentWorkspaceRef.current = r.workspace;
      setCurrentWorkspace(r.workspace);
      // 新工作区加入下拉列表（自定义路径切换后也能在下拉中看到）
      setWorkspaces((prev) => {
        if (prev.some((w) => w.path === r.workspace)) return prev;
        const name = String(r.workspace).split(/[\\/]/).filter(Boolean).pop() || r.workspace;
        return [...prev, { path: r.workspace, name }];
      });
      setFiles(r.files || []);
      // 工作区切换后异步刷新项目：让新打开的本地目录立即出现在项目栏，且不阻塞文件视图。
      void refreshProjects();
      void handleNewSession(r.workspace);
    } catch (e) {
      if (switchSeq === workspaceSwitchSeqRef.current) {
        // 切换失败保留原有效状态：恢复原目录与文件列表，只提示失败原因。
        currentDirRef.current = previousDir;
        setCurrentDir(previousDir);
        setFiles(previousFiles);
        setWorkspaceSwitchError({ message: e?.message || "切换工作区失败", workspace: requestedPath });
      }
    }
  }, [currentWorkspace, handleNewSession, refreshFiles, refreshProjects]);

  const visibleSessions = currentWorkspace
    ? sessions.filter((session) => !session.cwd || sameWorkspacePath(session.cwd, currentWorkspace))
    : sessions;
  const recentMapSessions = visibleSessions.filter((session) => Boolean(session.mapProject)).slice(0, 3);
  // 启动加载失败提示：按分区列出，提供统一重试；失败期间保留上一次可用数据。
  const loadFailures = Object.entries(loadErrors).filter(([, message]) => Boolean(message));
  const loadFailureText = loadFailures.length
    ? `${loadFailures.map(([scope]) => LOAD_SCOPE_LABELS[scope] || scope).join("、")}读取失败，已保留上一次可用数据`
    : "";
  const loadRetrying = loadFailures.some(([scope]) => loadStatus[scope] === "loading");
  const handleProjectChange = useCallback((id) => {
    const project = projects.find((item) => item.id === id);
    if (project?.rootPath) handleWorkspaceChange(project.rootPath);
  }, [projects, handleWorkspaceChange]);

// 进入/返回子目录
  const handleDirChange = useCallback((dir) => {
    const nextDir = String(dir || "");
    currentDirRef.current = nextDir;
    setCurrentDir(nextDir);
    void refreshFiles(nextDir);
  }, [refreshFiles]);

  const open = useCallback(async (name, thread = threadId, cwd = currentWorkspace) => {
    const requestSeq = ++docRequestSeqRef.current;
    // 中止上一次未完成的打开请求：旧响应（可能来自另一个工作区的同名文件）不得写入新预览。
    docAbortRef.current?.abort();
    const controller = new AbortController();
    docAbortRef.current = controller;
    setDocLoading(true);
    // 容错：调用方可能只传了工作区（例如产物跨工作区打开），thread 缺失时回退到当前会话
    const effectiveThread = thread || threadId;
    const effectiveCwd = cwd || currentWorkspace;
    // 打开前先构造本地身份（workspaceId + relativePath），后续所有预览请求都用它。
    const localIdentity = makeFileIdentity({ workspaceId: effectiveCwd, cwd: effectiveCwd, relativePath: name });
    try {
      const urls = buildDocUrls(localIdentity);
      const params = new URLSearchParams({ client: clientId, thread: effectiveThread || "" });
      const response = await fetch(`${urls.open}&${params.toString()}`, { cache: "no-store", signal: controller.signal });
      const doc = await response.json();
      if (!response.ok || doc?.error) throw new Error(doc?.error || `加载失败 HTTP ${response.status}`);
      if (requestSeq !== docRequestSeqRef.current) return null;
      // 服务端返回的文件身份（含真实 version/hash）优先；前端核对一致后才使用，不一致则标记 failed。
      const identity = mergeFileIdentity(localIdentity, doc?.identity);
      const identityVerified = doc?.identity ? identityMatches(localIdentity, doc.identity) : true;
      const resolvedUrls = buildDocUrls(identity);
      // 预览地址一律由本地身份重建（带上 cwd + revision），不直接信任 doc.url。
      const previewUrl = doc.kind === "pdf" ? resolvedUrls.raw : doc.kind === "html" ? resolvedUrls.html : (doc.url || "");
      const id = fileIdentityKey(identity);
      const nextDoc = {
        ...doc,
        identity,
        id,
        url: previewUrl,
        previewRevision: identity.revision,
        identityVerified,
      };
      // 文件从“本轮产物”或 Agent 自动产出打开时，直接激活对应文档标签，
      // 避免用户还停留在产物列表而误以为文件没有打开。
      const docTab = createDocTab(id, name);
      setCanvasTabs((prev) => openCanvasTab(prev, docTab).tabs);
      setCanvasActiveId(docTab.id);
      setCanvasCollapsed(false);
      // 单次 setTabs：按「工作区 + 相对路径」去重，不同工作区的同名文件是不同标签。
      setTabs((prev) => {
        const exists = prev.find((t) => (t.id || t.name) === id);
        if (exists) return prev.map((t) => ((t.id || t.name) === id ? { ...t, ...nextDoc, name } : t));
        return [...prev, { name, ...nextDoc }];
      });
      setActiveTab(id);
      setDocLoading(false);
      return id;
    } catch (e) {
      // 被更新请求取代：静默丢弃，不弹窗、不清 loading（由新请求负责）。
      if (e?.name === "AbortError") return null;
      const message = String(e?.message || "");
      // 文件被移动/删除，或文件列表还是切换工作区之前的旧数据时，不弹生硬的 "not found"，
      // 而是刷新列表并提示重新选择。
      if (/not found|enoent|http 404/i.test(message)) {
        try { await refreshFiles?.(); } catch {}
        notifyError(`文件不存在或已被移动：${name}\n已刷新文件列表，请重新选择。`);
      } else {
        notifyError("打开失败: " + message);
      }
      setDocLoading(false);
      return null;
    }
  }, [clientId, threadId, currentWorkspace]);
  openDocRef.current = open;

  useEffect(() => {
    if (!pendingDocRestoreRef.current.length || !currentWorkspace || !openDocRef.current) return;
    const names = [...pendingDocRestoreRef.current];
    const activeId = pendingActiveCanvasIdRef.current;
    pendingDocRestoreRef.current = [];
    pendingActiveCanvasIdRef.current = "";
    (async () => {
      for (const name of names) {
        await openDocRef.current(name, threadId, currentWorkspace);
      }
      if (activeId) setCanvasActiveId(activeId);
    })();
  }, [currentWorkspace, threadId]);

  const handleChatOpenFile = useCallback((name) => {
    if (activeModule === "map") mapBridgeRef.current?.onOpenFile?.(name);
    else open(name);
  }, [activeModule, open]);

  // 子代理卡片 → 画布临时「子代理」标签：展示该子代理的思考 / 回复 / 工具调用完整过程。
  // 传入的是点击时刻的 block 快照；运行中想看最新过程可再次点击卡片。
  const openSubagentDetail = useCallback((block) => {
    const tab = createSubagentTab(block || {});
    setCanvasTabs((prev) => openCanvasTab(prev, tab).tabs);
    setCanvasActiveId(tab.id);
    setCanvasCollapsed(false);
  }, []);

  // 子代理运行中：ChatPanel 推送最新 block，若画布有对应标签则原地刷新。
  const handleSubagentUpdate = useCallback((_thread, block) => {
    if (!block?.id) return;
    setCanvasTabs((prev) => prev.map((tab) => (
      tab.kind === "subagent" && tab.payload?.block?.id === block.id
        ? { ...tab, payload: { block } }
        : tab
    )));
  }, []);

  // 关闭文档标签：画布标签与文档数据同步移除；关闭当前标签时中止在途打开请求。
  const closeTab = useCallback((id) => closeCanvasTabById(docTabId(id)), [closeCanvasTabById]);

  // 点击历史会话：加载该会话的消息记录，并尝试打开关联文件
  const handleSelectSession = useCallback(async (session) => {
    // 会话切换：重置右栏“改动/产物”的 runId 与范围，
    // 避免上一个会话的“本轮产物”污染到当前会话（用户反馈的跨会话污染）。
    setChangesRunId("");
    setArtifactScope("session");
    setArtifactNotice(null);
    const loadSeq = ++sessionLoadSeqRef.current;
    // 恢复/加载失败必须落到「有横幅 + 可重试」，不能静默停在 agentReady=false：
    // 一旦停在 false，ChatPanel 的 SSE effect 会直接 return，界面永久没有实时流
    // （2026-11-06 调查：切回运行中会话冻结的根因之一）。
    const markSessionLoadFailed = (message, code = "") => {
      if (loadSeq !== sessionLoadSeqRef.current) return;
      setSessionResumeError({ sessionId: session.id, message, code, detail: null });
      setAgentReady(false);
      setHistoryLoading(false);
    };
    // 选择历史同样推进统一导航代际：在途的新建/工作区切换不得覆盖本次结果。
    navGenerationRef.current += 1;
    // 会话自带工作区归属；先切换文件视图，再切换 thread，避免历史会话在另一个项目目录下恢复。
    const targetWorkspace = session.cwd || currentWorkspace;
    let resumedWorkspace = targetWorkspace;
    if (targetWorkspace && !sameWorkspacePath(targetWorkspace, currentWorkspace)) {
      try {
        const switched = await switchWorkspace(targetWorkspace);
        if (loadSeq !== sessionLoadSeqRef.current) return;
        resumedWorkspace = switched.workspace;
        setCurrentWorkspace(switched.workspace);
        currentDirRef.current = "";
        setCurrentDir("");
        setFiles(switched.files || []);
        docRequestSeqRef.current += 1;
        if (docAbortRef.current) { try { docAbortRef.current.abort(); } catch {} docAbortRef.current = null; }
        clearDocumentTabs();
      } catch (e) {
        // 工作区不可用就不要再加载这份历史：否则会出现"会话 A 的历史 + 会话 B 的文件树"
        // 的错配（用户无法判断自己看到的是哪个项目的产物）。用已有的恢复失败横幅展示。
        console.warn("切换到会话工作区失败，已中止本次历史加载:", e.message);
        if (loadSeq === sessionLoadSeqRef.current) {
          setSessionResumeError({
            sessionId: session.id,
            message: `该会话的工作区不可用：${e.message || targetWorkspace}`,
            code: "WORKSPACE_UNAVAILABLE",
            detail: { workspace: targetWorkspace },
          });
        }
        return;
      }
    }
    const conversationId = session.threadId || session.id;
    const cachedHistory = sessionHistoryCacheRef.current.get(session.id);
    if (cachedHistory) {
      setHistoryThreadId(conversationId);
      setHistoryMessages(cachedHistory);
      setHistoryWindow(sessionHistoryMetaRef.current.get(session.id) || null);
      setHistoryLoading(false);
    } else {
      setHistoryThreadId(null);
      setHistoryMessages(null);
      setHistoryWindow(null);
      // 缓存未命中：置加载态，让 ChatPanel 渲染骨架屏而不是空白。
      setHistoryLoading(true);
    }
    // 历史与 Agent 恢复互不依赖：历史先展示，恢复在后台继续；只有恢复成功
    // 才把 agentReady 置真，避免 SSE 在恢复完成前创建新的空 runtime。
    const historyPromise = (async () => {
      try {
        const d = await getSession(session.id, { view: "chat", limit: 50 });
        const runData = await listRuns("", 50, { sessionId: session.id, fields: "summary" }).catch(() => ({ runs: [] }));
        return { ok: true, d, runData };
      } catch (error) {
        return { ok: false, error };
      }
    })();
    // 恢复结果要在"历史已显示、但还没 await 到 resume"的窗口里也能读到，所以用这个
    // 落地标记观察它：结算后写入，null 表示"还不知道"。
    // 不能在 await 之前直接读下面的 resumeResult —— 那是后面才声明的 const，会踩 TDZ
    // （2026-11-02 的"加载会话失败: Cannot access 'Yn' before initialization"就是它）。
    let resumeSettled = null;
    const resumePromise = resumeAgentThread(clientId, conversationId, session.id, resumedWorkspace)
      .then(() => ({ ok: true }))
      .catch((e) => {
        console.warn("恢复 Agent 会话失败，历史按只读展示:", e.message);
        // 必须带上 code/detail：前端据此区分「忙，等任务结束后自动重试」与「彻底失败」，
        // 丢掉后 SESSION_BUSY 分支永远不触发，只能显示一句没用的只读提示。
        return { ok: false, error: e.message || "恢复失败", code: e.code || "", detail: e.detail || null };
      })
      .then((result) => {
        resumeSettled = result;
        return result;
      });
    setUnreadByThread((prev) => {
      if (!prev[conversationId]) return prev;
      const next = { ...prev };
      delete next[conversationId];
      return next;
    });
    markAgentEventsRead(clientId, eventCursorRef.current).catch(() => {});
    try {
      const historyResult = await historyPromise;
      if (loadSeq !== sessionLoadSeqRef.current) return;
      if (!historyResult.ok) {
        notifyError("加载会话历史失败: " + (historyResult.error?.message || "未知错误"));
        markSessionLoadFailed(`加载会话历史失败：${historyResult.error?.message || "未知错误"}`, "SESSION_HISTORY_FAILED");
        return;
      }
      const { d, runData } = historyResult;
      // 历史已到：立即切换并显示，不再等 resume；输入/SSE 等 agentReady。
      setAgentReady(false);
      // 恢复失败时仍展示历史，但明确标注为只读并提供重试，避免用户误以为可以继续对话。
      // 这里不等 resume（历史优先显示）：只知道"已经结算"的结果；还没结算就留空，
      // 由下方 await resumePromise 之后统一写入真实结果。
      setSessionResumeError(resumeSettled && !resumeSettled.ok ? {
        sessionId: session.id,
        message: resumeSettled.error || "Agent 会话恢复失败",
        code: resumeSettled.code || "",
        detail: resumeSettled.detail || null,
      } : null);
      setCurrentSessionId(session.id);
      setThreadId(conversationId);
      // 恢复该会话记录的地图项目与视口（header 由 /api/sessions 列表或详情带回）。
      setMapContexts((prev) => ({
        ...prev,
        [conversationId]: mergeMapContext(prev[conversationId] || {}, {
          mapProject: session.mapProject || "",
          ...(session.mapView || {}),
        }),
      }));
      // 初始页点击地图会话：画布为空时自动打开只读“地图预览”标签；
      // 已有预览标签时同步到当前会话；其他标签保持不动，不抢用户正在看的文档。
      const sessionMapProject = String(session.mapProject || "").trim();
      if (sessionMapProject) {
        const openTabs = canvasTabsRef.current;
        if (!openTabs.length || openTabs.some((tab) => tab.kind === "mapPreview")) {
          openCanvasView("mapPreview", {
            project: sessionMapProject,
            view: session.mapView || null,
            sessionId: session.id,
          });
        }
      } else {
        // 切到无地图绑定的会话：关闭上一条会话的地图预览，避免预览项目与当前会话不一致。
        setCanvasTabs((prev) => {
          if (!prev.some((tab) => tab.kind === "mapPreview")) return prev;
          return prev.filter((tab) => tab.kind !== "mapPreview");
        });
        setCanvasActiveId((prev) => (prev === "view:mapPreview" ? "" : prev));
      }
      setChatLinks([]);
      localStorage.setItem("oaw_thread_id", conversationId);
      // 按原始 JSONL 顺序重建消息。toolResult 是工具输出，不能渲染成 You 的用户气泡；
      // 它要按 toolCallId 回填到对应 Agent 工具卡，否则 Word/PPT 读取结果会被误认为用户输入。
      const msgs = buildHistoryMessages(d.entries || []);
      const runMessages = buildRunSummaryMessages(runData?.runs);
      // 取消/中断后仍会写入的 assistant 没有 Run 记录可归属，补一张「运行记录缺失」卡，
      // 否则它们每条各渲染一个「思考与工具过程」折叠头（2026-11-06 实测）。
      const orphanCards = buildOrphanRunCards(msgs, runMessages);
      // Run 总结按收尾时间插回原始消息流。不能按 createdAt 全局排序：运行中的 Run
      // 只有 startedAt，会让总结卡跑到本轮消息之前，整轮因此拿不到 runId 并退回旧渲染。
      const loadedHistory = normalizeHistoryMessages(mergeRunSummaries(msgs, [...runMessages, ...orphanCards]));
      sessionHistoryCacheRef.current.set(session.id, loadedHistory);
      const historyStart = Number(d.info?.historyStart || 0);
      const historyHasMore = Boolean(d.info?.historyHasMore);
      sessionHistoryMetaRef.current.set(session.id, historyHasMore ? {
        total: Number(d.info?.historyTotal || 0),
        start: historyStart,
        end: Number(d.info?.historyEnd || 0),
        pageSize: Number(d.info?.historyPageSize || 50),
        hasMore: true,
      } : null);
      // v0.12.5：游标保存服务端返回的 historyStart，下一页用 before=该值续拉。
      sessionHistoryCursorRef.current.set(session.id, {
        before: historyStart,
        hasMore: historyHasMore,
        total: Number(d.info?.historyTotal || 0),
      });
      // 只保留最近几条缓存，避免长会话历史常驻内存；再次点击时仍可先显示缓存。
      while (sessionHistoryCacheRef.current.size > 24) {
        const first = sessionHistoryCacheRef.current.keys().next().value;
        if (first === undefined) break;
        sessionHistoryCacheRef.current.delete(first);
        sessionHistoryCursorRef.current.delete(first);
        sessionHistoryMetaRef.current.delete(first);
      }
      setHistoryMessages(loadedHistory);
      setHistoryWindow(sessionHistoryMetaRef.current.get(session.id) || null);
      setHistoryThreadId(conversationId);
      // 历史已经在屏幕上：现在等恢复结果，只影响“能否继续发送”，不再阻塞阅读。
      const resumeResult = await resumePromise;
      if (loadSeq !== sessionLoadSeqRef.current) return;
      setSessionResumeError(resumeResult?.ok ? null : { sessionId: session.id, message: resumeResult?.error || "Agent 会话恢复失败" });
      setAgentReady(Boolean(resumeResult?.ok));
      // 恢复完成后结束历史骨架屏（历史已可读，等待的只是能否继续发送）。
      setHistoryLoading(false);
      // 从消息里解析会话关联的文件，尝试打开
      const fileMatch = msgs.find((m) => m.role === "user" && m.text && m.text.includes("当前打开文件"));
      if (fileMatch) {
        const fn = fileMatch.text.match(/当前打开文件:\s*([^\]\n]+)/);
        if (fn?.[1]) {
          // 历史文本先显示，关联文档在后台打开，不再阻塞会话切换。
          // 交互 9：必须显式传本次恢复后的工作区——setCurrentWorkspace 还没让
          // 正在执行的 open 闭包看到新值，否则跨工作区会在旧目录取同名文件或 404。
          void open(fn[1].trim(), conversationId, resumedWorkspace || undefined).catch(() => {});
        }
      }
    } catch (e) {
      // 只把 message 交给 toast，堆栈就丢了——排查 TDZ / 引用错误时完全没法定位。
      // 这里额外把完整错误打到控制台（含堆栈），并留一个可读的全局快照供诊断。
      try {
        console.error("[会话加载]", e);
        window.__oawLastSessionError = { message: e?.message, stack: e?.stack, at: Date.now() };
      } catch {}
      if (loadSeq === sessionLoadSeqRef.current) notifyError("加载会话失败: " + e.message);
      markSessionLoadFailed(`加载会话失败：${e.message}`, "SESSION_LOAD_FAILED");
    } finally {
      // 无论成功/失败都结束骨架屏（成功路径已提前置 false，这里兜住提前 return 与异常）。
      if (loadSeq === sessionLoadSeqRef.current) setHistoryLoading(false);
    }
  }, [clientId, currentWorkspace, open, refreshProjects, openCanvasView]);

  // v0.12.5：按游标续拉更早的历史（50 条/页），返回可直接前插的规范化消息。
  const loadOlderSessionHistory = useCallback(async () => {
    const sessionId = currentSessionId;
    const cursor = sessionId ? sessionHistoryCursorRef.current.get(sessionId) : null;
    if (!sessionId || !cursor?.hasMore) return { messages: [], hasMore: false };
    const pageSize = 50;
    const d = await getSession(sessionId, { view: "chat", limit: pageSize, before: cursor.before });
    // 旧页也要补 run 摘要：与首屏同一份规则。缺了它，associateRunMessages 找不到本轮 Run，
    // 已加载的旧轮次会退回旧渲染（时间流/总结形态与首屏不一致）。
    // 旧页通常不含 events，listRuns 的 includeEvents 默认只给活跃/最新一条，
    // 这里按会话取一次 run 列表做合并（失败不阻断分页）。
    let runMessages = [];
    try {
      const runData = await listRuns("", 50, { sessionId });
      runMessages = buildRunSummaryMessages(runData?.runs);
    } catch {}
    const appendedMessages = buildHistoryMessages(d.entries || []);
    const pageMessages = normalizeHistoryMessages(
      mergeRunSummaries(appendedMessages, [...runMessages, ...buildOrphanRunCards(appendedMessages, runMessages)]),
    );
    const messages = pageMessages;
    const info = d.info || {};
    const nextCursor = {
      before: Number(info.historyStart ?? Math.max(0, cursor.before - pageSize)),
      hasMore: Boolean(info.historyHasMore),
      total: Number(info.historyTotal || cursor.total || 0),
    };
    sessionHistoryCursorRef.current.set(sessionId, nextCursor);
    // 单一事实源：分页结果必须回写 App 的 historyMessages 与缓存。
    // 此前只 return 给 ChatPanel 的本地 state，App 仍认为"这个会话只有首屏那一页"；
    // 任何重新触发 setHistoryMessages 的路径都会把已加载的旧消息覆盖掉。
    setHistoryMessages((previous) => {
      if (!Array.isArray(previous)) return previous;
      const seen = new Set(previous.map((item) => item?.id).filter(Boolean));
      const olderOnly = messages.filter((item) => !item?.id || !seen.has(item.id));
      const merged = [...olderOnly, ...previous];
      sessionHistoryCacheRef.current.set(sessionId, merged);
      return merged;
    });
    const meta = sessionHistoryMetaRef.current.get(sessionId);
    if (meta) {
      sessionHistoryMetaRef.current.set(sessionId, {
        ...meta,
        start: nextCursor.before,
        hasMore: nextCursor.hasMore,
        total: nextCursor.total,
        pageSize,
      });
      setHistoryWindow(sessionHistoryMetaRef.current.get(sessionId));
    }
    return {
      messages,
      hasMore: nextCursor.hasMore,
      total: nextCursor.total,
      before: nextCursor.before,
      loadedCount: Math.max(0, nextCursor.total - nextCursor.before),
    };
  }, [currentSessionId]);

  // v0.12.8：切换回答版本后重读会话（服务端已把活跃分支固化到 JSONL）。
  const reloadCurrentSessionHistory = useCallback(async () => {
    const session = sessions.find((item) => (item.threadId || item.id) === threadId)
      || (currentSessionId ? sessions.find((item) => item.id === currentSessionId) : null);
    if (!session) return;
    sessionHistoryCacheRef.current.delete(session.id);
    sessionHistoryCursorRef.current.delete(session.id);
    await handleSelectSession(session);
  }, [sessions, threadId, currentSessionId, handleSelectSession]);

  // 重试恢复当前历史会话的 Agent：成功后才允许继续对话。
  const retrySessionResume = useCallback(async (silentFlag) => {
    const silent = silentFlag === true; // onClick 会把事件对象当首参传入，仅显式 true 才算静默
    const targetId = sessionResumeError?.sessionId || currentSessionId;
    if (!targetId) return;
    const conversationId = threadId || targetId;
    if (!silent) setSessionResumeRetrying(true);
    try {
      await resumeAgentThread(clientId, conversationId, targetId, currentWorkspace);
      setSessionResumeError(null);
      setAgentReady(true);
    } catch (error) {
      setSessionResumeError({
        sessionId: targetId,
        message: error.message || "Agent 会话恢复失败",
        code: error.code || "",
        detail: error.detail || null,
      });
      setAgentReady(false);
    }
    if (!silent) setSessionResumeRetrying(false);
  }, [clientId, currentSessionId, currentWorkspace, sessionResumeError, threadId]);

  // A2（2026-11-06 修订）：恢复失败后自动重试，不再依赖默认关闭的开关。
  // 只对"等一会可能成功"的原因重试：SESSION_BUSY（任务占用）与空 code（超时/网络）。
  // 工作区不匹配、会话不存在等确定性失败不重试，避免无意义轮询。
  const resumeWaitStartRef = useRef(0);
  const [resumeWaitSec, setResumeWaitSec] = useState(0);
  useEffect(() => {
    const code = String(sessionResumeError?.code || "");
    const transient = Boolean(sessionResumeError) && (code === "SESSION_BUSY" || code === "");
    if (!transient) {
      resumeWaitStartRef.current = 0;
      setResumeWaitSec(0);
      return undefined;
    }
    if (!resumeWaitStartRef.current) resumeWaitStartRef.current = Date.now();
    const timer = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - resumeWaitStartRef.current) / 1000);
      setResumeWaitSec(elapsed);
      if (elapsed > 600) { window.clearInterval(timer); return; }
      void retrySessionResume(true);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [sessionResumeError?.code, sessionResumeError?.sessionId, retrySessionResume]);

  const handleForkSession = useCallback(async (id, label, options = {}) => {
    const source = sessions.find((item) => item.id === id);
    const result = await forkSession(id, label, {
      purpose: options.sourceMessageId ? "从指定消息创建独立分析分支" : "从历史会话创建独立分析分支",
      sourceMessageId: options.sourceMessageId || null,
    });
    await refreshSessions();
    await handleSelectSession({
      id: result.id,
      threadId: result.threadId || result.id,
      cwd: result.cwd || source?.cwd || currentWorkspace,
      projectId: result.projectId || source?.projectId || currentProject?.id || null,
      parentSessionId: result.parentSessionId || id,
      label: result.label || label || "会话分支",
      title: result.label || label || "会话分支",
      pinned: false,
      frozen: false,
    });
    return result;
  }, [currentProject?.id, currentWorkspace, handleSelectSession, refreshSessions, sessions]);

  const handlePinSession = useCallback(async (id, pinned) => {
    await pinSession(id, pinned);
    await refreshSessions();
  }, [refreshSessions]);

  // 2026-11-03 归档：只改 header。归档当前打开的会话时故意不清 currentSessionId，
  // 避免用户正在看的对话被“归档”动作直接关掉；切走后再从默认列表消失。
  const handleArchiveSession = useCallback(async (id, archived = true) => {
    await archiveSession(id, archived);
    await refreshSessions();
  }, [refreshSessions]);

  const handleBatchArchiveSessions = useCallback(async (ids, archived = true) => {
    const result = await archiveSessions(ids, archived);
    await refreshSessions();
    if (result.skipped?.length) {
      const reasons = [...new Set(result.skipped.map((item) => item.reason).filter(Boolean))];
      if (reasons.length) window.setTimeout(() => notifyError(`部分会话未${archived ? "归档" : "恢复"}：${reasons.join("、")}`), 0);
    }
    return result;
  }, [refreshSessions]);

  const handleDeleteSession = useCallback(async (id) => {
    await deleteSession(id);
    sessionHistoryCacheRef.current.delete(id);
    sessionHistoryMetaRef.current.delete(id);
    if (currentSessionId === id) {
      setHistoryMessages(null);
      setHistoryWindow(null);
      setCurrentSessionId(null);
    }
    await refreshSessions();
  }, [currentSessionId, refreshSessions]);

  const handleBatchDeleteSessions = useCallback(async (ids) => {
    const result = await deleteSessions(ids);
    for (const id of ids || []) {
      sessionHistoryCacheRef.current.delete(id);
      sessionHistoryMetaRef.current.delete(id);
    }
    if (currentSessionId && result.deleted?.includes(currentSessionId)) {
      setHistoryMessages(null);
      setHistoryWindow(null);
      setCurrentSessionId(null);
    }
    await refreshSessions();
    if (result.skipped?.length) {
      const names = result.skipped.map((item) => item.reason).filter(Boolean);
      if (names.length) window.setTimeout(() => notifyError(`部分会话未删除：${names.join("、")}`), 0);
    }
    return result;
  }, [currentSessionId, refreshSessions]);

  const handleRenameSession = useCallback(async (id, label) => {
    await renameSession(id, label);
    await refreshSessions();
  }, [refreshSessions]);

  const handleFreezeSession = useCallback(async (id, frozen) => {
    await freezeSession(id, frozen);
    await refreshSessions();
  }, [refreshSessions]);

  const handleOpenRun = useCallback((run) => {
    const id = run?.sessionId || run?.threadId;
    if (!id) return;
    return handleSelectSession({
      id,
      threadId: run.threadId || id,
      cwd: run.cwd || currentWorkspace,
      projectId: run.projectId || currentProject?.id || null,
      title: run.task?.goal || "任务对应会话",
      label: run.task?.goal || "任务对应会话",
    });
  }, [currentProject?.id, currentWorkspace, handleSelectSession]);

  const flushFileChanges = useCallback(() => {
    if (fileChangeTimerRef.current) {
      window.clearTimeout(fileChangeTimerRef.current);
      fileChangeTimerRef.current = null;
    }
    const pending = pendingFileChangesRef.current;
    if (!pending.size) return;
    const changedPaths = new Set(pending);
    pending.clear();
    refreshFiles();
    const active = tabs.find((t) => (t.id || t.name) === activeTab);
    if (active && changedPaths.has(String(active.name).replace(/\\/g, "/"))) {
      void open(active.name, undefined, active.identity?.cwd || active.identity?.workspaceId || currentWorkspace);
    }
  }, [activeTab, tabs, currentWorkspace, refreshFiles, open]);

  const handleFileChanged = useCallback((changed) => {
    const paths = (Array.isArray(changed) ? changed : []).map((item) => String(item || "").replace(/\\/g, "/")).filter(Boolean);
    if (!paths.length) return;
    for (const path of paths) pendingFileChangesRef.current.add(path);
    if (!fileChangeTimerRef.current) {
      fileChangeTimerRef.current = window.setTimeout(flushFileChanges, 500);
    }
    // 地图正式文件：agent 写 style/config/layers 后要同时驱动会话绑定与预览刷新。
    // 只在当前会话尚未绑定项目时自动绑定；已有绑定时不因 agent 操作其它项目而误切。
    const changedMapProjects = new Set();
    for (const path of paths) {
      const match = path.match(/^maps\/([A-Za-z0-9_-]+)\//);
      if (match) changedMapProjects.add(match[1]);
    }
    if (!changedMapProjects.size) return;
    const boundProject = String(currentMapContext?.mapProject || "");
    const previewProject = String(mapPreviewTab?.payload?.project || "");
    if (!boundProject) {
      const projects = [...changedMapProjects];
      const nextProject = projects.includes(previewProject) ? previewProject : projects[0];
      setMapContexts((prev) => {
        if (String(prev[threadId]?.mapProject || "")) return prev;
        return { ...prev, [threadId]: mergeMapContext(prev[threadId], { mapProject: nextProject }) };
      });
    }
    if (!previewProject || changedMapProjects.has(previewProject) || !boundProject) {
      setMapPreviewRevision((value) => value + 1);
    }
  }, [flushFileChanges, currentMapContext, mapPreviewTab, threadId]);

  // 暴露 refreshSessions 给 ChatPanel（agent_end 时刷新）
  const handleAgentEnd = useCallback(() => {
    // 添加延迟让文件变更事件先处理
    setTimeout(() => {
      refreshSessions();
    }, 200);
  }, [refreshSessions]);

  // 一轮任务以 run_finished 为权威结束点：刷新产物列表，并自动打开本轮首个产物。
  // 用 runId 去重，避免 SSE 重连回放导致同一个文件重复打开或反复刷新。
  // B02：自动打开预览的策略来自外观设置（共享订阅，改设置立即生效）
  const appearance = useAppearance();
  const previewAutoOpen = appearance.previewAutoOpen;

  // B03：结果卡的交付入口 → 画布对应标签（带 runId，保证“本轮”语义）
  const openChangesForRun = useCallback((runId = "") => {
    setChangesRunId(String(runId || ""));
    openCanvasView("changes");
  }, [openCanvasView]);
  const openArtifactsForRun = useCallback((runId = "") => {
    setChangesRunId(String(runId || ""));
    setArtifactScope(runId ? "run" : "session");
    setArtifactSegment("artifacts");
    openCanvasView("artifacts");
  }, [openCanvasView]);
  // 面板里的“本轮/会话”切换是范围语义，不是选中某个历史 Run：
  // 点“本轮”回到最新一轮（清掉钉住的 runId），点“会话”保留当前 Run 选择但不展示。
  const handleArtifactScopeChange = useCallback((scope) => {
    setArtifactScope(scope === "session" ? "session" : "run");
    if (scope !== "session") setChangesRunId("");
  }, []);

  const handleRunFinished = useCallback((result = {}) => {
    const runId = String(result.runId || "");
    if (runId && autoOpenedRunRef.current.has(runId)) return;
    if (runId) {
      autoOpenedRunRef.current.add(runId);
      if (autoOpenedRunRef.current.size > 80) {
        const first = autoOpenedRunRef.current.values().next().value;
        if (first) autoOpenedRunRef.current.delete(first);
      }
    }
    setArtifactVersion((value) => value + 1);
    const artifacts = (Array.isArray(result.artifacts) ? result.artifacts : [])
      .map((item) => typeof item === "string" ? { path: item } : item)
      .filter((item) => item?.path && item.status !== "deleted");
    // 收尾时统一刷新一次当前预览，避免运行中漏掉最后一次 file_changed。
    flushFileChanges();
    // 文件树的短时高亮：本轮确实改了文件就打标（部分失败也算），
    // 由上面的 runId 去重保证重连回放不重播；2.6s 后自动清除，不常驻。
    if (artifacts.length) {
      const changed = new Set(artifacts.map((item) => fileBasename(item.path)).filter(Boolean));
      setChangedFiles(changed);
      if (changedFilesTimerRef.current) window.clearTimeout(changedFilesTimerRef.current);
      changedFilesTimerRef.current = window.setTimeout(() => setChangedFiles(new Set()), 2600);
    }
    const status = String(result.status || "completed").toLowerCase();
    if (!["completed", "success"].includes(status)) return;
    // O-P2（OAW_AUTO_TAB，默认关）：本轮产生文件产物时直达「产物」页签；
    // 用户 10s 内手动切换过页签视为锁定，不抢用户主动权。
    if (flag("autoTab") && artifacts.length && Date.now() - canvasTabManualAtRef.current > 10000) {
      openArtifactsForRun(runId);
      return;
    }
    const firstArtifact = artifacts[0];
    if (!firstArtifact) return;
    // B02 自动打开预览：never 从不；deliverable 仅通过验收的交付文件；requested 本轮有产物就打开
    if (previewAutoOpen === "never") return;
    if (previewAutoOpen === "deliverable") {
      const acceptanceStatus = String(firstArtifact.acceptanceStatus || firstArtifact.acceptance?.status || "");
      if (!["passed", "warning", "manual_review"].includes(acceptanceStatus)) return;
    }
    // 不抢用户焦点：正在输入、或正在看另一个文件时，只登记“本轮新产物”，
    // 由用户自己从工具菜单打开；同一文件已打开时允许刷新修订。
    const activeElement = typeof document !== "undefined" ? document.activeElement : null;
    const typing = Boolean(activeElement && (activeElement.tagName === "TEXTAREA" || activeElement.tagName === "INPUT" || activeElement.isContentEditable));
    const active = tabs.find((t) => (t.id || t.name) === activeTab);
    const activePath = String(active?.name || "").replace(/\\/g, "/");
    const artifactPath = String(firstArtifact.path || "").replace(/\\/g, "/");
    const viewingOther = Boolean(activeCanvasTab?.kind === "doc" && active && activePath !== artifactPath);
    if (typing || viewingOther) {
      setArtifactNotice({ path: firstArtifact.path, name: fileBasename(firstArtifact.path), runId, at: Date.now() });
      return;
    }
    setArtifactNotice(null);
    void open(firstArtifact.path, result.threadId || threadId, result.cwd || currentWorkspace);
  }, [activeCanvasTab?.kind, activeTab, currentWorkspace, flushFileChanges, open, previewAutoOpen, tabs, threadId]);

  // 收起画布但保留标签；把焦点还给顶栏的入口，键盘用户不丢位置。
  const collapseCanvas = useCallback(() => {
    setCanvasCollapsed(true);
    requestAnimationFrame(() => previewToggleRef.current?.focus());
  }, []);
  const closeObjects = useCallback(() => {
    closeCanvasTabById("view:objects");
    requestAnimationFrame(() => previewToggleRef.current?.focus());
  }, [closeCanvasTabById]);
  const closeWorkflows = useCallback(() => {
    closeCanvasTabById("view:workflows");
    requestAnimationFrame(() => previewToggleRef.current?.focus());
  }, [closeCanvasTabById]);
  // 顶栏整合菜单：点击外部 / Escape 关闭
  useEffect(() => {
    if (!topbarMenuOpen) return undefined;
    const onPointerDown = (event) => {
      if (!topbarToolsRef.current?.contains(event.target)) setTopbarMenuOpen(false);
    };
    const onKeyDown = (event) => { if (event.key === "Escape") setTopbarMenuOpen(false); };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [topbarMenuOpen]);
  useEffect(() => () => {
    if (changedFilesTimerRef.current) window.clearTimeout(changedFilesTimerRef.current);
    if (fileChangeTimerRef.current) window.clearTimeout(fileChangeTimerRef.current);
    pendingFileChangesRef.current.clear();
  }, []);

  // 用户自己打开了“本轮新产物”后，工具菜单里的提示自动消失。
  useEffect(() => {
    if (!artifactNotice) return;
    const noticeId = fileIdentityKey(makeFileIdentity({ workspaceId: currentWorkspace, relativePath: artifactNotice.path }));
    if (activeTab && activeTab === noticeId) setArtifactNotice(null);
  }, [activeTab, artifactNotice, currentWorkspace]);

  // ChatPanel 上报 pi 会话 id → 持久化（刷新后恢复当前对话）
  const handleSessionChange = useCallback((id) => {
    if (id) setCurrentSessionId(id);
  }, []);

  // ===== 界面状态固化（localStorage）=====
  const [uiRestored, setUiRestored] = useState(false); // 恢复是否完成（完成后才允许保存）
  const restoredSessionRef = useRef(false); // 会话恢复只执行一次
  // 上次会话 id 缓存：刷新后会话恢复前，保存逻辑不覆盖 lastSessionId（避免恢复竞态）
  const lastSessionIdRef = useRef(null);
  useEffect(() => {
    lastSessionIdRef.current = loadUIState()?.lastSessionId || null;
  }, []);

  // 恢复：只恢复工作区与必要的视图偏好。
  // 已批准规则（交接文档交互 4）：刷新/服务重启后停留在工作区根目录的空白新会话，
  // 不自动恢复旧子目录、旧会话或旧文件；历史会话与旧文件只走手动入口。
  useEffect(() => {
    if (uiRestored) return;
    if (!currentWorkspace) return; // 等待工作区列表就绪
    const saved = loadUIState();
    if (!saved) { setUiRestored(true); return; }
    (async () => {
      try {
        if (saved.workspace && !sameWorkspacePath(saved.workspace, currentWorkspace)) {
          const switched = await switchWorkspace(saved.workspace);
          setCurrentWorkspace(switched.workspace);
          setFiles(switched.files || []);
        }
      } catch {}
      // 目录一律回到工作区根：上一次的子目录不再恢复（曾被保存值带回旧列表）。
      currentDirRef.current = "";
      setCurrentDir("");
      void refreshFiles("");
      setActiveModule(null);
      // 旧状态没有 sidebarManualCollapsed，说明可能是历史遗留的自动收起；默认展开。
      sidebarManualCollapsedRef.current = saved.sidebarManualCollapsed === true;
      setSidebarOpen(!sidebarManualCollapsedRef.current);
      // 清掉会触发旧行为的持久化字段，避免遗留值继续自动恢复。
      saveUIState({ ...saved, currentDir: "", lastSessionId: null });
      setUiRestored(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentWorkspace]);

  // 已批准规则：刷新不再自动恢复上次会话。会话 id 与 thread 只在用户手动
  // 选择历史时使用；这里保留 ref 同步，但不再触发 handleSelectSession。
  useEffect(() => {
    sessionsRef.current = sessions;
    restoredSessionRef.current = true;
    lastSessionIdRef.current = null;
  }, [sessions]);

  // OAW_REPLAY_RECOVER（F2，默认关）：冷启动探测保存的 thread 是否仍有执行中的 Run。
  // 只提示 + 提供加载完整历史的入口，不自动恢复，符合已批准规则的语义边界。
  useEffect(() => {
    if (!uiRestored || !sessions.length) return undefined;
    let cancelled = false;
    const probe = async () => {
      if (cancelled || restoredRunProbedRef.current || !flag("replayRecover")) return;
      restoredRunProbedRef.current = true;
      const savedThreadId = localStorage.getItem("oaw_thread_id") || "";
      if (!savedThreadId) return;
      try {
        const result = await listRuns(savedThreadId, 5, { cwd: currentWorkspace || undefined });
        if (cancelled) return;
        const live = (result?.runs || []).find((item) => ["running", "queued", "waiting_user", "recovering", "cancel_requested", "finishing"].includes(item?.status));
        if (live) setRestoredRunHint({ threadId: savedThreadId });
      } catch {}
    };
    void probe();
    // 开关快照异步到达（初始全关）：就绪后再探测一次
    let off = false;
    flagsReady.then(() => { if (!off && !cancelled) void probe(); });
    return () => { cancelled = true; off = true; };
  }, [uiRestored, sessions.length, currentWorkspace]);

  // 用户已通过任意入口加载该会话历史后，提示自动消失
  useEffect(() => {
    if (restoredRunHint && historyThreadId === restoredRunHint.threadId) setRestoredRunHint(null);
  }, [historyThreadId, restoredRunHint]);

  // 保存：界面状态变化时写入 localStorage。
  // 只持久化工作区、目录与侧栏开关；不再写入 lastSessionId —— 刷新后必须进入
  // 空白新会话，旧会话只从历史列表手动打开（交接文档交互 4）。
  useEffect(() => {
    if (!uiRestored) return;
    saveUIState({
      // 不再持久化打开的标签与激活标签：刷新后回到主对话页，不自动恢复上次预览内容
      activeModule,
      workspace: currentWorkspace,
      currentDir,
      sidebarOpen,
      sidebarManualCollapsed: sidebarManualCollapsedRef.current,
    });
  }, [tabs, activeTab, activeModule, currentWorkspace, currentDir, sidebarOpen, currentSessionId, uiRestored]);

  const sharedChatPanel = (
      <ChatPanel
      ref={chatInputRef}
      clientId={clientId}
      threadId={threadId}
      workspace={currentWorkspace}
      project={currentProject}
      frozen={Boolean(currentSession?.frozen)}
      // 阶段 4：地图模式下用紧凑呈现（地图是主角，对话是辅助）。
      // 只影响视觉密度与能力预览折叠块，不动消息流、SSE 与工具栏功能。
      compact={activeModule === "map"}
      onFileChanged={(changed) => {
        handleFileChanged(changed);
        mapBridgeRef.current?.onFileChanged?.(changed);
      }}
      onMapAction={(action) => mapBridgeRef.current?.onMapAction?.(action)}
       // 地图项目不是“打开的文件”；不要再把「地图项目:x」塞进 currentDoc，
       // 否则提示词会同时出现伪文件与地图上下文，模型可能先尝试读取不存在的文件。
       // 地图模式下也不把画布里恰好打开的业务文档带进地图任务。
       currentDoc={activeModule === "map" ? null : current?.name}
       mapContext={boundMapProject ? currentMapContext : null}
       mapProject={boundMapProject || null}
      models={models}
      defaultModel={defaultModel}
      selectedModel={selectedModel}
      onModelChange={setSelectedModel}
      onAgentEnd={() => {
        handleAgentEnd();
        mapBridgeRef.current?.onAgentEnd?.();
      }}
      onRunFinished={handleRunFinished}
      onOpenRunChanges={openChangesForRun}
      onOpenRunArtifacts={openArtifactsForRun}
      onOpenSubagent={openSubagentDetail}
      onSubagentUpdate={handleSubagentUpdate}
      onOpenSettings={() => setActiveModule("settings")}
      onTeamChange={handleTeamChange}
      onModeChange={setConversationMode}
      onPhaseChange={setConversationPhase}
      onBrowserActivity={handleBrowserActivity}
      historyMessages={historyMessages}
      historyThreadId={historyThreadId}
      historyWindow={historyWindow}
      historyHydrating={historyLoading}
      sessionId={currentSessionId || ""}
      agentReady={agentReady}
      onLoadOlderHistory={loadOlderSessionHistory}
      onReloadHistory={reloadCurrentSessionHistory}
      onLinksChange={setChatLinks}
      onNewSession={(ws, opts) => handleNewSession(ws, opts)}
      onOpenFile={handleChatOpenFile}
      referenceFiles={files.map((file) => currentDir ? currentDir + "/" + file.name : file.name)}
      sessions={visibleSessions}
      sessionAgentId={currentSession?.agentId || ""}
      onSelectSession={handleSelectSession}
      onSessionChange={handleSessionChange}
      onRefreshSessions={refreshSessions}
      onDeleteSession={handleDeleteSession}
      onBatchDeleteSession={handleBatchDeleteSessions}
      onArchiveSession={handleArchiveSession}
      onBatchArchiveSession={handleBatchArchiveSessions}
      unreadByThread={unreadByThread}
      onForkSession={handleForkSession}
      onPinSession={handlePinSession}
      onFreezeSession={handleFreezeSession}
    />
  );

  return (
    <AppErrorBoundary>
      <div className={`app ${canvasMaximized ? "canvas-maximized" : ""} ${browserFullscreen ? "browser-fullscreen" : ""} ${sidebarOpen ? "sidebar-expanded" : "sidebar-collapsed"} ${activeModule === "map" ? "map-module-active" : ""}`}>
        <RefreshBloom />
        <FeedbackHost />
        {/* 构建版本守卫：dist 保留历史 assets，已打开的页面不会自己失效，
            部署新构建后必须主动提示，否则用户会一直跑旧代码并把"已修好"当成"没修"。 */}
        {staleBuild && (
          <div className="load-recovery" role="alert" title={`运行中：${staleBuild.running}\n服务端：${staleBuild.latest}`}>
            <Icon name="refresh" size={14} />
            <span>检测到新版本（本页仍在用旧构建），刷新后生效。</span>
            <button className="btn-xs" onClick={() => window.location.reload()}>立即刷新</button>
            <button className="btn-xs" onClick={() => setStaleBuild(null)}>稍后</button>
          </div>
        )}
        {loadFailureText && (
          <div
            className="load-recovery"
            role="alert"
            title={loadFailures.map(([scope, message]) => `${LOAD_SCOPE_LABELS[scope] || scope}：${message}`).join("\n")}
          >
            <Icon name="warning" size={14} />
            <span>{loadFailureText}</span>
            <button className="btn-xs" onClick={retryStartupLoads} disabled={loadRetrying}>{loadRetrying ? "重试中…" : "重试"}</button>
          </div>
        )}
        {activeModule === "knowledge" && (
          <DeferredModule label="知识库">
          <KnowledgeBase
            clientId={clientId}
            workspace={currentWorkspace}
            project={currentProject}
            models={models}
            defaultModel={defaultModel}
            onPromoteToAgent={handlePromoteToAgent}
            onExit={(marks) => {
              closeExternalModules();
              if (marks?.length) {
                setTimeout(() => {
                  for (const m of marks) chatInputRef.current?.insertText(m + " ");
                }, 120);
              }
            }}
            onAtMention={insertChatText}
          />
          </DeferredModule>
        )}
        {activeModule === "templates" && (
          <DeferredModule label="模板库">
          <TemplateLibrary
            onExit={(marks) => {
              // 返回时统一把累积的 @标记 插入对话（支持一次多个）
              closeExternalModules();
              if (marks?.length) {
                setTimeout(() => {
                  for (const m of marks) insertChatText(m);
                }, 120);
              }
            }}
            onOpenFile={open}
            onAtMention={insertChatText}
          />
          </DeferredModule>
        )}
        {activeModule === "map" && (
          <DeferredModule label="地图">
          <MapPanel
            onExit={closeExternalModules}
            onOpenFile={open}
            clientId={clientId}
            threadId={threadId}
            workspace={currentWorkspace}
            models={models}
            defaultModel={defaultModel}
            onAgentEnd={handleAgentEnd}
            onNewSession={() => handleNewSession()}
            historyMessages={historyMessages}
            sessions={visibleSessions}
            currentSessionId={currentSessionId}
            onSelectSession={handleSelectSession}
            onSessionChange={handleSessionChange}
            onRefreshSessions={refreshSessions}
            onFocusRun={(run) => chatInputRef.current?.focusRun?.(run?.id)}
            onProjectChange={(name) => setMapContexts((prev) => ({ ...prev, [threadId]: mergeMapContext(prev[threadId], { mapProject: name }) }))}
            conversationMode={conversationMode}
            onModeChange={(next) => {
              // 与主对话的模式切换同源：先让 ChatPanel 真正切模式，成功后再更新状态，
              // 避免"按钮变了但 Agent 还是旧模式"。
              const switched = chatInputRef.current?.setMode?.(next);
              if (switched !== false) setConversationMode(next);
            }}
            hideChat
            chatVisible={mapChatVisible}
            onToggleChat={() => setMapChatVisible((value) => !value)}
            bridgeRef={mapBridgeRef}
            mapContext={currentMapContext}
            onMapChanged={() => setMapPreviewRevision((value) => value + 1)}
            initialProject={currentMapProject}
            onViewportChange={(context) => setMapContexts((prev) => ({ ...prev, [threadId]: mergeMapContext(prev[threadId], context) }))}
            // 阶段 2：可视面板的"交给 Agent"把意图填进全局对话栏输入框（复用同一实例，消息流连续）
            insertChatText={insertChatText}
          />
          </DeferredModule>
        )}
        {activeModule === "map" && mapChatVisible && (
          <Resizer
            className="map-chat-resizer"
            side="right"
            min={300}
            max={620}
            cssVar="--map-chat-w"
          />
        )}
        {/* 地图模式保留主布局挂载：对话面板必须常驻，否则进入/退出地图会卸载 ChatPanel，
            本地消息、SSE 游标与运行态全部丢失，服务端回放只会重建孤立总结卡。
            地图覆盖层由 .mp 负责遮罩，对话槽位在地图模式下用 CSS 固定到右侧。 */}
        {/* 2026-11-06（P1-5）：知识库/模板库改为「隐藏」而非卸载主布局。
            卸载会丢 ChatPanel 的 messages、SSE 游标与 streamGeneration，返回时只能
            从 after=0 重连并受服务端 300 条回放上限影响（表现为"变样/丢内容"）。
            app-main-shell 可见时 display:contents，不改变既有 flex 布局。 */}
        <div className="app-main-shell" hidden={["knowledge", "templates"].includes(activeModule)}>
        <>
        {sidebarOpen && (
          <>
            <SessionSidebar
              files={files}
              currentName={current?.name}
              onOpenFile={open}
              onRefreshFiles={refreshFiles}
              onUploaded={refreshFiles}
              projects={projects}
              currentProjectId={currentProject?.id || ""}
              onProjectChange={handleProjectChange}
              // v0.13.8：工作区菜单「创建新任务」——在该项目工作区下新建会话
              onCreateTask={(project) => { handleNewSession(project?.rootPath || undefined); }}
              workspaces={workspaces}
              currentWorkspace={currentWorkspace}
              onWorkspaceChange={handleWorkspaceChange}
              currentDir={currentDir}
              onDirChange={handleDirChange}
              onAtMention={handleAtMention}
              loadStatus={loadStatus}
              changedFiles={changedFiles}
              onProjectUpdated={refreshProjects}
              models={models}
              clientId={clientId}
              threadId={threadId}
              activeModel={selectedModel}
              onModelChange={setSelectedModel}
              sessions={sessions}
              unreadByThread={unreadByThread}
              onSelectSession={handleSelectSession}
              onRefreshSessions={refreshSessions}
              onDeleteSession={handleDeleteSession}
              onBatchDeleteSession={handleBatchDeleteSessions}
              onArchiveSession={handleArchiveSession}
              onBatchArchiveSession={handleBatchArchiveSessions}
              onRenameSession={handleRenameSession}
              onForkSession={handleForkSession}
              onPinSession={handlePinSession}
              onFreezeSession={handleFreezeSession}
              onOpenSkills={() => openExternalModule("skills")}
              onOpenAgents={() => openExternalModule("agents")}
              onOpenKnowledgeBase={() => openExternalModule("knowledge")}
              onOpenTemplates={() => openExternalModule("templates")}
              onOpenMap={() => openExternalModule("map")}
               onOpenTasks={() => openExternalModule("tasks")}
               onOpenMcp={() => openExternalModule("mcp")}
               onOpenPiPlugins={() => openExternalModule("piPlugins")}
               onOpenSettings={(tab = "settings") => { if (tab === "memory") setSettingsModuleTab("memory"); else { setSettingsModuleTab("settings"); setSettingsSection(tab === "project" ? "project" : "model"); } openExternalModule("settings"); }}
               onOpenArtifacts={() => openExternalModule("artifacts")}
              onBeforeOpenModal={closeExternalModules}
              onOpenCommandPalette={() => setPaletteOpen(true)}
              onToggleTheme={toggleTheme}
              onCollapseSidebar={() => { sidebarManualCollapsedRef.current = true; setSidebarOpen(false); }}
              theme={theme}
            />
            <Resizer side="left" min={180} max={400} cssVar="--sidebar-w" />
          </>
        )}
        <div className="center-area">
          <div className="center-content">
            <div className="topbar">
              {!sidebarOpen && (
                <button className="btn-sm topbar-sidebar-toggle" onClick={() => { sidebarManualCollapsedRef.current = false; setSidebarOpen(true); }} title="展开侧栏" aria-label="展开侧栏">
                  <Icon name="chevronRight" size={14} />
                </button>
              )}
            <span className="topbar-title">
              <Icon name="comment" size={16} />
              <span>{currentSession?.title || currentSession?.label || currentProject?.name || "新建 Agent 会话"}</span>
              {current?.name && <span className="topbar-file"> · {current.name}</span>}
            </span>
            {/* 对话工作模式已移入输入栏工具条（ChatPanel），顶栏只保留会话状态与团队入口，
                给标题留出完整宽度。 */}
            <span className={`conversation-status ${conversationPhase ? "working" : ""}`}><i /> {conversationPhase || "待命"}</span>
            <TeamHeaderChip
              team={agentTeam}
              active={activeCanvasTab?.kind === "team" && canvasOpen}
              onOpen={openTeamTab}
            />
            {/* v0.13.8：顶栏搜索入口——聚焦既有命令面板（Ctrl/Cmd+K 同源），不新建搜索后端 */}
            <提示气泡 label="搜索（命令面板）">
              <button
                type="button"
                className="btn-sm topbar-search-btn"
                onClick={() => setPaletteOpen(true)}
                aria-label="搜索（打开命令面板）"
                title="搜索（Ctrl/Cmd+K）"
              >
                <Icon name="search" size={14} />
              </button>
            </提示气泡>
            <div className="topbar-tools" ref={topbarToolsRef}>
              <提示气泡 label="工作区">
                <button
                  ref={previewToggleRef}
                  className={`btn-sm topbar-tools-toggle ${topbarMenuOpen ? "active" : ""}`}
                  onClick={() => setTopbarMenuOpen((v) => !v)}
                  aria-label="工作区"
                  aria-expanded={topbarMenuOpen}
                  aria-haspopup="dialog"
                  title="工作区：文件、产物、改动、浏览器与任务中心"
                >
                  <Icon name="columns" size={14} />
                  {(Object.values(unreadByThread).reduce((sum, count) => sum + Number(count || 0), 0) > 0 || artifactNotice) && <i className="topbar-tools-dot" aria-hidden="true" />}
                </button>
              </提示气泡>
              {/* 工作区面板（2026-11-03）：把原来的下拉菜单换成卡片面板。
                  每个卡片仍调用原来的打开逻辑，不新增页面、不改页面内部。 */}
              {topbarMenuOpen && (
                <div className="topbar-tools-panel" role="dialog" aria-label="工作区">
                  <div className="topbar-tools-panel-head">
                    <span className="topbar-tools-panel-title"><Icon name="folder" size={13} /> 工作区</span>
                    <span className="topbar-tools-panel-sub" title={currentWorkspace || ""}>
                      {currentWorkspace ? pathBaseName(currentWorkspace) : "未选择工作区"}
                    </span>
                  </div>
                  <div className="topbar-tools-cards">
                    <button
                      type="button"
                      className={`topbar-tools-card ${canvasSideVisible ? "on" : ""}`}
                      onClick={() => { setTopbarMenuOpen(false); if (!canvasOpen) openCanvasView("artifacts"); setCanvasSideOpen(true); }}
                      title="浏览会话工作区的文件"
                    >
                      <Icon name="folder" size={15} />
                      <span><strong>工作区文件</strong><small>浏览会话工作区的文件</small></span>
                    </button>
                    <button
                      type="button"
                      className="topbar-tools-card"
                      onClick={() => { setTopbarMenuOpen(false); setArtifactSegment("artifacts"); openCanvasView("artifacts"); }}
                      title="打开工作产物：任务摘要 / 产物 / 链接"
                    >
                      <Icon name="package" size={15} />
                      <span><strong>工作产物</strong><small>任务摘要、产物与链接</small></span>
                    </button>
                    <button
                      type="button"
                      className="topbar-tools-card"
                      onClick={() => { setTopbarMenuOpen(false); openCanvasView("changes"); }}
                      title="打开改动：本轮文件变化"
                    >
                      <Icon name="history" size={15} />
                      <span><strong>本轮改动</strong><small>本轮文件变化</small></span>
                    </button>
                    <button
                      type="button"
                      className={`topbar-tools-card ${browserOpen ? "on" : ""}`}
                      onClick={() => {
                        setTopbarMenuOpen(false);
                        if (browserOpen) { closeBrowserPanel(); return; }
                        browserAutoOpenBlockedRef.current = false;
                        setBrowserActivityPing(0);
                        openCanvasView("browser");
                      }}
                      title={browserOpen ? "关闭内置浏览器标签" : "打开内置浏览器标签"}
                    >
                      <Icon name="globe" size={15} />
                      <span><strong>内置浏览器</strong><small>{browserOpen ? "点击关闭浏览器标签" : "浏览网页"}</small></span>
                      {browserActivityPing > 0 && !browserOpen && <i className="browser-activity-dot" aria-hidden="true" />}
                    </button>
                    <button
                      type="button"
                      className="topbar-tools-card"
                      onClick={() => { setTopbarMenuOpen(false); taskCenterRef.current?.open(); }}
                      title="任务中心：并行任务、运行状态与历史会话"
                    >
                      <Icon name="list" size={15} />
                      <span><strong>任务中心</strong><small>并行任务与运行状态</small></span>
                    </button>
                  </div>
                  {(artifactNotice || flag("qoderObjectBar") || flag("domainWorkflows")) && (
                    <div className="topbar-tools-more">
                      <span className="topbar-tools-more-label">更多工具</span>
                      {artifactNotice && (
                        <button
                          type="button"
                          onClick={() => {
                            const target = artifactNotice;
                            setTopbarMenuOpen(false);
                            setArtifactNotice(null);
                            void open(target.path, threadId, currentWorkspace);
                          }}
                          title={`打开本轮新产物：${artifactNotice.path}`}
                        >
                          <Icon name="file" size={13} /><span>本轮新产物：{artifactNotice.name}</span>
                        </button>
                      )}
                      {flag("qoderObjectBar") && (
                        <button
                          type="button"
                          onClick={() => { setTopbarMenuOpen(false); if (objectsOpen) closeObjects(); else openCanvasView("objects"); }}
                          title={objectsOpen ? "关闭对象栏标签" : "打开对象栏：本轮产出 / 来源 / 技能 / 记忆汇总"}
                        >
                          <Icon name="layers" size={13} /><span>对象栏</span>
                        </button>
                      )}
                      {flag("domainWorkflows") && (
                        <button
                          type="button"
                          onClick={() => { setTopbarMenuOpen(false); if (workflowsOpen) closeWorkflows(); else openCanvasView("workflows"); }}
                          title={workflowsOpen ? "关闭领域工作流标签" : "打开领域工作流：阶段 / 工具白名单 / 预算 / 产物契约与预检试算"}
                        >
                          <Icon name="flow" size={13} /><span>领域工作流</span>
                        </button>
                      )}
                    </div>
                  )}
                  <div className="topbar-tools-foot">
                    <button
                      type="button"
                      onClick={() => { setTopbarMenuOpen(false); handleNewSession(undefined, { agentId: currentSession?.agentId || "" }); }}
                      disabled={creatingSession}
                      title={currentSession?.agentId ? "新建对话（沿用当前会话的智能体）" : "新建对话"}
                    >
                      <Icon name="chatPlus" size={14} /><span>新建对话</span>
                    </button>
                  </div>
                </div>
              )}
              <TaskCenter
                ref={taskCenterRef}
                sessions={visibleSessions}
                projects={projects}
                currentProjectId={currentProject?.id || ""}
                currentWorkspace={currentWorkspace}
                currentThreadId={threadId}
                currentSessionId={currentSessionId}
                unreadCount={Object.values(unreadByThread).reduce((sum, count) => sum + Number(count || 0), 0)}
                onSelectSession={handleSelectSession}
                onFocusRun={(run) => chatInputRef.current?.focusRun?.(run?.id)}
                onOpenRun={handleOpenRun}
                eventVersion={eventVersion}
                anchorRef={previewToggleRef}
                hideTrigger
              />
            </div>
            </div>
            {!activeModule && sessionResumeError && (
              <div className="session-resume-warning" role="alert">
                <Icon name="warning" size={14} />
                <span>
                  历史已加载为只读：Agent 会话恢复失败（{sessionResumeError.message}），继续对话前请先重试恢复。
                  {resumeWaitSec > 0 && (
                    <> 已等待 {resumeWaitSec}s，将自动重试{sessionResumeError.detail?.busyForMs ? `（任务已运行 ${Math.round(sessionResumeError.detail.busyForMs / 1000)}s）` : ""}。</>
                  )}
                </span>
                {sessionResumeError.code === "SESSION_BUSY" && sessionResumeError.detail?.activeRunId && (
                  <button className="btn-xs" onClick={async () => { try { await cancelRun(sessionResumeError.detail.activeRunId, "用户请求取消以恢复会话"); } catch {}}}>取消当前任务</button>
                )}
                <button className="btn-xs" onClick={() => retrySessionResume()} disabled={sessionResumeRetrying}>{sessionResumeRetrying ? "恢复中…" : "重试恢复"}</button>
              </div>
            )}
            {/* 交互 2：新建失败必须可见。旧实现只 console.warn，界面照常清空，
                用户以为已建好新会话。现在保留旧会话与草稿，并给出重试入口。 */}
            {!activeModule && newSessionError && (
              <div className="session-resume-warning" role="alert">
                <Icon name="warning" size={14} />
                <span>新建会话失败：{newSessionError.message}（已保留当前会话与未发送内容）</span>
                <button className="btn-xs" onClick={() => handleNewSession()} disabled={creatingSession}>{creatingSession ? "创建中…" : "重试新建"}</button>
                <button className="btn-xs" onClick={() => setNewSessionError(null)}>忽略</button>
              </div>
            )}
            {/* 交互 8：工作区切换失败保留原目录与列表，说明失败原因并允许重试。 */}
            {!activeModule && workspaceSwitchError && (
              <div className="session-resume-warning" role="alert">
                <Icon name="warning" size={14} />
                <span>切换工作区失败：{workspaceSwitchError.message}（已保留原工作区与文件列表）</span>
                <button className="btn-xs" onClick={() => { const target = workspaceSwitchError.workspace; setWorkspaceSwitchError(null); handleWorkspaceChange(target); }}>重试切换</button>
                <button className="btn-xs" onClick={() => setWorkspaceSwitchError(null)}>忽略</button>
              </div>
            )}
            {/* OAW_REPLAY_RECOVER（F2，默认关）：运行中刷新后提示可加载完整历史（复用现有横幅样式，零新样式） */}
            {!activeModule && restoredRunHint && (
              <div className="session-resume-warning" role="status">
                <Icon name="warning" size={14} />
                <span>检测到该会话仍有任务在执行，实时进度已恢复；可加载该会话的完整历史上下文。</span>
                <button className="btn-xs" onClick={() => {
                  const target = sessions.find((s) => (s.threadId || s.id) === restoredRunHint.threadId);
                  setRestoredRunHint(null);
                  if (target) handleSelectSession(target);
                }}>加载完整历史</button>
                <button className="btn-xs" onClick={() => setRestoredRunHint(null)}>忽略</button>
              </div>
            )}
            {/* 对话面板常驻挂载：设置/成果/任务中心是覆盖在上面的浮层（.module-view），
                不能用 !activeModule 把会话流卸载——卸载会丢掉全部本地状态，
                回到对话时整段会话要重新水合（表现为"变样"、底部工具条图标闪烁重载）。 */}
            <div className={`center-chat-slot${activeModule === "map" ? " map-mode" : ""}${activeModule === "map" && !mapChatVisible ? " map-chat-hidden" : ""}`}>{sharedChatPanel}</div>
          </div>
        </div>
        {canvasOpen && (
          <Resizer
            side="right"
            min={320}
            max={760}
            cssVar="--canvas-w"
            onResizeEnd={(width) => { setCanvasWidth(width); saveCanvasWidth(width, canvasSideWidth); }}
          />
        )}
        {canvasOpen && (
          <aside className={`app-canvas-slot ${canvasMaximized ? "canvas-maximized" : ""}`} aria-label="工作区画布">
            <画布标签栏
              tabs={canvasTabs}
              activeId={canvasActiveId}
              onActivate={activateCanvasTabById}
              onClose={closeCanvasTabById}
              onReorder={(fromId, toId) => setCanvasTabs((prev) => reorderCanvasTabs(prev, fromId, toId))}
              onCollapse={collapseCanvas}
              onToggleMaximize={() => setCanvasMaximized((value) => !value)}
              maximized={canvasMaximized}
              onPlusAction={(action) => {
                if (action === "files") { setCanvasSideOpen((value) => !value); if (!canvasOpen) openCanvasView("artifacts"); return; }
                if (action === "artifacts") { setArtifactSegment("artifacts"); openCanvasView("artifacts"); return; }
                if (action === "changes") { openCanvasView("changes"); return; }
                if (action === "browser") { browserAutoOpenBlockedRef.current = false; setBrowserActivityPing(0); openCanvasView("browser"); return; }
                if (action === "objects") { openCanvasView("objects"); return; }
                if (action === "workflows") { openCanvasView("workflows"); }
              }}
              onSearch={() => setPaletteOpen(true)}
              onToggleFiles={() => setCanvasSideOpen((value) => !value)}
              filesOpen={canvasSideVisible}
              onNewChat={async () => { await handleNewSession(currentWorkspaceRef.current || currentWorkspace); chatInputRef.current?.focusInput?.(); }}
              mapSessions={recentMapSessions}
              onOpenMapSession={async (session) => { await handleSelectSession(session); setActiveModule("map"); }}
              showObjects={flag("qoderObjectBar")}
              showWorkflows={flag("domainWorkflows")}
              browserActivityPing={browserActivityPing}
              browserFullscreen={browserFullscreen}
              onToggleBrowserFullscreen={() => setBrowserFullscreen((value) => !value)}
            />
            <div className={`canvas-workarea ${canvasSideVisible ? "with-side" : ""}`}>
              <div className="canvas-main">
                {tabs.length > 0 && (
                  <div className={`app-canvas-body canvas-body-doc ${activeCanvasTab?.kind === "doc" ? "" : "canvas-hidden"}`}>
                    <Suspense fallback={<div className="module-loading">正在加载文档预览…</div>}>
                      <DocViewer
                        tabs={tabs}
                        activeTab={activeTab}
                        hideTabBar
                        onOpenFile={open}
                        loading={docLoading}
                        onSendToAgent={insertChatText}
                        onInsertContext={(t) => chatInputRef.current?.insertContext(t)}
                        onDirtyChange={handleDocDirtyChange}
                      />
                    </Suspense>
                  </div>
                )}
                {canvasTabs.some((tab) => tab.kind === "artifacts") && (
                  <div className={`app-canvas-body canvas-body-artifacts ${activeCanvasTab?.kind === "artifacts" ? "" : "canvas-hidden"}`}>
                    <ArtifactPanel
                      workspace={currentWorkspace}
                      projectId={currentProject?.id || ""}
                      currentSessionId={currentSessionId}
                      selectedRunId={changesRunId}
                      artifactScope={artifactScope}
                      artifactScopePinned={Boolean(changesRunId)}
                      onArtifactScopeChange={handleArtifactScopeChange}
                      refreshToken={artifactVersion}
                      onOpenFile={open}
                      links={chatLinks}
                      segment={artifactSegment}
                      onSegmentChange={setArtifactSegment}
                    />
                  </div>
                )}
                {canvasTabs.some((tab) => tab.kind === "changes") && (
                  <div className={`app-canvas-body canvas-body-changes ${activeCanvasTab?.kind === "changes" ? "" : "canvas-hidden"}`}>
                    <RunChangesPanel
                      workspace={currentWorkspace}
                      projectId={currentProject?.id || ""}
                      currentSessionId={currentSessionId}
                      selectedRunId={changesRunId}
                      refreshToken={artifactVersion}
                      onOpenFile={open}
                    />
                  </div>
                )}
                {mapPreviewTab && (
                  <div className={`app-canvas-body canvas-body-map ${activeCanvasTab?.kind === "mapPreview" ? "" : "canvas-hidden"}`}>
                    <div className="canvas-map-preview">
                      <MiniMapPreview
                        project={mapPreviewTab.payload?.project || currentMapProject}
                        view={mapPreviewTab.payload?.view || null}
                        height="100%"
                        refreshToken={mapPreviewRevision}
                        onOpen={() => setActiveModule("map")}
                      />
                    </div>
                  </div>
                )}
                {browserOpen && (
                  <div className={`app-canvas-body canvas-body-browser ${activeCanvasTab?.kind === "browser" ? "" : "canvas-hidden"}`}>
                    {/* T1：面板只在浏览器画布标签为激活页时连帧流；隐藏的其他画布标签不挂流 */}
                    <BrowserPanel clientId={clientId} threadId={threadId} visible={activeCanvasTab?.kind === "browser"} fullscreen={browserFullscreen} onToggleFullscreen={() => setBrowserFullscreen((value) => !value)} />
                  </div>
                )}
                {objectsOpen && (
                  <div className={`app-canvas-body canvas-body-objects ${activeCanvasTab?.kind === "objects" ? "" : "canvas-hidden"}`}>
                    <对象栏
                      workspace={currentWorkspace}
                      projectId={currentProject?.id || ""}
                      model={selectedModel || defaultModel}
                      references={tabs.map((tab) => ({ label: tab.name, kind: "文件" }))}
                      clientId={clientId}
                      threadId={threadId}
                      onClose={closeObjects}
                    />
                  </div>
                )}
                {workflowsOpen && (
                  <div className={`app-canvas-body canvas-body-workflows ${activeCanvasTab?.kind === "workflows" ? "" : "canvas-hidden"}`}>
                    <工作流启动器 onClose={closeWorkflows} />
                  </div>
                )}
                {canvasTabs.some((tab) => tab.kind === "team") && (
                  <div className={`app-canvas-body canvas-body-team ${activeCanvasTab?.kind === "team" ? "" : "canvas-hidden"}`}>
                    <TeamPanel team={agentTeam} onOpenTranscript={openSubagentDetail} />
                  </div>
                )}
                {canvasTabs.filter((tab) => tab.kind === "subagent").map((tab) => (
                  <div key={tab.id} className={`app-canvas-body canvas-body-subagent ${activeCanvasTab?.id === tab.id ? "" : "canvas-hidden"}`}>
                    <子代理详情面板 block={tab.payload?.block || null} />
                  </div>
                ))}
              </div>

              {canvasSideVisible && (
                <>
                  <Resizer
                    side="right"
                    min={200}
                    max={340}
                    cssVar="--canvas-side-w"
                    className="canvas-side-resizer"
                    onResizeEnd={(width) => { setCanvasSideWidth(width); saveCanvasWidth(canvasWidth, width); }}
                  />
                  <aside className="canvas-side" aria-label="工作区文件树">
                    <文件树抽屉
                      workspace={currentWorkspace}
                      currentName={current?.name || ""}
                      onOpenFile={open}
                      onClose={() => setCanvasSideOpen(false)}
                      refreshToken={artifactVersion}
                    />
                  </aside>
                </>
              )}
            </div>

          </aside>
        )}
        <DeferredModule label="技能管理">
        <SkillsManager
          open={activeModule === "skills"}
          fullPage
          onClose={closeExternalModules}
          clientId={clientId}
          workspace={currentWorkspace}
          project={currentProject}
          models={models}
          defaultModel={defaultModel}
          selectedModel={selectedModel}
          onModelChange={setSelectedModel}
          onPromoteToAgent={handlePromoteToAgent}
          onAtMention={(value) => insertChatText(String(value || "").startsWith("@") ? value : `@${value}`)}
        />
        </DeferredModule>
        <DeferredModule label="智能体广场">
        <AgentMarket
          open={activeModule === "agents"}
          fullPage
          onClose={closeExternalModules}
          onAtMention={insertChatText}
          onPromoteToAgent={handlePromoteToAgent}
          workspace={currentWorkspace}
        />
        </DeferredModule>
        <DeferredModule label={activeModule === "mcp" ? "MCP" : "Pi 插件"}>
        <IntegrationsCenter kind={activeModule === "mcp" ? "mcp" : "pi"} open={activeModule === "mcp" || activeModule === "piPlugins"} onClose={closeExternalModules} />
        </DeferredModule>
        </>
        </div>
        {/* 重复入口已整合：预览/浏览器的唯一开关在顶栏，打开内容统一进入右侧画布页签 */}
         <DeferredModule label="命令面板">
        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          onOpenFile={open}
          onKb={() => openExternalModule("knowledge")}
          onTpl={() => openExternalModule("templates")}
          onMap={() => openExternalModule("map")}
          onSession={handleSelectSession}
        />
         </DeferredModule>
         {activeModule === "settings" && (
           <div className="module-view">
             <div className="module-head">
               <提示气泡 label="返回对话">
                 <button className="module-back" onClick={closeExternalModules} aria-label="返回对话"><Icon name="back" size={15} /></button>
               </提示气泡>
               <div className="module-brand-heading"><Logo size={22} /><span><h2>设置</h2><p>外观、模型、项目运行和工作区记忆</p></span></div>
               <div className="module-head-tabs">
                 <button className={settingsModuleTab === "settings" ? "active" : ""} onClick={() => setSettingsModuleTab("settings")}>设置</button>
                 <button className={settingsModuleTab === "memory" ? "active" : ""} onClick={() => setSettingsModuleTab("memory")}>记忆与沉淀</button>
               </div>
             </div>
             <div className="module-body module-settings-body">
               {settingsModuleTab === "memory"
                 ? <MemoryTab workspace={currentWorkspace} projectId={currentProject?.id || ""} />
                 : <SettingsPanel project={currentProject} projects={projects} currentWorkspace={currentWorkspace} models={models} defaultModel={defaultModel} activeModel={selectedModel} clientId={clientId} threadId={threadId} initialSection={settingsSection} onSessionsChanged={refreshSessions} onModelChange={setSelectedModel} onModelsRefresh={refreshModelCatalog} onProjectUpdated={refreshProjects} onProjectSelect={(id) => { closeExternalModules(); handleProjectChange(id); }} />}
             </div>
           </div>
         )}
         {activeModule === "artifacts" && (
           <div className="module-view">
             <div className="module-head">
               <提示气泡 label="返回对话">
                 <button className="module-back" onClick={closeExternalModules} aria-label="返回对话"><Icon name="back" size={15} /></button>
               </提示气泡>
               <div className="module-brand-heading"><Logo size={22} /><span><h2>成果</h2><p>查看、验收、固定和回滚工作产物</p></span></div>
             </div>
             <div className="module-body module-artifacts-body">
               <WorkProductPanel tab="artifacts" clientId={clientId} threadId={threadId} workspace={currentWorkspace} projectId={currentProject?.id || ""} currentSessionId={currentSessionId} refreshToken={artifactVersion} onOpenFile={(name, thread, cwd) => { closeExternalModules(); open(name, thread, cwd); }} />
             </div>
           </div>
         )}
         {activeModule === "tasks" && (
           <DeferredModule label="任务中心"><TaskCenter
             fullPage
             onClose={closeExternalModules}
             sessions={visibleSessions}
             projects={projects}
             currentProjectId={currentProject?.id || ""}
             currentWorkspace={currentWorkspace}
             currentThreadId={threadId}
             currentSessionId={currentSessionId}
             unreadCount={Object.values(unreadByThread).reduce((sum, count) => sum + Number(count || 0), 0)}
             onSelectSession={handleSelectSession}
             onFocusRun={(run) => chatInputRef.current?.focusRun?.(run?.id)}
             onOpenRun={handleOpenRun}
             eventVersion={eventVersion}
           /></DeferredModule>
         )}
       </div>
    </AppErrorBoundary>
  );
}
