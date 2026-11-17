#!/usr/bin/env node
/**
 * 主题与外观持久化测试
 * 覆盖：index.html 首帧预置 data-theme/data-skin（行为断言，node:vm）/ 白名单与 theme.jsx 同步 /
 *       预置脚本先于资源加载 / 亮色令牌块唯一性 / 窄屏设置层级 / View Transition 接线
 * 用法：node scripts/主题与外观持久化测试.mjs
 * 退出码：0 通过，1 有失败
 *
 * 结构断言说明（功能验证测试规范 §7）：styles.css 与 theme.jsx 为静态资产——
 * 亮色令牌块唯一性、CSS 媒体查询内层级声明、React 接线在无浏览器环境下无法做运行时断言，
 * 由 G1 `test:ui-smoke` 与浏览器端到端实测补证；本套件主体为 index.html 内联脚本的
 * node:vm 行为断言，非纯源码字符串套件。
 * 依据：计划 docs/plans/2026-11-18-001-主题切换体验与窄屏设置层级修复计划.md（R8 / N5）
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed = 1;
    console.error(`  ✗ ${name}: ${error.message}`);
  }
}

/** 提取 index.html 中带标记注释的内联预置脚本全文 */
function extractPresetScript(html) {
  const marker = "首帧预置主题与皮肤";
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const found = scripts.find((code) => code.includes(marker));
  if (!found) throw new Error("index.html 中未找到「首帧预置主题与皮肤」内联脚本");
  return found;
}

/** 在 stub 环境里执行预置脚本，返回写进 <html> 的 data-* 与是否抛错 */
function runPresetScript(code, storage) {
  const dataset = {};
  const context = {
    document: { documentElement: { dataset } },
    window: storage === undefined ? { localStorage: undefined } : { localStorage: storage },
  };
  let threw = null;
  try {
    vm.createContext(context);
    vm.runInContext(code, context, { timeout: 1000 });
  } catch (error) {
    threw = error;
  }
  return { dataset, threw };
}

test("预置脚本：localStorage 存了合法主题与皮肤 → 首帧写入对应 data-*", () => {
  const code = extractPresetScript(read("client/index.html"));
  const { dataset, threw } = runPresetScript(code, {
    getItem: (key) => ({ oaw_theme: "light", oaw_skin: "ocean" }[key] ?? null),
  });
  assert.equal(threw, null, `预置脚本不应抛错：${threw}`);
  assert.equal(dataset.theme, "light", `期望 data-theme=light，实际：${JSON.stringify(dataset)}`);
  assert.equal(dataset.skin, "ocean", `期望 data-skin=ocean，实际：${JSON.stringify(dataset)}`);
});

test("预置脚本：localStorage 存了非法值 → 回落 dark/default", () => {
  const code = extractPresetScript(read("client/index.html"));
  const { dataset, threw } = runPresetScript(code, {
    getItem: () => "not-a-theme",
  });
  assert.equal(threw, null, `预置脚本不应抛错：${threw}`);
  assert.equal(dataset.theme, "dark", `非法主题应回落 dark，实际：${JSON.stringify(dataset)}`);
  assert.equal(dataset.skin, "default", `非法皮肤应回落 default，实际：${JSON.stringify(dataset)}`);
});

test("预置脚本：localStorage 为空 → 回落 dark/default", () => {
  const code = extractPresetScript(read("client/index.html"));
  const { dataset, threw } = runPresetScript(code, { getItem: () => null });
  assert.equal(threw, null, `预置脚本不应抛错：${threw}`);
  assert.equal(dataset.theme, "dark");
  assert.equal(dataset.skin, "default");
});

test("预置脚本：localStorage 不可用（隐私模式抛异常）→ 不崩且回落暗色", () => {
  const code = extractPresetScript(read("client/index.html"));
  const { dataset, threw } = runPresetScript(code, {
    getItem: () => { throw new Error("SecurityError"); },
  });
  assert.equal(threw, null, `localStorage 抛异常时脚本应自行兜底，实际抛错：${threw}`);
  assert.equal(dataset.theme, "dark");
  assert.equal(dataset.skin, "default");
});

