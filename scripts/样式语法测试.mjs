#!/usr/bin/env node
/**
 * 样式语法门禁：捕获 2458d39f 这类“规则外裸声明 / 多余闭合 / 未闭合 @media”。
 *
 * 不引入 CSS 解析依赖：先去掉注释与字符串，再做块栈检查；
 * 最后对关键选择器做结构断言，避免只做字符串匹配。
 *
 * 用法: node scripts/样式语法测试.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CSS = path.join(ROOT, "client/src/styles.css");
const source = fs.readFileSync(CSS, "utf8").replace(/\r\n/g, "\n");

/** 去掉注释与字符串，保留换行，避免括号/分号误判。 */
function sanitize(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/"(?:[^"\\]|\\.)*"/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/'(?:[^'\\]|\\.)*'/g, (m) => m.replace(/[^\n]/g, " "));
}

function checkStructure(css) {
  const text = sanitize(css);
  const stack = [];
  const errors = [];
  let segmentStart = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "{") {
      stack.push({ index: i, selector: text.slice(segmentStart, i).trim().split("\n").pop() || "@rule" });
      segmentStart = i + 1;
      continue;
    }
    if (ch === "}") {
      if (!stack.length) {
        errors.push(`第 ${text.slice(0, i).split("\n").length} 行：多余的 }`);
        segmentStart = i + 1;
        continue;
      }
      stack.pop();
      segmentStart = i + 1;
      continue;
    }
    if (ch === ";" && stack.length === 0) {
      const segment = text.slice(segmentStart, i).trim();
      if (/^[-a-zA-Z]+\s*:/.test(segment)) {
        errors.push(`第 ${text.slice(0, i).split("\n").length} 行：规则外裸声明「${segment.slice(0, 60)}」`);
      }
      segmentStart = i + 1;
    }
  }
  if (stack.length) {
    const open = stack[stack.length - 1];
    errors.push(`第 ${text.slice(0, open.index).split("\n").length} 行：块未闭合「${open.selector.slice(0, 80)}」`);
  }
  return errors;
}

let failed = 0;
function ok(msg) { console.log(`  ✓ ${msg}`); }
function bad(msg) { console.error(`  ✗ ${msg}`); failed = 1; }

console.log("\n▶ 样式结构");

const errors = checkStructure(source);
if (errors.length) {
  errors.forEach(bad);
} else {
  ok("块与声明结构完整");
}

// 2026-11-03 随 a71cd950「对话内容列回中」更新断言：内容列在对话区自身宽度内
// 居中，.chat-body 的 scrollbar-gutter 留出的 8px 让列中心左移约 4px，
// 输入区用 translateX(-4px) 补偿并保留 ≤720px 取消规则的护栏。
const composeRule = /\.center-chat-slot \.chat-compose\s*\{([\s\S]*?)\}/.exec(source);
if (composeRule && /transform:\s*translateX\(-4px\)/.test(composeRule[1])) {
  ok(".chat-compose 内含滚动条补偿");
} else {
  bad(".chat-compose 缺少 translateX(-4px) 补偿（a71cd950 回中口径）");
}

const smallScreen = /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.center-chat-slot \.chat-compose\s*\{\s*transform:\s*none;\s*\}/.test(source);
if (smallScreen) {
  ok("≤720px 取消补偿");
} else {
  bad("≤720px 未取消 .chat-compose 补偿");
}

const integration = /\.integration-body\s*\{[\s\S]*?\}\s*([\s\S]{0,120}?)\/\* ===== 0\.10/.exec(source);
if (integration && /transform:\s*translateX/.test(integration[1])) {
  bad("`.integration-body` 后仍有裸 transform（2458d39f 的历史错误）");
} else {
  ok("MCP 区块前无裸声明");
}

console.log(failed ? "\n✗ 样式语法检查失败" : "\n✓ 样式语法检查通过");
process.exitCode = failed ? 1 : 0;
