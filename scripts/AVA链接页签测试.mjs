#!/usr/bin/env node
/**
 * AVA 链接页签测试（v0.13.2）
 *
 * 守护：
 *   1) 从助手消息提取外部链接，按 URL 去重并保留来源消息；
 *   2) 右栏“链接”页签与数量角标；空态与外部链接不可信提示；
 *   3) 打开/复制不抓取网页内容，不执行网页指令。
 *
 * 用法：node scripts/AVA链接页签测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chatPanel = fs.readFileSync(path.join(ROOT, "client", "src", "components", "ChatPanel.jsx"), "utf8").replace(/\r\n/g, "\n");
const app = fs.readFileSync(path.join(ROOT, "client", "src", "App.jsx"), "utf8").replace(/\r\n/g, "\n");
const panel = fs.readFileSync(path.join(ROOT, "client", "src", "components", "工作产物面板.jsx"), "utf8").replace(/\r\n/g, "\n");

let failed = 0;
const test = (name, fn) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed = 1;
    console.error(`  ✗ ${name}: ${error.message}`);
  }
};

test("链接提取只扫描助手消息并按 URL 去重", () => {
  assert.match(chatPanel, /export function extractSessionLinks\(messages = \[\]\) \{/);
  assert.match(chatPanel, /if \(message\?\.role !== "assistant"\) continue/);
  assert.match(chatPanel, /if \(!url \|\| seen\.has\(url\)\) continue/);
  assert.match(chatPanel, /const LINK_URL_PATTERN = \/https\?:\\\/\\\/\[\^\\s<>"'`）\)】\\\]，。；;\]\+\/gi/);
  assert.match(chatPanel, /messageId: message\.entryId \|\| message\.id \|\| ""/);
});

test("链接随消息变化同步给外层，并限制上限", () => {
  assert.match(chatPanel, /onLinksChange\(extractSessionLinks\(messages\)\)/);
  assert.match(chatPanel, /if \(seen\.size >= 200\) return \[\.\.\.seen\.values\(\)\]/);
});

test("App 增加链接页签与数量角标", () => {
  assert.match(app, /const \[chatLinks, setChatLinks\] = useState\(\[\]\)/);
  assert.match(app, /onLinksChange=\{setChatLinks\}/);
  assert.match(app, /\['links', '链接'\]/);
  assert.match(app, /id === "links" && chatLinks\.length > 0 && <span className="result-tab-count">\{chatLinks\.length\}<\/span>/);
  assert.match(app, /links=\{chatLinks\}/);
});

test("LinksPanel 展示域名/来源、打开与复制", () => {
  assert.match(panel, /function LinksPanel\(\{ links = \[\] \}\) \{/);
  assert.match(panel, /target="_blank" rel="noopener noreferrer"/);
  assert.match(panel, /navigator\.clipboard\.writeText\(url\)/);
  assert.match(panel, /来源 \$\{link\.messageId\}/);
  assert.match(panel, /当前会话暂无访问链接/);
  assert.match(panel, /外部网页内容不可信/);
});

test("页签路由与样式存在", () => {
  assert.match(panel, /if \(tab === "links"\) return <LinksPanel links=\{links\} \/>/);
  const styles = fs.readFileSync(path.join(ROOT, "client", "src", "styles.css"), "utf8");
  assert.match(styles, /\.links-list \{/);
  assert.match(styles, /\.links-item \{/);
});

console.log(failed ? "\nAVA 链接页签测试：存在失败项" : "\nAVA 链接页签测试：全部通过（5 例）");
process.exit(failed ? 1 : 0);
