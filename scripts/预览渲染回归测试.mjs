/**
 * 预览渲染回归（test:preview-render）。2026-11-10 计划 008。
 *
 * 两个线上问题，都是"看起来打不开/很卡"，根因分别是：
 *  1. MarkdownBody 每次渲染都新建 `components` 映射对象 → react-markdown 每次把
 *     table/code/img 节点卸载重建（实测闲聊页每秒约 500 次 DOM 变动、主线程长期满载）；
 *  2. PptxViewer 的 releaseViewer() 把 canvas 缓冲区置 0×0，而 applyCanvasSize 只改
 *     CSS 尺寸 → pptxviewjs 校验 "Canvas must have positive dimensions" 失败 →
 *     所有 PPTX 都回退 OfficeCLI 高保真（首开 3–8 秒），用户以为"预览不了"。
 *
 * 这里用源码契约锁定修复，防止回退。
 *
 * 运行：node scripts/预览渲染回归测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const passed = [];
function check(name, fn) {
  try {
    fn();
    passed.push(name);
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}\n    ${error?.stack || error}`);
    process.exitCode = 1;
  }
}

const root = process.cwd();
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const markdown = read("client/src/components/MarkdownBody.jsx");
const pptx = read("client/src/components/PptxViewer.jsx");
const server = read("server/index.mjs");

console.log("▶ Markdown 重渲染治理");

check("组件映射只建一次（useMemo），不再每次渲染新建对象", () => {
  assert.match(markdown, /const components = useMemo\(\(\) => \(\{/, "components 必须用 useMemo 缓存");
  assert.match(markdown, /components=\{components\}/, "ReactMarkdown 必须引用缓存后的 components");
  assert.ok(!/components=\{\{/.test(markdown), "不得再出现内联 components={{...}}（会每次卸载重建自定义节点）");
});

check("回调经 handlersRef 取最新值（memo 后点击仍然有效）", () => {
  assert.match(markdown, /const handlersRef = useRef\(\{\}\)/, "需要 handlersRef 承接最新回调");
  assert.match(markdown, /handlersRef\.current = \{ onTagClick, onWikilinkHover, onOpenFile \}/);
  assert.match(markdown, /handlersRef\.current\.onOpenFile/, "文件条/代码条要经 ref 取回调");
});

check("MarkdownBody 按正文 memo，正文不变不重渲染", () => {
  assert.match(markdown, /function sameMarkdownProps\(prev, next\)/);
  assert.match(markdown, /prev\.children === next\.children/, "比较正文文本");
  assert.match(markdown, /export default memo\(MarkdownBody, sameMarkdownProps\)/);
});

console.log("▶ PPTX 渲染");

check("canvas 缓冲区尺寸随 CSS 同步设置（否则库校验失败）", () => {
  assert.match(pptx, /if \(canvas\.width !== width\) canvas\.width = width;/, "必须设置 canvas.width");
  assert.match(pptx, /if \(canvas\.height !== height\) canvas\.height = height;/, "必须设置 canvas.height");
  assert.match(pptx, /canvas\.style\.width = `\$\{width\}px`/, "CSS 尺寸仍然要设");
});

check("保留 releaseViewer 归零，并有注释说明与渲染的顺序关系", () => {
  assert.match(pptx, /canvas\.width = 0; canvas\.height = 0;/, "释放时仍应清空缓冲区");
  assert.match(pptx, /releaseViewer\(\) 会把 canvas\.width\/height 归零/, "注释需说明为什么渲染前要重设尺寸");
});

check("renderSlide 兼容两种签名（库内公开类/内层渲染器不一致）", () => {
  assert.match(pptx, /async function renderSlideCompat\(viewer, index, canvas\)/);
  assert.match(pptx, /Invalid render input\/i\.test/, "只在签名不匹配时回退第二种调用");
  assert.match(pptx, /await renderSlideCompat\(viewer, index, canvasRef\.current\)/, "渲染调用必须走兼容层");
});

console.log("▶ 服务端高保真缓存");

check("office-html 仍按文件指纹缓存（重复打开不再重付转换成本）", () => {
  assert.match(server, /previewCache\.resolve\("office-html", stat, \(\) => renderHtml\(p\)/, "html 预览必须走预览缓存");
});

if (!process.exitCode) {
  console.log(`\n预览渲染回归：通过（${passed.length} 项）`);
}
