/**
 * Editorial Pipeline（P2-A，方案 §5.2）——把"一次性生成文档"改造为
 * 每步产出中间产物、每步有检查的流水线：
 *
 *   Planner（目标+结构）    → 中间产物 outline.json
 *   Writer（正文）          → 中间产物 draft.md / slides.json
 *   Formatter（版式+文件）  → 中间产物 document.docx / deck.pptx（原生 OOXML 直写，§5.5）
 *   Evaluator（独立核查）   → 结论 pass / revise(→回 Writer+Formatter 一次) / fail
 *
 * 设计要点：
 *   - 编排是确定性代码（本模块），模型会话只承担 Planner/Writer/Evaluator 的内容生产（注入 runModelTask）；
 *   - Formatter 纯原生（文档引擎 buildDocxFromBlocks / buildPptxFromSlides），零外部二进制；
 *   - Evaluator 的确定性检查（文件可打开、结构完整、章节覆盖）由本模块直接执行，
 *     语义层面的覆盖核查交给注入的模型核验（可关）；
 *   - 每个阶段发独立事件（pipeline_stage_started/finished，已登记注册表并落盘），
 *     前端展示为可折叠阶段条。
 *
 * 本模块不 import Pi SDK，纯逻辑可单测。
 */
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { buildDocxFromBlocks, buildPptxFromSlides, runNativeOfficeCommand, markdownToBlocks } from "./文档引擎.mjs";
import { assessClarification } from "./task.mjs";
import { selectScene, getScene } from "./office规范/场景选择.mjs";
import { matchTemplate } from "./office规范/模板匹配.mjs";
import { parseTemplateStructure, assertCoverage } from "./office规范/模板结构.mjs";
import { runDocxQa } from "./office规范/验收规则.mjs";

export const PIPELINE_STAGES = Object.freeze(["planner", "writer", "formatter", "evaluator"]);

export const STAGE_LABELS = Object.freeze({
  planner: "规划结构",
  writer: "撰写正文",
  formatter: "排版生成",
  evaluator: "独立验收",
});

