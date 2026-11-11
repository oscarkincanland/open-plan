#!/usr/bin/env node
/**
 * 输入栏浮层裁切回归测试（计划 2026-11-11-001）。
 *
 * 背景：2026-11-10-003（D3=A 恒单行工具条）给 `.chat-toolbar` 加了
 * `overflow: hidden`，把工具条内“向上展开”的三个浮层整体裁掉：
 *   1) 审批模式下拉 `.approval-mode-menu`
 *   2) 上下文用量 `.context-ring-pop`
 *   3) 添加内容菜单 `.composer-add-menu`
 * 修复方式：工具条改为“横向裁切、纵向放行”
 *   `overflow-x: clip; overflow-y: visible;`
 * 既保留恒单行/超宽横向兜底，又不再裁掉向上浮层。
 *
 * 本测试是静态契约守卫：只校验样式规则与渲染结构，不做真实几何测量
 * （几何验收见计划“验收矩阵”，用真实浏览器复验并记入实施记录）。
 *
 * 用法: node scripts/输入栏浮层裁切回归测试.mjs
 * 退出码: 0 = 全部通过, 1 = 有失败
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}: ${error?.message || error}`);
    failed = 1;
  }
}

const styles = read("client/src/styles.css");
const chatPanel = read("client/src/components/ChatPanel.jsx");

/** 取某个选择器对应的规则体（选择器需单独成行，避免命中带前缀的覆盖规则）。 */
function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = styles.match(new RegExp(`(?:^|\\n)${escaped} \\{\\n([\\s\\S]*?)\\n\\}`));
  assert.ok(match, `未找到规则: ${selector}`);
  return match[1];
}

console.log("输入栏浮层裁切回归测试");

// 1) 基础工具条：横向裁切兜底 + 纵向放行（本次修复的核心）
test("基础 .chat-toolbar 使用 overflow-x: clip + overflow-y: visible", () => {
  const body = ruleBody(".chat-toolbar");
  assert.match(body, /overflow-x:\s*clip/, "缺少 overflow-x: clip（横向兜底）");
  assert.match(body, /overflow-y:\s*visible/, "缺少 overflow-y: visible（纵向放行向上浮层）");
  assert.doesNotMatch(body, /(?:^|\n)\s*overflow:\s*hidden\s*;/, "不得再使用整体 overflow: hidden（会裁掉向上浮层）");
});

// 2) D3=A 恒单行不能回退
test("基础 .chat-toolbar 仍保持 flex-wrap: nowrap（D3=A 恒单行）", () => {
  assert.match(ruleBody(".chat-toolbar"), /flex-wrap:\s*nowrap/);
});

// 3) 地图模式窄栏同样分轴（同一 ChatPanel，同样会裁向上浮层）
test("地图模式 .center-chat-slot.map-mode .chat-toolbar 同样分轴且保留换行", () => {
  const body = ruleBody(".center-chat-slot.map-mode .chat-toolbar");
  assert.match(body, /overflow-x:\s*clip/);
  assert.match(body, /overflow-y:\s*visible/);
  assert.doesNotMatch(body, /(?:^|\n)\s*overflow:\s*hidden\s*;/);
  assert.match(body, /flex-wrap:\s*wrap/, "地图窄栏应保留 flex-wrap: wrap");
});

// 4) 全文件守卫：任何 .chat-toolbar 变体都不得再出现整体 overflow: hidden
test("styles.css 中不存在裁切工具条的 overflow: hidden 变体", () => {
  const matches = [...styles.matchAll(/(?:^|\n)([^\n{}]*\.chat-toolbar[^\n{}]*)\{([\s\S]*?)\n\}/g)];
  assert.ok(matches.length >= 2, "未匹配到工具条规则，正则可能需要更新");
  const bad = matches
    .filter(([, selector, body]) => /(?:^|\n)\s*overflow:\s*hidden\s*;/.test(body))
    .map(([, selector]) => selector.trim());
  assert.deepEqual(bad, [], `以下工具条规则仍会裁掉向上浮层: ${bad.join(" | ")}`);
});

// 5) 结构守卫：三个浮层仍渲染在工具条内（因此依赖纵向放行），模型浮层继续 portal
test("三处向上浮层仍有渲染锚点，模型浮层仍走 createPortal", () => {
  assert.match(chatPanel, /className="composer-add-menu"/, "缺少添加内容菜单");
  assert.match(chatPanel, /className="context-ring-pop"/, "缺少上下文用量浮层");
  assert.match(chatPanel, /className="approval-mode-menu"/, "缺少审批模式下拉");
  assert.match(chatPanel, /import \{ createPortal \} from "react-dom"/, "模型/浮层 portal 能力丢失");
  assert.match(chatPanel, /className="ct-pop model-control-pop"/, "模型浮层结构变化，请同步本测试");
});

if (failed) {
  console.error("输入栏浮层裁切回归：未通过");
  process.exit(1);
}
console.log("输入栏浮层裁切回归：通过");
