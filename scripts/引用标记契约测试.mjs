#!/usr/bin/env node
/**
 * 引用标记契约测试（2026-11-08 D3；计划 2026-11-08-001 §7 D3-1、ADR-0029 §7/§8）
 *
 * 守护：
 *   1) 客户端解析器 `client/src/引用标记.js` 与服务端 `server/context.mjs` 的
 *      `parseReferences` 在同一组 fixture 上 parity（同输入 → 同 kind/target/range/顺序/去重）；
 *   2) 覆盖全部类型：file / knowledge / knowledge_dir / template / template_dir /
 *      skill / plugin / session；`@智能体` 只做前端展示（服务端不解析）；
 *   3) 裸 @ 文件、去重、非法/空目标、定位后缀；
 *   4) chip 三态映射、chip 删除 → 文本同步删除、气泡文本剥离标记、发送前 lint 兜底。
 *
 * 用法: node scripts/引用标记契约测试.mjs（npm run test:ref-parser）
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const importLocal = (rel) => import(`file://${path.join(ROOT, rel).replace(/\\/g, "/")}`);

const client = await importLocal("client/src/引用标记.js");
const server = await importLocal("server/context.mjs");
const {
  parseReferenceMarkers, parseAgentMentions, stripReferenceMarkers, removeReferenceMarker,
  lintReferenceMarkers, referenceStatusTone, referenceChipLabel, referenceMarker, REFERENCE_KINDS,
} = client;
const { parseReferences } = server;

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error?.message || error}`); }
};
const shape = (refs) => (Array.isArray(refs) ? refs : []).map((ref) => ({
  kind: ref.kind,
  target: ref.target,
  range: ref.range || null,
}));

/** 客户端与服务端同一输入的 parity 断言。 */
const assertParity = (text) => {
  const clientRefs = parseReferenceMarkers(text);
  const serverRefs = parseReferences(text);
  assert.deepEqual(shape(clientRefs), shape(serverRefs), `parity 不一致：${text}`);
  return clientRefs;
};

console.log("\n▶ 解析器 parity（客户端 ↔ 服务端）");

test("全类型结构化标记：kind/target/顺序一致", () => {
  const text = [
    "@文件[报告.docx]",
    "@知识库[规范/导则.md]",
    "@知识库目录[规范]",
    "@模板[公文.docx]",
    "@模板目录[报告模板]",
    "@技能[ultimate-ppt-master]",
    "#技能[md-to-docx]",
    "#插件[mcp-files]",
    "#文件[数据.xlsx]",
    "&会话[ses-001]",
  ].join(" ");
  const refs = assertParity(text);
  assert.deepEqual(refs.map((ref) => `${ref.kind}:${ref.target}`), [
    "knowledge_dir:规范",
    "knowledge:规范/导则.md",
    "template_dir:报告模板",
    "template:公文.docx",
    "file:报告.docx",
    "skill:ultimate-ppt-master",
    "skill:md-to-docx",
    "plugin:mcp-files",
    "file:数据.xlsx",
    "session:ses-001",
  ]);
  // 每类都覆盖到
  for (const kind of ["file", "knowledge", "knowledge_dir", "template", "template_dir", "skill", "plugin", "session"]) {
    assert.ok(refs.some((ref) => ref.kind === kind), `缺少类型 ${kind}`);
  }
});

test("裸 @ 文件：扩展名 / 路径分隔符 / 括号前缀 / 尾随标点", () => {
  assertParity("看看 @报告.docx 的内容");
  assertParity("再读 @目录/材料.md，然后总结");
  assertParity("(@图集.pdf)");
  assertParity("打开 @data.csv。");
  assertParity("联系 @张三"); // 无扩展名、无路径 → 双方都不解析为引用
  const refs = parseReferenceMarkers("看看 @报告.docx 和 @目录/材料.md，再读 @data.csv。");
  assert.deepEqual(refs.map((ref) => `${ref.kind}:${ref.target}`), [
    "file:报告.docx",
    "file:目录/材料.md",
    "file:data.csv",
  ]);
});

test("去重：同 kind+target 只保留首次（跨 @文件/#文件）", () => {
  const refs = assertParity("@文件[a.docx] 再说一次 @文件[a.docx]");
  assert.equal(refs.length, 1);
  const mixed = assertParity("#文件[a.docx] @文件[a.docx]");
  assert.equal(mixed.length, 1);
});

test("非法 / 空目标：双方都忽略（由前端 lint 兜底提示）", () => {
  const text = "@文件[] #技能[] &会话[] @知识库[]";
  const refs = assertParity(text);
  assert.equal(refs.length, 0);
  const lint = lintReferenceMarkers(text);
  assert.equal(lint.ok, false);
  assert.equal(lint.issues.length, 4);
  assert.ok(lint.issues.every((item) => item.reason === "empty-target"));
});

test("定位后缀：xlsx 单元格 / 文档页，target 归一 + range 保留", () => {
  const refs = assertParity("@文件[表.xlsx#Sheet1!A1]");
  assert.equal(refs.length, 1);
  assert.equal(refs[0].target, "表.xlsx");
  assert.deepEqual(refs[0].range, { sheet: "Sheet1", cell: "A1" });
  const page = assertParity("@文件[方案.docx#page=3]");
  assert.equal(page[0].target, "方案.docx");
  assert.deepEqual(page[0].range, { page: 3 });
});