/** 安全文件名（与上传附件一致的字段清洗；不含扩展名）。 */
export function safePipelineName(goal, fallback = "流水线文档") {
  const base = String(goal || "").replace(/\.[a-z0-9]{2,5}$/i, "");
  const cleaned = base.replace(/[\\/:*?"<>|\r\n]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 60);
  return cleaned || fallback;
}

/** 宽容 JSON 解析：剥掉 ```json 围栏 / 前后噪声，取第一个平衡的 JSON 对象。 */
export function parseLooseJson(text) {
  const source = String(text || "").trim();
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : source;
  const start = body.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i += 1) {
    const ch = body[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(body.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/**
 * 解析失败诊断：把模型原始返回落盘（截断 / 纯 Markdown / 非法 JSON 一眼可见），
 * 并在错误里带上长度与开头片段——此前只有一句"未返回可解析的 JSON"，无从定位。
 * @returns {string} 可直接拼进错误文案的诊断串
 */
function diagnoseUnparsable(raw, { intermediateDir, fileBase, stage }) {
  const text = String(raw ?? "");
  let saved = "";
  try {
    const file = path.join(intermediateDir, `${fileBase}.${stage}.raw.txt`);
    fs.writeFileSync(file, text, "utf8");
    saved = `，原始返回已落盘 ${path.basename(file)}`;
  } catch {}
  const head = text.replace(/\s+/g, " ").slice(0, 160);
  return `原始返回 ${text.length} 字符${saved}；开头：${head || "（空）"}`;
}

/**
 * Evaluator 的确定性检查（§5.2：内容覆盖、格式合规、文件可打开、结构完整）。
 * @returns {{ok: boolean, structural: boolean, checks: string[], issues: string[]}}
 *   structural=true 表示产物本身坏了（不可修复，直接 fail）；
 *   structural=false 且 ok=false 表示内容缺漏（可经 revise 回环补写）。
 */
export async function evaluateGeneratedFile(file, { format, outline }) {
  const checks = [];
  const issues = [];
  let structural = false;
  if (!fs.existsSync(file)) {
    return { ok: false, structural: true, checks: ["文件存在"], issues: ["产物文件不存在"] };
  }
  const stat = fs.statSync(file);
  checks.push(`文件存在（${stat.size} 字节）`);
  if (!stat.size) return { ok: false, structural: true, checks, issues: ["产物文件为空"] };
  // ZIP 可解析（OOXML 都是 zip 容器）——对应"文件可打开"
  try {
    const zip = await JSZip.loadAsync(await fs.promises.readFile(file));
    checks.push("ZIP 容器可解析");
    if (format === "docx") {
      const xml = await zip.file("word/document.xml")?.async("string");
      if (!xml) { issues.push("缺少 word/document.xml（非有效 docx）"); structural = true; }
      else checks.push("document.xml 存在");
    }
    if (format === "pptx") {
      const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
      if (!slides.length) { issues.push("没有任何幻灯片（非有效 pptx）"); structural = true; }
      else checks.push(`幻灯片 ${slides.length} 页`);
    }
  } catch (error) {
    return { ok: false, structural: true, checks, issues: [`ZIP 解析失败：${String(error?.message || error).slice(0, 200)}`] };
  }
  // 用原生引擎读 stats（结构完整）
  const stats = await runNativeOfficeCommand(["view", file, "stats"], { cwd: path.dirname(file) });
  if (stats?.json) {
    checks.push(`stats 可读（${format === "docx" ? `${stats.json.paragraphs} 段` : `${stats.json.slides} 页`}）`);
    if (format === "docx" && Number(stats.json.words) <= 0) { issues.push("正文无文字内容"); structural = true; }
    if (format === "pptx" && Number(stats.json.textItems) <= 0) { issues.push("幻灯片无文本内容"); structural = true; }
  } else {
    issues.push("原生 stats 读取失败（结构可能异常）");
    structural = true;
  }
  // 结构覆盖：大纲标题应出现在产物文本里（内容缺漏 → 可 revise 回环补写）
  const view = await runNativeOfficeCommand(["view", file, format === "pptx" ? "text" : "outline"], { cwd: path.dirname(file) });
  const produced = String(view?.text || "");
  const headings = format === "pptx"
    ? (Array.isArray(outline?.slides) ? outline.slides : []).map((s) => String(s?.title || "")).filter(Boolean)
    : (Array.isArray(outline?.sections) ? outline.sections : []).map((s) => String(s?.title || s || "")).filter(Boolean);
  let covered = 0;
  for (const title of headings) {
    if (produced.includes(String(title).trim().slice(0, 40))) covered += 1;
    else issues.push(`大纲章节未覆盖：${String(title).slice(0, 60)}`);
  }
  if (headings.length) checks.push(`章节覆盖 ${covered}/${headings.length}`);
  return { ok: issues.length === 0, structural, checks, issues };
}

/**
 * 运行 Editorial Pipeline。
 *
 * @param {object} input
 * @param {"docx"|"pptx"} input.format 产物格式
 * @param {string} input.goal 用户目标
 * @param {string} input.workspace 输出工作区（绝对路径）
 * @param {string} [input.outputPath] 工作区相对输出路径（缺省按目标命名）
 * @param {string} [input.requirements] 额外要求（字数/受众/风格等）
 * @param {(type:string, data:object) => void} input.emit 事件发出
 * @param {(prompt: string, ctx: {stage: string}) => Promise<string>} input.runModelTask
 *        模型内容生产器（Planner/Writer/Evaluator 复核；调用方接 worker 子代理或主会话）
 * @param {boolean} [input.modelReview=true] Evaluator 是否做模型语义复核
 * @param {boolean} [input.autoClarify=false] 生成前是否执行澄清闸门（缺 ≥2 项时返回 needs_clarification）
 * @param {string[]} [input.clarificationAnswers] 已获得的澄清答案（有值则跳过闸门）
 * @param {string} [input.scene] 场景 ID（缺省自动选择）
 * @param {object} [input.template] 模板信息（matchTemplate 的返回值）
 * @param {object} [input.style] 版式覆盖（bodyPt/line/firstLine/font）
 * @param {object} [input.cover] 封面配置（title/subtitle/metaLines/docType）
 * @param {boolean} [input.toc] 是否插入目录
 * @param {boolean} [input.pageNumbers] 是否设置正文页码
 * @param {boolean} [input.qa=false] 是否执行规则闸门
 * @param {AbortSignal} [input.signal]
 * @returns {Promise<{status:"completed"|"failed"|"needs_clarification", deliverable:string|null, stages:Array, checks:string[], issues:string[], clarification?:object}>}
 */
export async function runEditorialPipeline({
  format = "docx",
  goal = "",
  workspace,
  outputPath = null,
  requirements = "",
  emit = () => {},
  runModelTask,
  modelReview = true,
  autoClarify = false,
  clarificationAnswers = [],
  scene = "",
  template = null,
  style = null,
  cover = null,
  toc = false,
  pageNumbers = false,
  qa = false,
  sourceMarkdown = "",
  signal = null,
}) {
  const normalizedFormat = format === "pptx" ? "pptx" : "docx";
  const pipelineId = `pipeline_${Date.now().toString(36)}`;
  const fileBase = safePipelineName(outputPath ? path.basename(outputPath, path.extname(outputPath)) : goal);
  const deliverableRelative = outputPath || `${fileBase}.${normalizedFormat}`;
  const deliverablePath = path.resolve(workspace, deliverableRelative);
  const intermediateDir = path.join(path.dirname(deliverablePath), ".pipeline");
  fs.mkdirSync(intermediateDir, { recursive: true });
  // 越界保护
  if (!deliverablePath.startsWith(`${path.resolve(workspace)}${path.sep}`) && deliverablePath !== path.resolve(workspace)) {
    throw new Error("输出路径超出当前工作区");
  }

  // ---- 场景与模板（O-04 / O-13 / O-14）----
  const sceneInfo = scene ? getScene(scene) : selectScene(`${goal} ${requirements}`);
  const sceneId = sceneInfo?.id || sceneInfo?.scene || scene || "report";
  const templateInfo = template || matchTemplate({ text: `${goal} ${requirements}` });
  const templateStructure = templateInfo?.absPath && fs.existsSync(templateInfo.absPath)
    ? parseTemplateStructure(fs.readFileSync(templateInfo.absPath, "utf8"))
    : null;

  // ---- 澄清闸门（O-23 / O-25）：缺 ≥2 项时不产成品，交回父会话提问 ----
  if (autoClarify && !(Array.isArray(clarificationAnswers) && clarificationAnswers.length)) {
    const clarification = assessClarification({
      text: `${goal} ${requirements}`,
      route: templateInfo ? "template" : "generate",
      template: templateInfo,
      scene: sceneInfo,
    });
    if (clarification.shouldAsk) {
      return {
        status: "needs_clarification",
        deliverable: null,
        stages: [],
        checks: [],
        issues: [`缺少关键信息：${clarification.missing.join("、")}`],
        clarification,
        scene: { id: sceneId, label: sceneInfo?.label || sceneId },
        template: templateInfo ? { relPath: templateInfo.relPath, title: templateInfo.title } : null,
      };
    }
  }

  // P1-2：已有 Markdown 时跳过 Planner/Writer，直接解析为 blocks（不调用模型）。
  const sourceBlocks = sourceMarkdown ? markdownToBlocks(sourceMarkdown) : null;
  const sourceHeadings = sourceBlocks
    ? sourceBlocks.filter((block) => block.type === "heading").map((block) => block.text)
    : [];
  // 精简稿/框架/草稿：模板图表与章节缺失降为告警，避免 1000 字版本被全量模板要求卡住。
  const coverageMode = sourceBlocks || /(精简|字左右|框架|初稿|草案)/.test(`${goal} ${requirements}`)
    ? "advisory"
    : "balanced";
  const answersText = Array.isArray(clarificationAnswers) && clarificationAnswers.length
    ? `【已确认信息】${clarificationAnswers.map((item) => String(item)).join("；")}`
    : "";

  const stageResults = [];
  emit("pipeline_started", { pipelineId, format: normalizedFormat, goal: String(goal).slice(0, 400), deliverable: deliverableRelative, scene: sceneId, template: templateInfo?.relPath || null });

  const runStage = async (stage, fn) => {
    emit("pipeline_stage_started", { pipelineId, stage, label: STAGE_LABELS[stage] || stage, format: normalizedFormat });
    const startedAt = Date.now();
    try {
      const result = await fn();
      const payload = {
        pipelineId,
        stage,
        label: STAGE_LABELS[stage] || stage,
        status: result?.status || "done",
        artifact: result?.artifact || "",
        checks: result?.checks || [],
        issues: result?.issues || [],
      };
      if (result?.error) payload.error = String(result.error).slice(0, 400);
      emit("pipeline_stage_finished", payload);
      stageResults.push({ stage, ...(result || {}), durationMs: Date.now() - startedAt });
      return result || {};
    } catch (error) {
      emit("pipeline_stage_finished", {
        pipelineId, stage, label: STAGE_LABELS[stage] || stage, status: "failed",
        error: String(error?.message || error).slice(0, 400),
      });
      stageResults.push({ stage, status: "failed", error: String(error?.message || error) });
      throw error;
    }
  };

  let finalStatus = "completed";
  try {
    // ---- Stage 1 Planner + Stage 2 Writer ----
    // sourceMarkdown 提供时跳过两个模型阶段，直接把 Markdown 解析成 blocks（P1-2）。
    let outline;
    let content;
    let effectiveCover;
    if (sourceBlocks) {
      const title = sourceHeadings[0] || safePipelineName(goal);
      outline = {
        outline: { title, sections: sourceHeadings.map((text) => ({ title: text })) },
        checks: [`Markdown 直通：${sourceBlocks.length} 个内容块`],
      };
      content = { content: { sections: [] }, checks: [] };
      effectiveCover = cover ? { ...cover, title: String(cover.title || title).slice(0, 80) } : null;
      emit("pipeline_stage_finished", { pipelineId, stage: "planner", label: STAGE_LABELS.planner, status: "skipped", checks: ["sourceMarkdown 直通，跳过 Planner"] });
      emit("pipeline_stage_finished", { pipelineId, stage: "writer", label: STAGE_LABELS.writer, status: "skipped", checks: ["sourceMarkdown 直通，跳过 Writer"] });
    } else {
    // ---- Stage 1 Planner：目标 → 结构大纲（outline.json）----
    outline = await runStage("planner", async () => {
      if (signal?.aborted) throw new Error("流水线已取消");
      const prompt = [
        `请为以下目标规划${normalizedFormat === "pptx" ? "一份 PPT 演示文稿" : "一份 Word 文档"}的结构大纲：`,
        `【目标】${goal}`,
        requirements ? `【要求】${requirements}` : "",
        answersText,
        templateStructure ? `【模板】${templateStructure.title}；必须覆盖章节：${templateStructure.chapters.join("、") || "（模板未标注）"}` : "",
        templateStructure?.requiredSections?.length ? `【模板必备小节】${templateStructure.requiredSections.slice(0, 30).join("、")}` : "",
        sceneInfo?.structure?.length ? `【场景结构】${sceneInfo.structure.join("、")}` : "",
        normalizedFormat === "pptx"
          ? '只输出 JSON：{"title":"文档标题","slides":[{"title":"页标题","points":["要点1","要点2"]}]}；页数按【已确认信息】执行，未指定时 5–12 页；不要输出其它内容。'
          : '只输出 JSON：{"title":"文档标题","sections":[{"title":"章节标题","summary":"本章要点"}]}；章节 3–9 个，按【已确认信息】执行；不要输出其它内容。',
      ].filter(Boolean).join("\n");
      const raw = runModelTask ? await runModelTask(prompt, { stage: "planner" }) : "";
      const parsed = parseLooseJson(raw);
      if (!parsed) throw new Error(`Planner 未返回可解析的大纲 JSON（${diagnoseUnparsable(raw, { intermediateDir, fileBase, stage: "planner" })}）`);
      const outlinePath = path.join(intermediateDir, `${fileBase}.outline.json`);
      fs.writeFileSync(outlinePath, JSON.stringify(parsed, null, 2), "utf8");
      return {
        artifact: path.relative(workspace, outlinePath).replace(/\\/g, "/"),
        outline: parsed,
        checks: [normalizedFormat === "pptx" ? `规划 ${parsed.slides?.length || 0} 页` : `规划 ${parsed.sections?.length || 0} 章`],
      };
    });

    // ---- Stage 2 Writer：大纲 → 正文内容（draft.md / slides.json）----
    effectiveCover = cover
      ? { ...cover, title: String(cover.title || outline.outline?.title || goal).slice(0, 80) }
      : null;
    content = await runStage("writer", async () => {
      if (signal?.aborted) throw new Error("流水线已取消");
      const outlineText = JSON.stringify(outline.outline, null, 1);
      const prompt = normalizedFormat === "pptx"
        ? [
            `请把大纲扩写为 PPT 页面内容（每页要点完整、可直接上稿）：`,
            `【目标】${goal}`,
            requirements ? `【要求】${requirements}` : "",
            answersText,
            `【大纲】${outlineText}`,
            '只输出 JSON：{"slides":[{"title":"页标题","bullets":["要点…"],"table":{"headers":[...],"rows":[[...]]}}]}（table 可省略），不要输出其它内容。',
          ].filter(Boolean).join("\n")
        : [
            `请按大纲撰写完整正文（直接可用的文档内容，不要元话语）：`,
            `【目标】${goal}`,
            requirements ? `【要求】${requirements}` : "",
            answersText,
            `【大纲】${outlineText}`,
            '只输出 JSON：{"sections":[{"title":"章节标题","blocks":[{"type":"heading|paragraph|table","text":"…","rows":[[...]]}]}]}，不要输出其它内容。',
          ].filter(Boolean).join("\n");
      const raw = runModelTask ? await runModelTask(prompt, { stage: "writer" }) : "";
      const parsed = parseLooseJson(raw);
      if (!parsed) throw new Error(`Writer 未返回可解析的内容 JSON（${diagnoseUnparsable(raw, { intermediateDir, fileBase, stage: "writer" })}）`);
      const contentPath = path.join(intermediateDir, `${fileBase}.content.json`);
      fs.writeFileSync(contentPath, JSON.stringify(parsed, null, 2), "utf8");
      return {
        artifact: path.relative(workspace, contentPath).replace(/\\/g, "/"),
        content: parsed,
        checks: [normalizedFormat === "pptx" ? `撰写 ${parsed.slides?.length || 0} 页内容` : `撰写 ${parsed.sections?.length || 0} 章内容`],
      };
    });
    }

    // ---- Stage 3 Formatter（原生直写）+ Evaluator 回环（≤1 轮 revise）----
    if (sourceBlocks && normalizedFormat === "pptx") throw new Error("sourceMarkdown 仅支持 docx");
    let formatterResult = null;
    let evaluation = null;
    for (let round = 0; round <= (sourceBlocks ? 0 : 1); round += 1) {
      formatterResult = await runStage("formatter", async () => {
        if (signal?.aborted) throw new Error("流水线已取消");
        if (round > 0) {
          emit("pipeline_stage_started", { pipelineId, stage: "formatter", label: STAGE_LABELS.formatter, note: "revise 回环" });
        }
        if (normalizedFormat === "pptx") {
          const slides = (content.content?.slides || []).map((slide) => ({
            title: String(slide?.title || ""),
            bullets: Array.isArray(slide?.bullets) ? slide.bullets.map((b) => String(b)) : [],
            table: slide?.table && Array.isArray(slide.table.headers) ? slide.table : null,
          }));
          if (!slides.length) throw new Error("没有可排版的幻灯片内容");
          const built = await buildPptxFromSlides(deliverablePath, slides);
          return { artifact: deliverableRelative, checks: [`原生生成 ${built.slides} 页`], built };
        }
        const blocks = sourceBlocks ? [...sourceBlocks] : [];
        if (!sourceBlocks) {
          for (const section of content.content?.sections || []) {
            blocks.push({ type: "heading", text: String(section?.title || ""), level: 1 });
            for (const block of Array.isArray(section?.blocks) ? section.blocks : []) {
              if (String(block?.type || "").toLowerCase() === "table" && Array.isArray(block?.rows)) {
                blocks.push({ type: "table", rows: block.rows });
              } else if (String(block?.text || "").trim()) {
                blocks.push({ type: "paragraph", text: String(block.text) });
              }
            }
          }
        }
        if (!blocks.length) throw new Error("没有可排版的内容块");
        const useStyle = Boolean(scene || style || effectiveCover || toc || pageNumbers);
        const built = await buildDocxFromBlocks(deliverablePath, blocks, useStyle ? { scene: sceneId, style, cover: effectiveCover, toc, pageNumbers } : {});
        return { artifact: deliverableRelative, checks: [`原生生成 ${built.blocks} 个内容块`, ...(built.styled ? [`版式：${sceneId}`] : []), ...(built.postProcess || [])], built };
      });

      // ---- Stage 4 Evaluator：确定性检查（+ 可选模型语义复核）----
      evaluation = await runStage("evaluator", async () => {
        if (signal?.aborted) throw new Error("流水线已取消");
        const checks = [...(formatterResult.checks || [])];
        const issues = [];
        const deterministic = await evaluateGeneratedFile(deliverablePath, { format: normalizedFormat, outline: outline.outline });
        checks.push(...deterministic.checks);
        issues.push(...deterministic.issues);
        // 规则闸门（O-20）+ 模板覆盖率（O-15）：只在显式开启时执行，保持旧行为可回退。
        let qaPassed = true;
        if (qa && normalizedFormat === "docx") {
          const qaResult = await runDocxQa(deliverablePath, { structure: templateStructure, coverageMode });
          checks.push(...qaResult.checks);
          if (!qaResult.passed) {
            qaPassed = false;
            issues.push(...qaResult.issues.map((item) => `[${item.rule}] ${item.message}`));
          }
        }
        // pass=全过；structural（产物本身坏了）→ fail；内容/版式缺漏 → revise（可回环补写）
        let verdict = deterministic.ok && qaPassed ? "pass" : deterministic.structural ? "fail" : "revise";
        if (modelReview && !sourceBlocks && deterministic.ok && runModelTask) {
          try {
            const view = await runNativeOfficeCommand(["view", deliverableRelative, "text"], { cwd: workspace });
            const reviewPrompt = [
              "你是独立的交付验收者。请核查以下文档内容是否覆盖了大纲、是否有明显缺漏或空话：",
              `【目标】${goal}`,
              `【大纲】${JSON.stringify(outline.outline).slice(0, 2000)}`,
              `【产物文本】${String(view?.text || "").slice(0, 6000)}`,
              "最后一行必须输出判定：判定：pass 或 判定：revise 或 判定：fail。",
            ].join("\n");
            const review = await runModelTask(reviewPrompt, { stage: "evaluator" });
            const match = String(review || "").match(/判定[：:]\s*(pass|revise|fail|通过|需修订|不通过)/i);
            if (match) {
              const raw = match[1].toLowerCase();
              verdict = raw === "pass" || raw === "通过" ? "pass" : raw === "revise" || raw === "需修订" ? "revise" : "fail";
              checks.push("模型语义复核完成");
              if (verdict !== "pass") issues.push("模型复核未通过（详见阶段事件）");
            } else {
              checks.push("模型复核未给出判定（按通过处理）");
            }
          } catch (error) {
            checks.push(`模型复核失败（按确定性检查结论）：${String(error?.message || error).slice(0, 120)}`);
          }
        }
        return { status: verdict === "pass" ? "done" : verdict, checks, issues, verdict };
      });

      if (evaluation.verdict === "pass" || evaluation.verdict === "fail" || round >= 1 || sourceBlocks) break;
      // revise → 回 Writer 补内容，再由 Formatter 重渲染（回环最多 1 轮）
      emit("pipeline_stage_finished", {
        pipelineId, stage: "writer", label: STAGE_LABELS.writer, status: "revise",
        checks: ["按验收意见补写内容"],
        issues: evaluation.issues.slice(0, 6),
      });
      const revisePrompt = normalizedFormat === "pptx"
        ? `以下 PPT 内容验收未通过，请修订并补全后重新输出完整 JSON（格式不变，只输出 JSON）：\n【验收意见】${evaluation.issues.join("；").slice(0, 1200)}\n【原内容】${JSON.stringify(content.content).slice(0, 6000)}`
        : `以下文档内容验收未通过，请修订并补全后重新输出完整 JSON（格式不变，只输出 JSON）：\n【验收意见】${evaluation.issues.join("；").slice(0, 1200)}\n【原内容】${JSON.stringify(content.content).slice(0, 6000)}`;
      const revisedRaw = runModelTask ? await runModelTask(revisePrompt, { stage: "writer" }) : "";
      const revised = parseLooseJson(revisedRaw);
      if (revised) content.content = revised;
      else {
        // 修订不可解析时不再静默：落盘原始返回并留一条阶段事件，避免"看起来改过了"却仍是旧稿。
        emit("pipeline_stage_finished", {
          pipelineId, stage: "writer", label: STAGE_LABELS.writer, status: "revise_failed",
          error: `修订未返回可解析的内容 JSON（${diagnoseUnparsable(revisedRaw, { intermediateDir, fileBase, stage: `writer-revise-${round + 1}` })}）`.slice(0, 400),
        });
      }
    }

    finalStatus = evaluation?.verdict === "fail" ? "failed" : "completed";
    emit("pipeline_finished", {
      pipelineId,
      status: finalStatus,
      deliverable: deliverableRelative,
      verdict: evaluation?.verdict || null,
      checks: evaluation?.checks || [],
      issues: evaluation?.issues || [],
    });
    return {
      status: finalStatus,
      deliverable: fs.existsSync(deliverablePath) ? deliverableRelative : null,
      stages: stageResults,
      checks: evaluation?.checks || [],
      issues: evaluation?.issues || [],
      outline: outline.outline,
      scene: { id: sceneId, label: sceneInfo?.label || sceneId },
      template: templateInfo ? { relPath: templateInfo.relPath, title: templateInfo.title } : null,
      clarification: null,
      source: sourceBlocks ? "markdown" : "model",
    };
  } catch (error) {
    emit("pipeline_finished", {
      pipelineId,
      status: signal?.aborted ? "cancelled" : "failed",
      deliverable: fs.existsSync(deliverablePath) ? deliverableRelative : null,
      error: String(error?.message || error).slice(0, 600),
    });
    throw error;
  }
}
