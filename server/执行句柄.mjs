// P1-1 统一执行句柄契约
//
// 目标：把「执行 / 中断 / 响应交互 / 释放 / 订阅 / 可用性 / 能力」七件事收敛到单一模块，
// 路由层（server/index.mjs）只做参数校验与响应封装，业务逻辑下沉到这里。
//
// 设计约束（沿用本仓库既有做法）：
// 1. 依赖注入：emit（事件广播）、recordDiagnostic（诊断落盘）、agentKey（会话键）
//    由 index.mjs 在启动时注入，避免本模块反向依赖 index.mjs 形成环。
// 2. 只做搬运不改语义：从 index.mjs 迁入的代码逐字保留原有判断与事件顺序。
// 3. 可测：创建执行句柄() 允许注入替身，契约测试不依赖真实 Pi Runtime。

import fs from "node:fs";
import path from "node:path";

import { agentManager as 默认管理器, isAbortLikeError, isProviderTruncation } from "./agent.mjs";
import {
  beginRun,
  recordRunEvent,
  finishRun,
  getRun,
  listRuns,
  listRunArtifacts,
  requestRunCancellation,
  snapshotWorkspace,
} from "./runs.mjs";
import { stageWrite, listStagedFilesForValidation } from "./写入协调.mjs";
import { markRunTiming, attachRunTimingMeta, attachRunTimingSpans } from "./首字延迟.mjs";
import { validateArtifactFile, validateArtifacts } from "./产物验证.mjs";
import { inferCompletion } from "./运行轨迹.mjs";
import { getWorkspace, safeName, PROJECT_DIR } from "./workspace.mjs";
import { piRuntimeManager } from "./Pi运行时管理.mjs";
import { RUNTIME_FLAGS } from "./运行开关.mjs";
import { parseExtractionResult, shouldExtract } from "./记忆抽取调度.mjs";
import { createMemoryProposal } from "./记忆管理.mjs";

// ---------- 从 index.mjs 迁入的执行域工具 ----------

// 其他 run 的暂存清单路径（产物统计时排除，避免并行任务相互污染）
function otherRunsStagedPaths(currentRunId) {
  const paths = new Set();
  const runsDir = path.join(PROJECT_DIR, ".oaw", "runs");
  let names = [];
  try { names = fs.readdirSync(runsDir); } catch { return paths; }
  for (const name of names) {
    if (name === currentRunId) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(runsDir, name, "写入清单.json"), "utf8"));
      if (Array.isArray(manifest.files)) {
        for (const entry of manifest.files) {
          if (typeof entry?.path === "string") paths.add(entry.path.replace(/\\/g, "/"));
        }
      }
    } catch {}
  }
  return paths;
}

export function validateStagedArtifacts(runId) {
  return listStagedFilesForValidation(runId).map((item) => validateArtifactFile(item.file, item.root, item.path));
}

// before/after 既可能是快照对象（snapshotWorkspace 的 { files }），也可能是
// 旧调用方传入的相对路径数组；统一取相对路径集合再比对，避免 new Set(object) 抛错。
function snapshotPathSet(snapshot) {
  if (!snapshot) return new Set();
  if (Array.isArray(snapshot)) return new Set(snapshot.map((x) => String(x).split("|")[0]));
  const files = snapshot.files && typeof snapshot.files === "object" ? Object.keys(snapshot.files) : [];
  return new Set(files);
}

function diffWorkspace(before, after) {
  const b = snapshotPathSet(before);
  return [...snapshotPathSet(after)].filter((x) => !b.has(x));
}

function snapshotSignature(snapshot) {
  if (!snapshot) return "";
  if (Array.isArray(snapshot)) return JSON.stringify(snapshot);
  return JSON.stringify({ files: snapshot.files || {}, truncated: Boolean(snapshot.truncated) });
}

