import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { confirmArtifactAcceptance, getRun, getRunAcceptance, listPublishedArtifacts, listRuns, publishArtifact, rollbackPublishedArtifact } from "../api.js";
import Icon from "./Icon.jsx";
import { notifyError, askText, askConfirm } from "./Feedback.jsx";
import { artifactStatusInfo } from "./验收状态.js";
import FileChangesPanel from "./FileChangesPanel.jsx";
import 子代理详情面板 from "./子代理详情面板.jsx";
import { projectRunView } from "../运行展示投影.js";

const statusText = { running: "执行中", queued: "排队中", waiting_user: "等待回答", recovering: "恢复中", completed: "已完成", failed: "失败", cancelled: "已取消", aborted: "已中断" };

function artifactName(path) {
  return String(path || "").split(/[\\/]/).pop() || "未命名产物";
}

// run-window / unattributed 只是“运行窗口内疑似变更”，不能计入本轮产物；
// 只有 write-ledger（或有旧数据里的明确 artifact 来源）才进入交付计数。
function isSuspectedArtifact(artifact) {
  return artifact?.source === "run-window" || artifact?.source === "unattributed";
}

// O-P4：原 EventStream 组件（tab === "events"）为不可达死代码，已整体移除；
// 事件轨迹由「改动」页签的 Run 事件与子代理详情面板承接。

