#!/usr/bin/env node
/**
 * AVA 时间线与运行态测试（v0.13.8）
 *
 * 守护：
 *   1) TurnRail 显示门槛：用户轮次 ≥2 且容器 ≥900px（ResizeObserver），窄屏隐藏；
 *   2) 未读计数：离开底部期间新助手回复累计，回底 chip 显示"N 条未读"，回底/滚到底/切会话清零；
 *   3) 会话行运行态旋转图标（icon-loading），prefers-reduced-motion 由统一闸门关闭；
 *   4) 顶栏搜索按钮聚焦既有命令面板（不新建搜索后端）。
 *
 * 用法：node scripts/AVA时间线测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8").replace(/\r\n/g, "\n");
const timeline = read("client/src/components/ChatTimeline.jsx");
const chatPanel = read("client/src/components/ChatPanel.jsx");
const sidebar = read("client/src/components/SessionSidebar.jsx");
const app = read("client/src/App.jsx");
const styles = read("client/src/styles.css");
const motionTest = read("scripts/动效治理测试.mjs");

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed = 1; console.error(`  ✗ ${name}: ${error.message}`); }
};

test("TurnRail 门槛：用户轮次 ≥2 且容器 ≥900px（ResizeObserver）", () => {
  assert.match(timeline, /entry\.contentRect\.width >= 900/, "ResizeObserver 回调按 900px 判定");
  assert.match(timeline, /observer\.observe\(root\)/);
  assert.match(timeline, /userTurnCount < 2 \|\| !wideEnough/, "双门槛判定");
  assert.match(timeline, /entries\.filter\(\(entry\) => entry\.role === "user"\)\.length/, "用户轮次数按 user 消息计");
});

test("未读计数：新助手回复累计、回底 chip 显示、多路清零", () => {
  assert.match(chatPanel, /const \[unreadBelow, setUnreadBelow\] = useState\(0\)/);
  assert.match(chatPanel, /assistantSeenCountRef\.current = lastId/, "以最后一条助手消息 id 为基准（历史分页不误增）");
  assert.match(chatPanel, /lastId !== previousId && !followLatestRef\.current/, "离开底部才累计");
  assert.match(chatPanel, /回到底部 · \$\{unreadBelow\} 条未读/, "回底 chip 文案");
  assert.match(chatPanel, /if \(atBottom\) setUnreadBelow\(0\)/, "滚到底清零");
  assert.match(chatPanel, /setUnreadBelow\(0\);\s*\n\s*el\.scrollTo/, "回底按钮清零");
  assert.match(chatPanel, /setUnreadBelow\(0\); \/\/ 切会话未读归零/, "切会话清零");
});

test("会话行运行态旋转图标", () => {
  assert.match(sidebar, /RUNNING_SESSION_STATUSES\.has\(s\.runStatus\) && <Icon name="loading" size=\{12\} className="session-running-icon icon-loading" \/>/);
  assert.match(styles, /\.session-running-icon \{[^}]*\}/, "旋转图标样式");
});

test("运行图标旋转受动效闸门约束（reduced-motion 静止）", () => {
  assert.match(styles, /\.icon-loading,\n\s*\.marquee-inner,\n\s*\.marquee-text\n\) \{ animation: none !important; \}/, "icon-loading 必须进统一闸门");
  assert.match(motionTest, /spin: \["\.loading-spinner", "\.icon-loading"\]/, "动效治理测试宿主清单同步");
});

test("顶栏搜索按钮聚焦既有命令面板", () => {
  assert.match(app, /className="btn-sm topbar-search-btn"/);
  assert.match(app, /onClick=\{\(\) => setPaletteOpen\(true\)\}/);
  assert.match(app, /aria-label="搜索（打开命令面板）"/);
  assert.match(app, /title="搜索（Ctrl\/Cmd\+K）"/);
});

console.log(failed ? "\nAVA 时间线与运行态测试：存在失败项" : "\nAVA 时间线与运行态测试：全部通过（5 例）");
process.exit(failed ? 1 : 0);