test("`@智能体[…]`：服务端不作为 reference，前端只做展示解析", () => {
  const text = "帮我 @智能体[公文助手] 写总结";
  assertParity(text); // 双方都没有 reference
  const mentions = parseAgentMentions(text);
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0].kind, "agent");
  assert.equal(mentions[0].target, "公文助手");
  assert.equal(parseAgentMentions("这是@@智能体[公文助手] 转义").length, 0, "@@ 转义不解析");
});

test("混合文本：正文与多种标记共存时仍逐条一致", () => {
  assertParity("用 #技能[ppt] 把 @文件[汇报.docx] 做成 10 页，并参考 &会话[上一轮] 和 @知识库目录[规范]。");
});

test("解析结果稳定：同输入两次 kind/target 完全一致", () => {
  const text = "@文件[a.docx] #技能[b] &会话[c]";
  assert.deepEqual(shape(parseReferenceMarkers(text)), shape(parseReferenceMarkers(text)));
});

console.log("\n▶ 输入态 / 气泡态 chip 契约");

test("三态映射：resolved / deferred / missing / 未返回", () => {
  assert.equal(referenceStatusTone({ status: "resolved" }), "resolved");
  assert.equal(referenceStatusTone({ status: "deferred" }), "pending");
  assert.equal(referenceStatusTone({}), "pending");
  assert.equal(referenceStatusTone({ status: "missing" }), "missing");
  assert.equal(referenceStatusTone({ status: "unsupported" }), "missing");
});

test("chip 标签：文件显示文件名，技能/插件/会话显示目标名", () => {
  assert.equal(referenceChipLabel({ kind: "file", target: "目录/汇报材料.docx" }), "汇报材料.docx");
  assert.equal(referenceChipLabel({ kind: "file", target: "a.docx", metadata: { name: "显示名.docx" } }), "显示名.docx");
  assert.equal(referenceChipLabel({ kind: "skill", target: "ultimate-ppt-master" }), "ultimate-ppt-master");
  assert.equal(referenceChipLabel({ kind: "plugin", target: "mcp-files" }), "mcp-files");
});

test("删除 chip → 同步删除 textarea 标记（含 #技能/@智能体/裸 @ 文件）", () => {
  assert.equal(removeReferenceMarker("请分析 @文件[a.docx] 的结构", { kind: "file", target: "a.docx" }), "请分析 的结构");
  assert.equal(removeReferenceMarker("#技能[ppt] 做个 PPT", { kind: "skill", target: "ppt" }), "做个 PPT");
  assert.equal(removeReferenceMarker("用 @技能[ppt] 做", { kind: "skill", target: "ppt" }), "用 做");
  assert.equal(removeReferenceMarker("帮 @智能体[公文助手] 写", { kind: "agent", target: "公文助手" }), "帮 写");
  assert.equal(removeReferenceMarker("参考 &会话[s1] 继续", { kind: "session", target: "s1" }), "参考 继续");
  assert.equal(removeReferenceMarker("看 @报告.docx 吧", { kind: "file", target: "报告.docx" }), "看 吧");
  // 找不到标记时原样返回，不破坏正文
  assert.equal(removeReferenceMarker("普通文本", { kind: "file", target: "x.docx" }), "普通文本");
});

test("气泡文本剥离结构化标记（chip 替代原文）", () => {
  const text = "用 @文件[a.docx] 和 #技能[ppt] 做个 PPT，并 @智能体[公文助手] 把关";
  const stripped = stripReferenceMarkers(text);
  assert.ok(!stripped.includes("@文件["), "不应保留 @文件 原文");
  assert.ok(!stripped.includes("#技能["), "不应保留 #技能 原文");
  assert.ok(!stripped.includes("@智能体["), "不应保留 @智能体 原文");
  assert.ok(stripped.includes("做个 PPT"), "正文必须保留");
  assert.equal(stripReferenceMarkers("@文件[a.docx] #技能[ppt]"), "");
});

test("发送前 lint：未知类型 / 未闭合标记不静默", () => {
  const unknown = lintReferenceMarkers("@未知类型[x] 和 @文件[a.docx]");
  assert.equal(unknown.ok, false);
  assert.equal(unknown.issues[0].reason, "unknown-type");
  const unclosed = lintReferenceMarkers("读一下 @文件[a.docx");
  assert.equal(unclosed.ok, false);
  assert.equal(unclosed.issues[0].reason, "unclosed");
  assert.equal(lintReferenceMarkers("正常 @文件[a.docx] 引用").ok, true);
});

test("标记构造：与解析器互逆（插入即可被解析回同 kind/target）", () => {
  assert.equal(REFERENCE_KINDS.includes("agent"), true);
  for (const [kind, target] of [
    ["file", "a.docx"], ["knowledge", "k.md"], ["knowledge_dir", "kdir"],
    ["template", "t.docx"], ["template_dir", "tdir"], ["skill", "ppt"],
    ["plugin", "mcp"], ["session", "s1"], ["agent", "公文助手"],
  ]) {
    const marker = referenceMarker(kind, target);
    assert.ok(marker, `${kind} 标记构造失败`);
    const parsed = kind === "agent" ? parseAgentMentions(marker) : parseReferenceMarkers(marker);
    assert.equal(parsed[0]?.kind, kind, `${kind} 解析 kind 不一致`);
    assert.equal(parsed[0]?.target, target, `${kind} 解析 target 不一致`);
  }
});

console.log(failed ? "\n引用标记契约测试：存在失败项" : "\n引用标记契约测试：全部通过");
process.exit(failed ? 1 : 0);