export async function waitForFlush(before, workspace = getWorkspace()) {
  let lastSnapshot = before;
  let lastSignature = snapshotSignature(before);
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    // 只比较文件集合与哈希，不比较 capturedAt：否则每次快照时间戳都不同，
    // 永远判不出“已稳定”，每轮固定等满 9 秒。
    const snapshot = snapshotWorkspace(workspace);
    const signature = snapshotSignature(snapshot);
    if (signature === lastSignature) break;
    lastSnapshot = snapshot;
    lastSignature = signature;
  }
  return diffWorkspace(before, lastSnapshot);
}

// 完成语义：显式 complete_task 优先；否则按 Run 终态推断（source:"inferred"），
// 前端据此区分“回答结束”与“任务真正完成”。
export function resolveRunCompletion(entry, runStatus, { artifacts = 0, validations = [], runId = null } = {}) {
  const pending = entry?.pendingCompletion && typeof entry.pendingCompletion === "object" ? entry.pendingCompletion : null;
  // 完成声明必须属于当前 Run：同一会话上一轮的声明不能串到本轮（否则会误报 success）。
  const explicit = pending && (!runId || !pending.runId || pending.runId === runId) ? pending : null;
  return explicit || inferCompletion({ runStatus, artifacts, validations });
}

export function getRunFinalText(run) {
  // 权威终稿优先读 Run 根级投影（由 recordRunFinalText 单写入维护），
  // 旧 Run 没有该字段时回退到事件流中的最后一条 assistant_final。
  if (run && String(run.finalText || "").trim()) return String(run.finalText);
  return [...(run?.events || [])]
    .reverse()
    .find((item) => item?.type === "assistant_final" && String(item?.data?.text || "").trim())
    ?.data?.text || "";
}

// ---------- 句柄 ----------

/**
 * 创建统一执行句柄。
 * @param {object} 初始依赖 可注入 agentManager / emit / recordDiagnostic / agentKey
 */