function ArtifactPanel({ workspace, projectId, currentSessionId, selectedRunId = "", artifactScope = "session", artifactScopePinned = false, onArtifactScopeChange, refreshToken = 0, onOpenFile }) {
  const [runs, setRuns] = useState([]);
  const [published, setPublished] = useState([]);
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState("");
  const [acceptance, setAcceptance] = useState({});
  // 交互 6：读取失败、请求中、确实为空、保留旧数据必须是不同状态。
  // 旧实现把 Promise.all 的失败吞进 catch{}，界面照常显示"暂未生成产物"，
  // 用户无法区分"没做"与"读不到"。
  const [loadError, setLoadError] = useState(null); // { message, source }
  const [staleAt, setStaleAt] = useState(null); // 保留旧数据时的最后成功时间
  const refreshSeqRef = useRef(0);
  const refreshRef = useRef(null);

  const refresh = async () => {
    const requestSeq = ++refreshSeqRef.current;
    setLoading(true);
    setLoadError(null);
    // 两次读取分开处理：一项失败不应该把另一项的结果也丢掉，失败信息要指明来源。
    // 本面板语义是“当前会话的产物”：有会话时按会话查询，避免工作区被切走/服务重启
    // 回到默认工作区后，本会话的 Run 被工作区过滤掉，面板误显“本轮暂未生成产物”。
    const [runResult, publishedResult] = await Promise.allSettled([
      listRuns("", 100, currentSessionId ? { sessionId: currentSessionId } : { cwd: workspace, projectId }),
      listPublishedArtifacts(workspace, projectId),
    ]);
    if (requestSeq !== refreshSeqRef.current) return;
    const failures = [];
    if (runResult.status === "rejected") failures.push({ source: "运行记录", message: runResult.reason?.message || "读取失败" });
    if (publishedResult.status === "rejected") failures.push({ source: "已发布成果", message: publishedResult.reason?.message || "读取失败" });
    if (failures.length) {
      setLoadError({ message: failures.map((item) => `${item.source}：${item.message}`).join("；"), source: failures.map((item) => item.source).join("、") });
      // 有旧数据时保留并标记陈旧，而不是清空伪装成"没有产物"。
      if (runs.length || published.length) setStaleAt(Date.now());
      setLoading(false);
      return;
    }
    try {
      const runData = runResult.value;
      const publishedData = publishedResult.value;
      // 先锁定当前会话的 Run（包括没有产物的最新一轮），再按范围选择。
      // 否则最新 Run 无文件时会被滤掉，改动面板就会误显上一轮文件。
      const sessionRuns = (runData.runs || []).filter((run) => Boolean(currentSessionId) && run?.sessionId === currentSessionId);
      const latestSessionRunId = sessionRuns[0]?.id || "";
      const scopeRunId = artifactScope === "run" ? (selectedRunId || latestSessionRunId) : "";
      const nextRuns = sessionRuns.filter((run) => !scopeRunId || run.id === scopeRunId);
      setRuns(nextRuns);
      setPublished(publishedData.artifacts || []);
      setStaleAt(null);
      const acceptanceEntries = await Promise.all(nextRuns.filter((run) => (run.artifacts || []).length).slice(0, 12).map(async (run) => {
        try { const result = await getRunAcceptance(run.id); return [run.id, result.run?.acceptance || result.acceptance || null]; } catch { return [run.id, null]; }
      }));
      if (requestSeq !== refreshSeqRef.current) return;
      setAcceptance(Object.fromEntries(acceptanceEntries.filter(([, value]) => value)));
    } catch (error) {
      if (requestSeq === refreshSeqRef.current) setLoadError({ message: error?.message || "成果读取失败", source: "成果" });
    }
    if (requestSeq === refreshSeqRef.current) setLoading(false);
  };

  // 根级事件流每收到一次重要事件都会递增 refreshToken；任务完成后必须立即
  // 重新读取 Run 和固定成果，否则用户会看到旧的“暂无产物”，直到手动刷新。
  refreshRef.current = refresh;
  useEffect(() => {
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return undefined;
    // 同一次收尾会连续收到 file_changed/artifact_published/run_finished，
    // 合并成一次读取，避免面板在任务结束时反复 loading。
    const timer = window.setTimeout(() => { void refreshRef.current?.(); }, 350);
    return () => window.clearTimeout(timer);
  }, [workspace, projectId, currentSessionId, selectedRunId, artifactScope, refreshToken]);

  const allEntries = useMemo(() => {
    const seen = new Set();
    const list = [];
    for (const run of runs) {
      for (const artifact of run.artifacts || []) {
        if (artifact.status === "deleted") continue;
        const path = String(artifact.path || "").replace(/\\/g, "/");
        // 会话范围按路径去重：runs 已按最新在前排序，保留最新一轮的版本，
        // 避免同一个文件跨轮重复出现成多条“产物”。
        if (artifactScope === "session" && path && seen.has(path)) continue;
        if (path) seen.add(path);
        list.push({ artifact, run });
      }
    }
    return list;
  }, [runs, artifactScope]);
  const entries = useMemo(() => allEntries.filter(({ artifact }) => !isSuspectedArtifact(artifact)), [allEntries]);
  const suspectedEntries = useMemo(() => allEntries.filter(({ artifact }) => isSuspectedArtifact(artifact)), [allEntries]);
  const publishedByArtifact = useMemo(() => new Map(published.map((item) => [item.artifactId, item])), [published]);
  const readyCount = entries.filter(({ artifact, run }) => {
    const result = acceptance[run.id]?.artifacts?.find((item) => item.path === artifact.path) || artifact.acceptance;
    const resultStatus = result?.status || artifact.acceptanceStatus || "not_checked";
    const publication = publishedByArtifact.get(artifact.artifactId);
    return artifactStatusInfo({ publication, result, resultStatus, runStatus: run.status }).canPublish;
  }).length;
  // 只有「尚未回滚且存在上一正式版本」的成果才真正可回滚；首个版本没有历史版本。
  const rollbackableCount = published.filter((item) => item.status !== "rolled_back" && item.rollbackTarget).length;
  // W3/C02：本轮（最新 Run）的文件改动与内容差异。B03 会把“改动”做成独立右栏页签，
  // 这里先接到产物面板，让用户今天就能打开差异；仍按 runId 归属，不做跨轮聚合。
  const latestRun = useMemo(() => {
    const scoped = (runs || []).filter((run) => Boolean(currentSessionId) && run.sessionId === currentSessionId);
    return scoped[0] || null;
  }, [runs, currentSessionId]);
  const latestChanges = useMemo(() => {
    if (!latestRun) return [];
    const view = projectRunView(latestRun, Array.isArray(latestRun.events) ? latestRun.events : []);
    return view.changes || [];
  }, [latestRun]);

  const runAction = async (key, callback) => {
    setAction(key);
    try { await callback(); await refresh(); } catch (error) { notifyError(error.message || "成果操作失败"); }
    setAction("");
  };

  const renderArtifactRow = ({ artifact, run }, index) => {
    const name = artifactName(artifact.path);
    const isStaged = artifact.source === "staged"; // O-P1：运行中暂存条目（仅展示，不可打开/固定）
    const publication = publishedByArtifact.get(artifact.artifactId);
    const result = acceptance[run.id]?.artifacts?.find((item) => item.path === artifact.path) || artifact.acceptance;
    const resultStatus = result?.status || artifact.acceptanceStatus || "not_checked";
    const info = artifactStatusInfo({ publication, result, resultStatus, runStatus: run.status });
    const canConfirm = !isStaged && run.status === "completed" && !publication && result && !result.readyToPublish && resultStatus !== "failed";
    const canPublish = !isStaged && info.canPublish;
    return (
      <div className="preview-artifact" key={`${artifact.artifactId || artifact.path}-${index}`}>
        {isStaged ? (
          <span className="preview-artifact-main" title={`${artifact.path}（任务结束后可预览）`}>
            <Icon name="file" size={14} />
            <span><strong>{name}</strong><small>任务执行中 · 暂存未落盘</small></span>
          </span>
        ) : (
          <button className="preview-artifact-main" onClick={() => onOpenFile?.(artifact.path, undefined, run.cwd)} title={artifact.path}>
            <Icon name="file" size={14} />
            <span><strong>{name}</strong><small>{statusText[run.status] || run.status || "已完成"} · {String(artifact.path || "").replace(name, "").replace(/[\\/]$/, "") || "工作区根目录"}</small></span>
          </button>
        )}
        {isStaged && <span className="preview-artifact-status suspect" title="任务仍在执行，文件已暂存、尚未物化到工作区；任务结束后可预览与固定">任务中暂存</span>}
        {!isStaged && artifact.source === "unattributed" && <span className="preview-artifact-status suspect" title="本轮没有写入台账记录该文件，可能来自并发运行；仅作线索，未自动计入交付">未归属线索</span>}
        {!isStaged && artifact.source === "run-window" && <span className="preview-artifact-status suspect" title="本轮确有写入（台账只到工作区级，bash / officecli 不回报具体路径），按“运行窗口内变更”归属到本轮；若同一工作区有并行运行，可能来自它">待确认</span>}
        {!isStaged && <span className={`preview-artifact-status ${info.tone}`} title={info.hint}>{info.label}</span>}
        {canConfirm && <button className="btn-xs" disabled={action === `confirm-${artifact.artifactId}`} onClick={() => runAction(`confirm-${artifact.artifactId}`, async () => { const note = await askText("请输入人工确认说明（可选）", "已检查内容、格式和页面显示"); if (note !== null) await confirmArtifactAcceptance(run.id, artifact.artifactId, note); })}>人工确认</button>}
        {canPublish && <button className="btn-xs" disabled={action === `publish-${artifact.artifactId}`} onClick={() => runAction(`publish-${artifact.artifactId}`, () => publishArtifact(run.id, artifact.artifactId))}>固定成果</button>}
      </div>
    );
  };

  return (
    <div className="preview-artifact-panel artifact-workspace">
      <div className="artifact-workspace-head">
        <div><span className="artifact-eyebrow">工作产物 · {artifactScope === "session" ? "当前会话" : artifactScopePinned ? "历史轮次" : "当前轮次"}</span><h3>{artifactScopePinned ? "历史轮次产物" : "产物验收与固定"}</h3><p>先打开预览确认内容，再固定为正式成果。只有「文件格式验收通过 + 所属任务成功结束 + 尚未固定」的文件才可固定；格式验收通过不等于任务成功，失败任务的文件不能固定。固定后若存在上一正式版本可一键回滚，首个版本没有历史版本，需手动恢复。</p></div>
        <div className="artifact-scope-wrap">
          <div className="artifact-scope-switch" role="tablist" aria-label="产物范围">
            <button type="button" className={artifactScope === "run" ? "active" : ""} onClick={() => onArtifactScopeChange?.("run")} role="tab" aria-selected={artifactScope === "run"} title="只看本轮（默认跟随最新一次运行；点此回到最新）">本轮</button>
            <button type="button" className={artifactScope === "session" ? "active" : ""} onClick={() => onArtifactScopeChange?.("session")} role="tab" aria-selected={artifactScope === "session"} title="当前会话的全部产出">会话</button>
          </div>
          {artifactScope === "run" && artifactScopePinned && <small className="artifact-pinned-hint">正在查看历史轮次；点“本轮”回到最新</small>}
        </div>
        <button className="btn-sm" onClick={refresh} disabled={loading} title="刷新产物"><Icon name="refresh" size={12} /> {loading ? "读取中…" : "刷新"}</button>
      </div>
      <div className="artifact-summary-grid">
        <div><strong>{entries.length}</strong><span>{artifactScope === "run" ? (artifactScopePinned ? "历史轮次产物" : "本轮产物") : "会话产物"}</span></div>
        <div title="仅统计：格式验收通过、所属任务成功结束、且尚未固定的文件"><strong>{readyCount}</strong><span>待固定</span></div>
        <div><strong>{published.length}</strong><span>正式版本</span></div>
      </div>
      {suspectedEntries.length > 0 && (
        <div className="model-feedback warn">
          疑似变更 {suspectedEntries.length} 项（运行窗口内检测到、没有明确台账归属，可能与并行 Run 或上一步操作有关）；已单列，不计入本轮产物。
        </div>
      )}
      {latestRun && latestChanges.length > 0 && (
        <div className="artifact-changes-card">
          <FileChangesPanel
            runId={latestRun.id}
            changes={latestChanges}
            detection={{ truncated: Boolean(latestRun.snapshotTruncated) }}
            onOpenFile={(relative) => onOpenFile?.(relative)}
          />
        </div>
      )}
      <div className="artifact-list-card">
        <div className="artifact-list-head"><span>{artifactScope === "run" ? (artifactScopePinned ? "历史轮次文件" : "本轮文件") : "会话文件"}</span><small>{currentSessionId ? (artifactScope === "run" ? "已按当前 Run 筛选" : "已按当前会话筛选") : "当前工作区"}</small></div>
        {/* 交互 6：读取失败必须自报家门并给重试，不能退化成"暂未生成产物"。 */}
        {loadError && (
          <div className="preview-empty artifact-load-error" role="alert">
            <Icon name="warning" size={16} />
            <span>读取失败（{loadError.source}）：{loadError.message}</span>
            {staleAt && <small>下方保留的是 {new Date(staleAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 之前读取的数据</small>}
            <button className="btn-xs" onClick={() => refresh()} disabled={loading}>{loading ? "重试中…" : "重试"}</button>
          </div>
        )}
        {loading && <div className="preview-empty">正在读取产物清单…</div>}
        {!loading && !loadError && !allEntries.length && (
          <div className="preview-empty">
            <Icon name="file" size={20} />
            <strong>{artifactScope === "run" ? "本轮暂未生成产物" : "当前会话暂未生成产物"}</strong>
            <small>在 Work 模式下让 Agent 生成文件后会自动出现在这里；也可以刷新重试。{runs.some((run) => run.snapshotTruncated) ? "（工作区过大，部分轮次的产物检测可能不完整）" : ""}</small>
            <button className="btn-xs" onClick={() => refresh()} disabled={loading}>{loading ? "刷新中…" : "刷新"}</button>
          </div>
        )}
        {entries.map(renderArtifactRow)}
        {suspectedEntries.length > 0 && (
          <>
            <div className="artifact-list-head" style={{ marginTop: 10 }}><span>疑似变更（待确认）</span><small>可能与并行 Run 或上一步操作有关</small></div>
            {suspectedEntries.map(renderArtifactRow)}
          </>
        )}
      </div>
      {published.length > 0 && <div className="preview-publications artifact-publications"><div className="artifact-list-head"><span>正式成果版本</span><small>{rollbackableCount ? `可回滚 ${rollbackableCount} 个（回到上一正式版本）` : "当前没有可回滚的历史版本"}</small></div>{published.map((item) => {
        const rolledBack = item.status === "rolled_back";
        const canRollback = !rolledBack && !!item.rollbackTarget;
        return <div className="preview-publication" key={item.id}><span title={item.path}><Icon name="check" size={12} /> {artifactName(item.path)} · v{item.version}{rolledBack ? " · 已回滚" : ""}</span>{canRollback ? <button className="btn-xs" onClick={async () => { if (!(await askConfirm(`回滚「${artifactName(item.path)}」到上一正式版本？当前 v${item.version} 会保留为历史。`))) return; runAction(`rollback-${item.id}`, () => rollbackPublishedArtifact(item.id)); }}>回滚</button> : <small className="preview-publication-note">{rolledBack ? "已回滚" : "首个版本 · 无历史版本可回滚"}</small>}</div>;
      })}</div>}
    </div>
  );
}


/**
 * 改动页签（W3/C02 + C03）：“本轮”指一次 Run，不再跨轮聚合。
 * 默认看最新一轮；可在同一会话的运行列表里切换（会话历史独立展示）。
 */
function RunChangesPanel({ workspace, projectId, currentSessionId, selectedRunId = "", refreshToken = 0, onOpenFile }) {
  const [pickedRunId, setPickedRunId] = useState(selectedRunId || "");
  const [runs, setRuns] = useState([]);
  const [latestRun, setLatestRun] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const refreshSeqRef = useRef(0);
  const abortRef = useRef(null);

  useEffect(() => { setPickedRunId(selectedRunId || ""); }, [selectedRunId]);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const requestSeq = ++refreshSeqRef.current;
    const timeoutId = window.setTimeout(() => controller.abort(), 15000);
    setLoading(true);
    setError("");
    try {
      // 改动页只需要当前会话的 Run 清单；不要先下载整个工作区的 SSE 事件再在浏览器筛选。
      const listed = await listRuns("", 60, {
        cwd: workspace,
        projectId,
        sessionId: currentSessionId,
        includeEvents: "none",
        signal: controller.signal,
      });
      if (requestSeq !== refreshSeqRef.current) return;
      const sessionRuns = (listed.runs || []).filter((run) => !currentSessionId || run.sessionId === currentSessionId);
      const scoped = sessionRuns.filter((run) => run?.artifacts?.length);
      const wanted = pickedRunId || scoped[0]?.id || "";
      const fetched = wanted ? await getRun(wanted, { signal: controller.signal }).catch((err) => {
        if (controller.signal.aborted) throw err;
        return null;
      }) : null;
      if (requestSeq !== refreshSeqRef.current) return;
      setRuns(scoped);
      setLatestRun(sessionRuns[0] || null);
      setDetail(fetched?.run || scoped[0] || null);
    } catch (err) {
      if (requestSeq !== refreshSeqRef.current) return;
      setError(controller.signal.aborted ? "读取本轮改动超时，请检查本地服务后重试。" : err.message || String(err));
      setRuns([]);
      setLatestRun(null);
      setDetail(null);
    } finally {
      window.clearTimeout(timeoutId);
      if (requestSeq === refreshSeqRef.current) setLoading(false);
    }
  }, [workspace, projectId, currentSessionId, pickedRunId]);

  useEffect(() => {
    load();
    return () => {
      refreshSeqRef.current += 1;
      abortRef.current?.abort();
    };
  }, [load, refreshToken]);

  const changes = useMemo(() => {
    if (!detail) return [];
    const view = projectRunView(detail, Array.isArray(detail.events) ? detail.events : []);
    return view.changes || [];
  }, [detail]);

  const isLatest = !pickedRunId || (runs[0]?.id && runs[0].id === (detail?.id || ""));

  return (
    <div className="preview-artifact-panel artifact-workspace run-changes-workspace">
      <div className="artifact-workspace-head">
        <div>
          <span className="artifact-eyebrow">文件改动 · {isLatest ? "最新一轮" : "历史某一轮"}</span>
          <h3>本轮文件改动</h3>
          <p>按 Run 归属列出真实改动；点文件名查看内容差异（文本给出行级增删，Office/PDF/图片只给大小与哈希摘要）。</p>
        </div>
        <button className="btn-sm" onClick={load} disabled={loading} title="刷新改动"><Icon name="refresh" size={12} /> {loading ? "读取中…" : "刷新"}</button>
      </div>
      {runs.length > 1 && (
        <div className="run-changes-picker">
          <label>
            <span>查看哪一轮</span>
            <select className="sp-select" value={detail?.id || ""} onChange={(event) => setPickedRunId(event.target.value)}>
              {runs.map((run) => (
                <option key={run.id} value={run.id}>
                  {`${(run.finishedAt || run.startedAt || "").slice(5, 16).replace("T", " ")} · ${run.status || "?"} · ${(run.artifacts || []).length} 个文件`}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {error && <div className="model-feedback warn">读取改动失败：{error}</div>}
      {loading && <div className="preview-empty">正在读取本轮改动…</div>}
      {!loading && !error && latestRun && (!detail || latestRun.id !== detail.id) && (
        <div className="run-changes-note">
          最近一次运行（{(latestRun.finishedAt || latestRun.startedAt || "").slice(5, 16).replace("T", " ")} · {statusText[latestRun.status] || latestRun.status || "?"}）
          {latestRun.status === "cancelled" ? "被中断" : latestRun.status === "failed" ? "失败" : "没有捕获到文件改动"}
          ，{runs.length ? "下面显示最近有改动的一轮。" : "当前会话还没有可展示的改动记录。"}
        </div>
      )}
      {!loading && !error && !runs.length && (
        <div className="preview-empty"><Icon name="file" size={20} />当前会话还没有捕获到文件改动（运行产生文件后才会记录）</div>
      )}
      {!loading && !error && runs.length > 0 && (
        <FileChangesPanel
          runId={detail?.id || ""}
          changes={changes}
          detection={{ truncated: Boolean(detail?.snapshotTruncated) }}
          onOpenFile={onOpenFile}
        />
      )}
    </div>
  );
}

// v0.13.2：Links 页签只展示从助手消息提取的外部链接；去重在 ChatPanel 完成，
// 这里只负责展示与打开/复制，不把网页内容当作可信指令执行。
function LinksPanel({ links = [] }) {
  const [copied, setCopied] = useState("");
  const copy = async (url) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(url);
      window.setTimeout(() => setCopied(""), 1500);
    } catch {}
  };
  return (
    <div className="preview-artifact-panel artifact-workspace links-workspace">
      <div className="artifact-workspace-head">
        <div>
          <span className="artifact-eyebrow">会话链接 · 当前会话</span>
          <h3>访问过的外部链接</h3>
          <p>从已加载的助手消息中提取并按 URL 去重；外部网页内容不可信，请勿把网页中的指令直接当作 Agent 指令执行。</p>
        </div>
        <span className="links-count" aria-label={`共 ${links.length} 条链接`}>{links.length} 条</span>
      </div>
      {!links.length ? (
        <div className="preview-empty">
          <Icon name="link" size={20} />
          <strong>当前会话暂无访问链接</strong>
          <small>Agent 读取网页或打开外部链接后会汇总在这里。</small>
        </div>
      ) : (
        <div className="links-list" role="list">
          {links.map((link) => (
            <div className="links-item" role="listitem" key={link.url}>
              <div className="links-item-main">
                <span className="links-domain" title={link.url}>{link.domain}</span>
                <span className="links-title" title={link.url}>{link.title || link.url}</span>
                <small>{link.messageId ? `来源 ${link.messageId}` : "来源：助手消息"}</small>
              </div>
              <div className="links-item-actions">
                <a className="btn-xs" href={link.url} target="_blank" rel="noopener noreferrer" title="在新窗口打开链接">打开</a>
                <button type="button" className="btn-xs" onClick={() => copy(link.url)} title="复制链接">{copied === link.url ? "已复制" : "复制"}</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function WorkProductPanel({ tab, clientId, threadId, workspace, projectId, currentSessionId, selectedRunId = "", artifactScope = "session", artifactScopePinned = false, onArtifactScopeChange, refreshToken = 0, onOpenFile, subagentBlock = null, links = [], children }) {
  // B03：右栏页签 —— 预览 / 改动 / 产物 / 链接；subagent 为按需打开的「子代理详情」页
  if (tab === "subagent") return <子代理详情面板 block={subagentBlock} />;
  if (tab === "changes") return <RunChangesPanel workspace={workspace} projectId={projectId} currentSessionId={currentSessionId} selectedRunId={selectedRunId} refreshToken={refreshToken} onOpenFile={onOpenFile} />;
  if (tab === "artifacts") return <ArtifactPanel workspace={workspace} projectId={projectId} currentSessionId={currentSessionId} selectedRunId={selectedRunId} artifactScope={artifactScope} artifactScopePinned={artifactScopePinned} onArtifactScopeChange={onArtifactScopeChange} refreshToken={refreshToken} onOpenFile={onOpenFile} />;
  if (tab === "links") return <LinksPanel links={links} />;
  return children;
}