test("预置脚本：window.localStorage 缺失 → 不崩且回落暗色", () => {
  const code = extractPresetScript(read("client/index.html"));
  const { dataset, threw } = runPresetScript(code, undefined);
  assert.equal(threw, null, `localStorage 缺失时脚本应自行兜底，实际抛错：${threw}`);
  assert.equal(dataset.theme, "dark");
  assert.equal(dataset.skin, "default");
});

test("白名单同步：index.html 预置脚本与 theme.jsx 的 THEMES/SKINS 一致", () => {
  const html = read("client/index.html");
  const jsx = read("client/src/theme.jsx");
  const code = extractPresetScript(html);
  const themesHtml = code.match(/var THEMES = \[([^\]]*)\]/)?.[1];
  const skinsHtml = code.match(/var SKINS = \[([^\]]*)\]/)?.[1];
  assert.ok(themesHtml, "预置脚本应声明 var THEMES 白名单");
  assert.ok(skinsHtml, "预置脚本应声明 var SKINS 白名单");
  const parse = (s) => [...s.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const themesJsx = jsx.match(/const THEMES = \[([^\]]*)\]/)?.[1];
  const skinsJsxBlock = jsx.match(/const SKINS = \[([\s\S]*?)\];/)?.[1];
  assert.ok(themesJsx, "theme.jsx 应声明 THEMES");
  assert.ok(skinsJsxBlock, "theme.jsx 应声明 SKINS");
  const skinsJsx = [...skinsJsxBlock.matchAll(/id: "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    parse(themesHtml).sort(),
    parse(themesJsx).sort(),
    `主题白名单漂移：index.html=${parse(themesHtml)} theme.jsx=${parse(themesJsx)}`,
  );
  assert.deepEqual(
    parse(skinsHtml).sort(),
    skinsJsx.sort(),
    `皮肤白名单漂移：index.html=${parse(skinsHtml)} theme.jsx=${skinsJsx}`,
  );
});

test("预置脚本位置：先于 main.jsx 模块加载点（首帧前语义）", () => {
  const html = read("client/index.html");
  const marker = html.indexOf("首帧预置主题与皮肤");
  const moduleEntry = html.indexOf('<script type="module" src="/src/main.jsx">');
  assert.ok(marker > -1, "未找到预置脚本标记");
  assert.ok(moduleEntry > -1, "未找到 main.jsx 加载点");
  assert.ok(marker < moduleEntry, `预置脚本（${marker}）必须先于 main.jsx（${moduleEntry}）执行`);
});