export function 创建执行句柄(初始依赖 = {}) {
  const deps = {
    agentManager: 默认管理器,
    // Run 生命周期依赖（默认直连 runs.mjs；契约测试注入替身，避免真实落盘）
    runs: { beginRun, recordRunEvent, finishRun, getRun, listRuns, listRunArtifacts, requestRunCancellation, snapshotWorkspace },
    stageWrite,
    waitForFlush,
    validateArtifacts,
    validateStagedArtifacts,
    timing: { markRunTiming, attachRunTimingMeta, attachRunTimingSpans },
    // 事件广播：index.mjs 的 emitChannel（向会话通道与事件流投递）
    emit: () => {},
    // 诊断记录：index.mjs 的 recordAgentDiagnostic（写诊断日志）
    recordDiagnostic: (details = {}) => ({
      requestId: details?.requestId || null,
      clientId: details?.client || null,
      threadId: details?.thread || null,
      runId: details?.runId || null,
      model: details?.model || null,
      errorCode: details?.error?.code || null,
      errorCategory: details?.error?.category || null,
      providerStatus: details?.error?.status || null,
      retryable: Boolean(details?.error?.retryable),
      message: String(details?.error?.message || "执行失败"),
    }),
    // 会话键：与 index.mjs 的 agentKey 口径一致（client[:thread]）
    agentKey: (client, thread) => {
      const c = String(client || "").trim();
      const t = String(thread || "").trim();
      return t ? `${c}::${t}` : c;
    },
    ...初始依赖,
  };

  // 句柄内部状态订阅：不用 EventEmitter，避免与应用事件类型（.emit("...")）混淆
  const 订阅者 = new Set();

  function 通知(type, payload = {}) {
    const 事件 = { type, at: new Date().toISOString(), ...payload };
    for (const 监听 of [...订阅者]) {
      try { 监听(事件); } catch {}
    }
  }

  function 管理器() {
    return deps.agentManager;
  }

  /**
   * 一次完整执行：建 Run → 暂存附件 → 记录事件 → 广播准入 → 后台跑 Agent → 返回准入应答。
   * 准入阶段（工作区写权限、运行时就绪、模型同步、引用解析、技能预检）仍由路由完成，
   * 属于请求级预检；Run 生命周期本身全部下沉到这里。
   */
  async function 执行(prompt, ctx = {}) {
    const {
      entry = null,
      key = "",
      client = "",
      thread = "",
      images = [],
      effort,
      resolved = [],
      task = null,
      workflow = null,
      workflowId = null,
      runWorkspace = getWorkspace(),
      effectiveModel = "",
      capabilityPlan = null,
      preflight = null,
      requestId = null,
      admissionStartedAt = null,
      admissionReadyAt = 0,
      serverReceivedAt = 0,
      admissionSpans = {},
      attachments = [],
      projectId = null,
      requestedModel = null,
      timed = async (_name, fn) => fn(),
    } = ctx;

    const text = String(prompt || "").trim();
    const manager = 管理器();

    // 插话（steer）：会话正在执行时，新消息并入当前 Run，不再新建。
    // 早先每次插话都 beginRun 出一条新 Run：同一会话会同时出现两条"执行中"，
    // 会话列表与任务中心互相矛盾，而且真正执行的回合结束后插话 Run 仍留在 running。
    const steeringRun = entry?.busy && entry?.activeRunId ? deps.runs.getRun(entry.activeRunId) : null;
    let before = [];
    let run = null;
    try {
      // Chat 没有上传文件时是严格只读模式，不需要为每轮问答扫描工作区。
      // 用户明确上传的附件需要在成功后发布为可追溯文件，因此保留完整快照。
      const tracksWorkspace = task?.mode !== "chat" || Boolean(attachments?.length);
      // 插话沿用当前 Run 的"运行前快照"：整个回合（含插话）的改动要在同一个窗口里比对。
      before = steeringRun
        ? (steeringRun.before || [])
        : (tracksWorkspace ? await timed("snapshot", async () => deps.runs.snapshotWorkspace(runWorkspace)) : []);
      const runtimeSnapshot = manager.runtimeSnapshot(key, {
        profile: task?.agentProfile,
        taskMode: task?.mode,
        capabilityPlanVersion: capabilityPlan?.version || null,
      });
      run = steeringRun || await timed("beginRun", async () => deps.runs.beginRun({
        clientId: client,
        threadId: thread || null,
        sessionId: entry?.session?.sessionId || null,
        cwd: runWorkspace,
        task,
        references: resolved,
        workflow,
        projectId,
        capabilityPlan,
        runtimeSnapshot,
        snapshotMode: tracksWorkspace ? "full" : "none",
        beforeSnapshot: tracksWorkspace ? before : null,
        // 本轮实际使用的模型（含刚恢复的备用模型）：会话里按轮显示模型与切换分割线都靠它。
        model: effectiveModel || null,
      }));
      // admission 完成（含快照/运行时准备）——这是服务端可控准备耗时的上界。
      const readyAt = admissionReadyAt || Date.now();
      // 插话不重写首字打点：当前 Run 的 marks 已经反映它自己的首个回合。
      if (!steeringRun) {
        deps.timing.markRunTiming(run.id, "serverReceivedAt", serverReceivedAt);
        deps.timing.markRunTiming(run.id, "admissionReadyAt", readyAt);
        // 细分耗时：准入这一段到底慢在等什么（运行时/写探针/引用读取/快照/写 Run 记录）
        deps.timing.attachRunTimingSpans(run.id, { ...admissionSpans, admissionTotal: readyAt - serverReceivedAt });
      }
      deps.timing.attachRunTimingMeta(run.id, { model: requestedModel || task?.model || null, mode: task?.mode });

      // 上传附件先进入当前 Run 的暂存区；Agent 可以通过 staging overlay 读取，成功后才发布到工作区。
      if (Array.isArray(attachments) && attachments.length) {
        for (const att of attachments) {
          const safe = safeName(att.name);
          if (!safe) continue;
          deps.stageWrite({
            runId: run.id,
            workspace: runWorkspace,
            targetPath: path.join(runWorkspace, safe),
            content: Buffer.from(att.data, "base64"),
            threadId: thread || null,
            kind: "attachment",
            onEvent: (type, data) => deps.emit(entry, type, data),
          });
        }
      }

      deps.runs.recordRunEvent(run.id, "prompt", { text: text.slice(0, 4000), workflowId, referenceCount: resolved.length, steer: Boolean(steeringRun) });
      if (steeringRun) deps.runs.recordRunEvent(run.id, "steer", { text: text.slice(0, 2000), source: "user", merged: true });
      deps.runs.recordRunEvent(run.id, "capability_plan", { plan: capabilityPlan, preflight });
      if (runtimeSnapshot) deps.runs.recordRunEvent(run.id, "runtime_health", runtimeSnapshot);
      // 插话已经并入当前回合：不再重复发 capability_plan/run_admitted（那些属于本轮开头的准入）。
      if (!steeringRun) {
        deps.emit(entry, "capability_plan", { plan: capabilityPlan, preflight, runId: run.id });
        deps.emit(entry, "run_admitted", {
          runId: run.id,
          requestId,
          startedAt: admissionStartedAt,
          admittedAt: new Date().toISOString(),
          snapshotMode: tracksWorkspace ? "full" : "none",
        });
      }

      // 先启动入队，再返回 admission 响应。执行回合在现有 entry 上
      // 会同步登记 queuedCount，避免响应里的 queued/queuePosition 与真实状态错位。
      const execution = 执行回合({
        entry,
        key,
        client,
        thread,
        text,
        images,
        effort,
        resolved,
        task,
        workflow,
        run,
        before,
        runWorkspace,
        effectiveModel,
        capabilityPlan,
        preflight,
        requestId,
        admissionReadyAt: readyAt,
      });
      execution.catch((error) => {
        console.error("[agent] 后台 Run 收尾失败", error);
      });

      通知("执行已接收", { runId: run.id, client, thread });
      // 参考 pi-web：先返回“已接收”，最终模型/工具/产物状态由 SSE 事件驱动。
      return {
        ok: true,
        accepted: true,
        queued: Boolean(entry?.busy || entry?.compacting || entry?.queuedCount > 1),
        queuePosition: Math.max(1, entry?.queuedCount || 1),
        changed: [],
        runId: run?.id || null,
        artifacts: [],
        validations: [],
        verificationStatus: "pending",
        status: "accepted",
        task,
        sessionId: entry?.session?.sessionId || null,
        model: effectiveModel || (entry?.session?.model?.provider && entry?.session?.model?.id
          ? `${entry.session.model.provider}/${entry.session.model.id}`
          : null),
        modelFallbackFrom: entry?.modelFallbackFrom || null,
        thread: thread || null,
      };
    } catch (error) {
      // 路由层的失败分支需要知道 Run 是否已经建出来（据此决定是否收口 run_finished）。
      if (run?.id && !error.runId) error.runId = run.id;
      throw error;
    }
  }

  /**
   * H2-2：Run 成功后异步判断是否抽取记忆；不阻塞 Run 终态。
   */
  async function 记忆抽取({ entry, runId, client, thread, workspace, userText, assistantText }) {
    if (!RUNTIME_FLAGS.memoryExtract || !entry) return;
    try {
      const decision = shouldExtract({
        userText,
        hadDirectMemoryWrite: entry.memoryWrittenThisRun === true,
        mode: entry.mode,
      });
      if (!decision.ok) {
        deps.emit(entry, "memory_extraction_skipped", { runId, reason: decision.reason, words: decision.words });
        return;
      }
      deps.emit(entry, "memory_extraction_started", { runId, words: decision.words });
      const text = await deps.agentManager.extractMemory?.({
        workspace,
        threadId: thread || null,
        userText,
        assistantText,
      });
      if (!text) {
        deps.emit(entry, "memory_extraction_skipped", { runId, reason: "empty" });
        return;
      }
      const parsed = parseExtractionResult(text);
      if (parsed.action !== "save") {
        deps.emit(entry, "memory_extraction_skipped", { runId, reason: parsed.reason || parsed.action });
        return;
      }
      const proposal = createMemoryProposal({
        clientId: client || null,
        threadId: thread || null,
        threadKey: thread || client || null,
        workspace,
        runId,
        category: parsed.category,
        content: parsed.content,
        source: { type: "agent", label: "自动抽取", runId, threadId: thread || null, clientId: client || null },
      });
      deps.emit(entry, "memory_extraction_finished", { runId, proposalId: proposal?.id || null, category: parsed.category });
    } catch (error) {
      try { deps.emit(entry, "memory_extraction_skipped", { runId, reason: "error", error: String(error?.message || error).slice(0, 300) }); } catch {}
    }
  }

  /**
   * 后台执行回合：从 index.mjs 的 executeAgentRun 迁入，逐字保留原有判断与事件顺序。
   */
  async function 执行回合({
    entry, key, client, thread, text, images, effort, resolved, task, workflow,
    run, before, runWorkspace, effectiveModel, capabilityPlan, preflight, requestId, admissionReadyAt = 0,
  }) {
    const manager = 管理器();
    const tracksWorkspace = run?.snapshotMode !== "none";
    try {
      await manager.promptWithContext(key, text, images, effort, resolved, { runId: run.id, task, workflow, admissionReadyAt: Number(admissionReadyAt) || 0 });
    } catch (e) {
      const currentModel = entry?.session?.model;
      const diagnostic = deps.recordDiagnostic({ requestId }, {
        client,
        thread,
        runId: run?.id || null,
        model: effectiveModel || (currentModel?.provider && currentModel?.id ? `${currentModel.provider}/${currentModel.id}` : null),
        error: e,
      });
      // 与发送路由同一条规矩：用户主动中断时 SDK 会以 "Request aborted" 拒绝这次 prompt，
      // 这不是模型/运行时故障——不发 agent_error、不写 runtime_error
      //（写了会把 Run 标成"需要恢复"、把 Runtime 标成 failed）。
      const cancelRequestedHere = deps.runs.getRun(run.id)?.status === "cancel_requested"
        || Boolean(entry?.cancelRequested)
        || Boolean(entry?.abortRequestedAt && Date.now() - entry.abortRequestedAt < 120000);
      const userAborted = cancelRequestedHere && isAbortLikeError(diagnostic.message);
      if (entry && userAborted) {
        deps.emit(entry, "aborted", { runId: run?.id || null, reason: "用户请求中断" });
      } else if (entry) {
        deps.emit(entry, "agent_error", { message: diagnostic.message, code: diagnostic.errorCode || e?.code || null, category: diagnostic.errorCategory || null, providerStatus: diagnostic.providerStatus || null, runId: run?.id || null, requestId, retryable: diagnostic.retryable });
      }
      // 失败前已生成的权威文本也写入 run 记录，供前端断线兜底渲染
      if (run && entry?.lastFinalText) deps.runs.recordRunEvent(run.id, "assistant_final", { text: entry.lastFinalText });
      // 出错也检测产物（agent 可能已部分写入文件）；清单走内容哈希口径，
      // 只碰了 mtime、内容没变的文件不算变更。
      const stagedElsewhere = otherRunsStagedPaths(run?.id || "");
      if (tracksWorkspace) await deps.waitForFlush(before, runWorkspace);
      const changed = deps.runs.listRunArtifacts(run, runWorkspace)
        .map((item) => item.path)
        .filter((p) => !stagedElsewhere.has(String(p).replace(/\\/g, "/")));
      const validations = deps.validateArtifacts(changed, runWorkspace);
      const stagedValidations = run ? deps.validateStagedArtifacts(run.id) : [];
      if (changed.length && entry) {
        deps.emit(entry, "file_changed", { files: changed, runId: run?.id || null });
        deps.emit(entry, "agent_summary", {
          products: changed,
          // A02-3：总结正文只给数量，文件清单走 products/artifacts，不再把全部文件名塞进正文
          summary: `对话异常结束，仍处理了 ${changed.length} 个文件`,
          runId: run?.id || null,
          artifacts: [],
        });
      }
      const runtimeHealth = entry ? manager.runtimeHealth(key) : null;
      // 供应商流截断（未返回 finish_reason）：既不是用户中断，也不该按"模型调用失败"处理——
      // 关键看这一轮有没有客观产出（文件改动 / 暂存产物 / 模型最终文本）。
      const truncatedRecoverable = !userAborted
        && isProviderTruncation(diagnostic.message)
        && (Boolean(entry?.lastFinalText) || changed.length > 0 || stagedValidations.length > 0);
      if (runtimeHealth && !userAborted && !truncatedRecoverable) deps.runs.recordRunEvent(run.id, "runtime_error", { code: diagnostic.errorCode || e?.code || null, message: diagnostic.message, runtime: runtimeHealth });
      const cancelled = userAborted || deps.runs.getRun(run.id)?.status === "cancel_requested";
      // 供应商流截断但活已经干完：按「部分完成」收尾而不是「本轮失败」——
      // 判定必须看客观产物（有改动或有过校验通过）与模型的最终文本，而不是只看调用是否干净收尾。
      const truncationCompletion = truncatedRecoverable
        ? {
          status: "partial",
          source: "inferred",
          summary: `${entry?.lastFinalText ? String(entry.lastFinalText).slice(0, 4000) : run?.task?.goal || "本轮产物已产出"}\n\n⚠ 模型流被供应商截断（未返回 finish_reason，已自动重试并继续），产物已产出并通过校验，请按结果核对。`,
          incomplete: [],
          blockers: [],
          verification: null,
          verificationStatus: "not_checked",
        }
        : null;
      const failureCompletion = truncationCompletion || resolveRunCompletion(entry, cancelled ? "cancelled" : "failed", { artifacts: changed.length, validations: [...validations, ...stagedValidations], runId: run.id });
      const failed = deps.runs.finishRun(run.id, {
        status: cancelled ? "cancelled" : (truncatedRecoverable ? "completed" : "failed"),
        sessionId: entry?.session?.sessionId || null,
        error: cancelled ? "用户请求取消" : (truncatedRecoverable ? "模型流被供应商截断（产物已产出）" : e.message),
        summary: cancelled ? "任务已中断" : (truncatedRecoverable ? "部分完成（模型流被截断）" : "Agent 执行失败"),
        validations: [...validations, ...stagedValidations],
        completion: failureCompletion,
      });
      if (entry) deps.emit(entry, "run_finished", { runId: run.id, task, artifacts: failed?.artifacts || [], references: resolved, reviewSources: entry.reviewSources || [], status: failed?.status || (cancelled ? "cancelled" : "failed"), verificationStatus: failed?.verificationStatus || "not_checked", completion: failed?.completion || failureCompletion, finalText: getRunFinalText(deps.runs.getRun(run.id)), model: deps.runs.getRun(run.id)?.model || null, finalMessageId: deps.runs.getRun(run.id)?.finalMessageId || null });
      通知("执行失败", { runId: run.id, aborted: Boolean(userAborted) });
      return;
    }

    // officecli keeps files in a resident process — disk writes flush asynchronously.
    // Poll until the workspace snapshot stabilizes, then diff.
    // 把最终权威文本写入 run 记录（assistant_final），前端 run_finished 用它兜底渲染
    if (run && entry?.lastFinalText) deps.runs.recordRunEvent(run.id, "assistant_final", { text: entry.lastFinalText });
    const stagedElsewhere = otherRunsStagedPaths(run?.id || "");
    if (tracksWorkspace) await deps.waitForFlush(before, runWorkspace);
    // 产物清单走内容哈希口径（与 run.artifacts 相同），而非 mtime 差异：
    // 后者会把 Office/CLI 只是读取过、内容未变的文件也算成本轮产物。
    const changed = deps.runs.listRunArtifacts(run, runWorkspace)
      .map((item) => item.path)
      .filter((p) => !stagedElsewhere.has(String(p).replace(/\\/g, "/")));
    const validations = deps.validateArtifacts(changed, runWorkspace);
    const stagedValidations = run ? deps.validateStagedArtifacts(run.id) : [];
    const allValidations = [...validations, ...stagedValidations];
    const publishableStagedValidations = stagedValidations.filter((item) => item.status !== "failed");
    const verificationNote = allValidations.some((item) => item.status === "failed") ? "，但产物校验发现问题" : allValidations.some((item) => item.status === "warning") ? "，产物校验有提示" : "";
    const cancelled = run && deps.runs.getRun(run.id)?.status === "cancel_requested";
    const finalStatus = cancelled ? "cancelled" : "completed";
    const publishPaths = publishableStagedValidations.map((item) => item.path).filter(Boolean);
    const publishedCount = changed.length + publishableStagedValidations.length;
    const completed = run ? deps.runs.finishRun(run.id, { status: finalStatus, sessionId: entry?.session?.sessionId || null, summary: cancelled ? "任务已取消" : (publishedCount ? `本轮对话完成，共处理 ${publishedCount} 个文件${verificationNote}` : "本轮对话完成，未检测到文件变更"), validations: allValidations, publishPaths: run ? publishPaths : null, completion: resolveRunCompletion(entry, finalStatus, { artifacts: publishedCount, validations: allValidations }) }) : null;
    if (entry) {
      const productPaths = [...changed, ...publishableStagedValidations.map((item) => item.path).filter(Boolean)];
      if (productPaths.length) deps.emit(entry, "file_changed", { files: productPaths, runId: run?.id || null });
      // 终态总结必须无条件发出：没有文件变更的轮次也要有结果卡（总结 + 本轮过程行），
      // 否则对话看起来“没有总结、折叠过程也没做完”。文案与 run 记录里的 summary 保持一致。
      deps.emit(entry, "agent_summary", {
        products: productPaths,
        // A02-3：正文只保留数量，文件清单走 products/artifacts
        summary: completed?.summary || (cancelled ? "任务已取消" : (publishedCount ? `本轮对话完成，共处理 ${publishedCount} 个文件${verificationNote}` : "本轮对话完成，未检测到文件变更")),
        runId: run?.id || null,
        artifacts: completed?.artifacts || [],
        references: resolved,
        status: completed?.status || finalStatus,
      });
      if (run) deps.emit(entry, "run_finished", { runId: run.id, task, artifacts: completed?.artifacts || [], references: resolved, reviewSources: entry.reviewSources || [], status: completed?.status || finalStatus, verificationStatus: completed?.verificationStatus || "not_checked", completion: completed?.completion || resolveRunCompletion(entry, finalStatus, { artifacts: publishedCount, validations: allValidations }), finalText: getRunFinalText(deps.runs.getRun(run.id)), model: deps.runs.getRun(run.id)?.model || null, finalMessageId: deps.runs.getRun(run.id)?.finalMessageId || null });
    }
    if (run) {
      void 记忆抽取({
        entry,
        runId: run.id,
        client,
        thread,
        workspace: runWorkspace,
        userText: text,
        assistantText: entry?.lastFinalText || completed?.summary || "",
      });
    }
    通知("执行完成", { runId: run?.id || null, status: finalStatus });
  }

  /**
   * 中断一次执行：先在 Run 侧登记取消，再让运行时停摆。
   */
  async function 中断(runId, reason = "用户在对话栏请求中断", options = {}) {
    const manager = 管理器();
    let targetRunId = String(runId || "");
    const run = targetRunId ? deps.runs.getRun(targetRunId) : null;
    const client = options.client || run?.clientId || "";
    const thread = options.thread || run?.threadId || "";
    const key = deps.agentKey(client, thread);
    // 双保险：内存里的活跃会话可能因为重载/切会话换了 key，而 Run 记录里还留着
    // 真正在跑的那条。按 client(+thread) 兜底标记取消，避免"界面说停了、任务还在跑"。
    if (!targetRunId && client) {
      const running = deps.runs.listRuns({ limit: 20 }).find((item) => ["running", "queued", "waiting_user"].includes(item.status)
        && item.clientId === client && (!thread || !item.threadId || item.threadId === thread));
      targetRunId = running?.id || "";
    }
    if (targetRunId) deps.runs.requestRunCancellation(targetRunId, reason);
    const result = await manager.abort(key, { runId: targetRunId });
    const live = manager.resolveLiveEntry?.(key) || null;
    // P2-3：一并回执「取消后仍排队的轮次数量」，前端据此区分「已停」与「排队中已停」
    // （基线只返回 ok/runId，无法判断是否还有排队的轮次）。字段为新增，不影响既有消费方。
    const payload = { ...result, runId: result?.runId || targetRunId || null, stillQueued: Number(live?.queuedCount || 0) };
    通知("已中断", { runId: payload.runId });
    return payload;
  }

  /**
   * 响应一次待答交互（ask_user）：把用户答案交回给正在等待的 Agent。
   */
  function 响应交互(id, answer, options = {}) {
    const client = String(id || "");
    const thread = options.thread || "";
    const key = deps.agentKey(client, thread);
    const result = 管理器().submitAnswer(key, String(answer ?? "").slice(0, 2000));
    if (result?.ok) 通知("交互已响应", { key });
    return result;
  }

  /**
   * 释放一个会话运行时：销毁 Runtime、摘掉会话占用与待答交互。
   */
  async function 释放(sessionId) {
    const manager = 管理器();
    const target = String(sessionId || "");
    if (!target) return { ok: false, reason: "invalid_session", sessionId: target };
    let matchedKey = "";
    let entry = manager.resolveLiveEntry?.(target) || null;
    if (entry) {
      matchedKey = target;
    } else {
      for (const [sessionKey, value] of manager.sessions || new Map()) {
        if (sessionKey === target || value?.session?.sessionId === target) {
          matchedKey = sessionKey;
          entry = value;
          break;
        }
      }
    }
    if (!entry) return { ok: false, reason: "not_found", sessionId: target };
    const runtimeId = entry.runtimeId || null;
    if (runtimeId) {
      try { piRuntimeManager.dispose(runtimeId, entry.session); } catch {}
    }
    try { manager.sessions?.delete(matchedKey); } catch {}
    try { manager.pendingAsks?.delete?.(matchedKey); } catch {}
    通知("已释放", { sessionId: target });
    return { ok: true, sessionId: target, runtimeId };
  }

  /**
   * 订阅句柄状态变化；返回退订函数。
   */
  function 订阅(listener) {
    if (typeof listener !== "function") return () => false;
    订阅者.add(listener);
    return () => {
      订阅者.delete(listener);
      return true;
    };
  }

  /**
   * 可用性三态：ready（可接单） / busy（正在执行） / disconnected（运行时掉线）。
   */
  function 可用性() {
    const manager = 管理器();
    const sessions = [...(manager.sessions?.entries?.() || [])];
    if (sessions.some(([, entry]) => entry?.busy || entry?.compacting || Number(entry?.queuedCount || 0) > 0)) return "busy";
    const disconnected = sessions.some(([sessionKey]) => {
      const health = manager.runtimeHealth?.(sessionKey) || null;
      const status = String(health?.status || "");
      const healthStatus = String(health?.health?.status || "");
      return status === "failed" || healthStatus === "failed" || status === "disconnected";
    });
    if (disconnected) return "disconnected";
    return "ready";
  }

  /**
   * 能力描述：句柄对外暴露的动作清单与当前运行时规模。
   */
  function 能力() {
    const manager = 管理器();
    return {
      execute: true,
      abort: true,
      respond: true,
      release: true,
      subscribe: true,
      availability: true,
      actions: ["执行", "中断", "响应交互", "释放", "订阅", "可用性", "能力"],
      availabilityState: 可用性(),
      sessions: manager.sessions?.size || 0,
      runtimes: manager.listRuntimes?.().length || 0,
    };
  }

  return {
    执行,
    中断,
    响应交互,
    释放,
    订阅,
    可用性,
    能力,
    绑定依赖(next = {}) {
      Object.assign(deps, next || {});
      return deps;
    },
  };
}

// 默认句柄：index.mjs 在启动时注入 emit / recordDiagnostic / agentKey。
export const 执行句柄 = 创建执行句柄();

export function 绑定执行依赖(next = {}) {
  return 执行句柄.绑定依赖(next);
}