test("亮色令牌块唯一性：styles.css 只允许一个裸 [data-theme=\"light\"] 令牌块", () => {
  const css = read("client/src/styles.css");
  const matches = [...css.matchAll(/^\[data-theme="light"\]\s*\{/gm)];
  assert.equal(
    matches.length,
    1,
    `裸亮色令牌块应恰好 1 个，实际 ${matches.length} 个（重复块会互相覆盖并造成文档漂移）`,
  );
});

test("合并块完整性：亮色令牌保留 L120 独有变量（panel-bg/状态色/文件图标/源码高亮）", () => {
  const css = read("client/src/styles.css");
  const start = css.search(/^\[data-theme="light"\]\s*\{/m);
  assert.ok(start > -1, "未找到亮色令牌块");
  const openBrace = css.indexOf("{", start);
  let depth = 0;
  let end = openBrace;
  for (let i = openBrace; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  const block = css.slice(start, end);
  for (const token of [
    "--panel-bg:", "--success:", "--error:", "--warning:", "--tool-pending:",
    "--file-doc:", "--file-sheet:", "--file-slides:", "--file-pdf:", "--file-html:",
    "--file-md:", "--file-code:", "--file-image:", "--file-video:", "--file-map:",
    "--file-archive:", "--file-other:", "--file-icon-fg:", "--tool-success:", "--tool-error:",
    "--code-keyword:", "--code-string:", "--code-comment:",
  ]) {
    assert.ok(block.includes(token), `亮色令牌块缺少 ${token}（合并时丢失独有变量）`);
  }
  // 当前实际生效值（无障碍复验后的最后生效块，见《会话流前端规范》§10.1）必须是块内取值
  assert.ok(block.includes("--accent: #638e2d"), "亮色 --accent 应为实际生效值 #638e2d");
  assert.ok(block.includes("--body-bg: #f5f7f4"), "亮色 --body-bg 应为实际生效值 #f5f7f4");
  assert.ok(block.includes("--oaw-cad-ink: #3a4050"), "CAD 亮色描边应已并入唯一亮色块");
});

test("窄屏设置层级：≤768px 媒体查询内 .module-view 使用 var(--z-drawer) 压过固定画布槽", () => {
  const css = read("client/src/styles.css");
  // 提取所有 max-width: 768px 媒体块（花括号配平），静态资产无法运行时断言，故采用结构断言
  const blocks = [];
  const re = /@media[^{]*max-width:\s*768px[^{]*\{/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    let depth = 0;
    for (let i = m.index; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") { depth--; if (depth === 0) { blocks.push(css.slice(m.index, i + 1)); break; } }
    }
  }
  assert.ok(blocks.length > 0, "未找到 max-width: 768px 媒体查询");
  const canvasFixed = blocks.some((b) => /\.app-canvas-slot\s*\{[^}]*position:\s*fixed/.test(b));
  assert.ok(canvasFixed, "≤768px 媒体查询应包含固定全屏画布槽（该规则是缺陷触发条件）");
  const moduleOnTop = blocks.some((b) => /\.module-view\s*\{[^}]*z-index:\s*var\(--z-drawer\)/.test(b));
  assert.ok(moduleOnTop, "≤768px 媒体查询内应声明 .module-view { z-index: var(--z-drawer) }");
});

test("级联次序不变量：亮色令牌块必须位于所有含核心色板变量的裸 :root 块之后", () => {
  const css = read("client/src/styles.css");
  const lightPos = css.search(/^\[data-theme="light"\]\s*\{/m);
  assert.ok(lightPos > -1, "未找到亮色令牌块");
  // :root 与 [data-theme="light"] 同特异性（0,1,0），级联按源码顺序取胜；
  // 亮色块之后任何核心色板 :root 重声明都会让暗色恒定覆盖亮色（2026-11-18 E2E 实证回归）。
  const re = /^:root \{/gm;
  let m;
  const offenders = [];
  while ((m = re.exec(css)) !== null) {
    let depth = 0;
    let end = m.index;
    for (let i = m.index; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    const block = css.slice(m.index, end);
    const hasCore = /--(body-bg|surface|text|accent|muted|dim|border|selected):/.test(block);
    if (hasCore && m.index > lightPos) {
      const line = css.slice(0, m.index).split("\n").length;
      offenders.push(`L${line}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `亮色块之后不得再有核心色板 :root 重声明（暗色会恒定覆盖亮色）：${offenders.join(", ")}`,
  );
});

test("View Transition 接线：theme.jsx 以 isMotionReduced() 旁路 startViewTransition 且吞掉 skip rejection", () => {
  const jsx = read("client/src/theme.jsx");
  assert.ok(jsx.includes("startViewTransition"), "theme.jsx 应接入 document.startViewTransition");
  assert.ok(jsx.includes("isMotionReduced"), "theme.jsx 应以 isMotionReduced() 作为过渡旁路条件");
  // G1 冒烟实证：连续两次 startViewTransition 会互相 skip，旧过渡的 ready/finished
  // 以 rejection 结束；未显式 catch 会变成 pageerror。值未变时也必须跳过。
  assert.ok(/finished\?*\.catch|ready\?*\.catch/.test(jsx), "transition.ready/finished 必须显式 catch");
  assert.ok(jsx.includes('root.getAttribute("data-theme") === theme'), "值未变化时应跳过写入与过渡");
  assert.ok(jsx.includes("visibilityState"), "文档隐藏时应跳过过渡直接写入（无渲染机会，回调会被推迟）");
});

console.log(failed ? "\n结果：存在失败" : "\n结果：全部通过");
process.exitCode = failed ? 1 : 0;
