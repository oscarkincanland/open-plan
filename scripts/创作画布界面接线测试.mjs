#!/usr/bin/env node
/**
 * 创作画布界面接线测试（计划 §7.1 `test:canvas-ui`）。
 *
 * 覆盖两层：
 *   1) 纯函数：标签 id 稳定、板/画布归一化、元素增删改移与八向缩放几何、撤销栈、
 *      适配窗口、导出计划、脏比较、素材路径与 SVG 清洗；
 *   2) 源码接线断言：创作画布.jsx 真的引用了 api 函数并做了 400ms 去抖 + CAS + 脏确认，
 *      导出视图真的置 __OAW_EXPORT_READY / __OAW_EXPORT_ERROR，兼容板 iframe 无 allow-scripts，
 *      三个新文件没有引入新依赖，styles.css 里新增的类名存在且未写死色值。
 *
 * 不渲染 React、不连服务、不写工作区（纯静态读取 + 纯函数调用）。
 *
 * 用法：node scripts/创作画布界面接线测试.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as 模型 from "../client/src/画布/画布模型.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8").replace(/\r\n/g, "\n");

const 画布源码 = read("client/src/components/创作画布.jsx");
const 导出视图源码 = read("client/src/components/创作画布导出视图.jsx");
const 模型源码 = read("client/src/画布/画布模型.js");
const 样式 = read("client/src/styles.css");

let failed = 0;
let 通过数 = 0;
const test = (名, 函数) => {
  try {
    函数();
    通过数 += 1;
    console.log(`  ✓ ${名}`);
  } catch (错误) {
    failed = 1;
    console.error(`  ✗ ${名}: ${错误.message}`);
  }
};

/* ───────────────────── 1) 纯函数 ───────────────────── */

test("标签 id：同一工作区+slug 稳定，换工作区或换 slug 不冲突", () => {
  const 甲 = 模型.designTabId({ workspace: "D:\\office-workspace", slug: "规聚-汇报" });
  const 乙 = 模型.designTabId({ workspace: "D:\\office-workspace", slug: "规聚-汇报" });
  const 丙 = 模型.designTabId({ workspace: "D:/office-workspace/", slug: "规聚-汇报" });
  assert.equal(甲, 乙, "同一身份必须得到同一个标签 id（刷新去重依赖它）");
  assert.equal(甲, 丙, "路径分隔符与尾斜杠归一后应视为同一工作区");
  assert.match(甲, /^design:/, "标签 id 必须以 design: 开头（kind=design）");
  assert.notEqual(甲, 模型.designTabId({ workspace: "D:\\other", slug: "规聚-汇报" }), "不同工作区不能共用一个标签");
  assert.notEqual(甲, 模型.designTabId({ workspace: "D:\\office-workspace", slug: "另一个" }), "不同画布不能共用一个标签");
  assert.equal(模型.workspaceKey(""), "", "空工作区的身份键为空");
});

test("板归一化：类型白名单、尺寸钳制、id 去重、文本上限", () => {
  const 板 = 模型.normalizeBoard({
    w: 99999,
    h: 1,
    background: "white",
    rev: 7,
    elements: [
      { id: "el-a", type: "text", x: 10, y: 20, w: 100, h: 40, text: "标题", style: { fontSize: 56, textAlign: "center" } },
      { id: "el-a", type: "rect", x: 0, y: 0, w: 10, h: 10 },
      { id: "el-b", type: "unknown", x: 0, y: 0 },
      { id: "el:c", type: "image", src: "assets/a.png", fit: "contain" },
      { id: "el-d", type: "text", text: "x".repeat(30000) },
    ],
  });
  assert.equal(板.w, 模型.画布限制.最大尺寸, "板宽必须被钳到上限");
  assert.equal(板.h, 模型.画布限制.最小尺寸, "板高必须被钳到下限");
  assert.equal(板.rev, 7);
  assert.equal(板.elements.length, 4, "未知类型应被丢弃");
  const id集合 = new Set(板.elements.map((项) => 项.id));
  assert.equal(id集合.size, 4, "元素 id 必须唯一（重复 id 补后缀而不是丢元素）");
  assert.ok(板.elements.some((项) => 项.id === "el-a-2"), "重复 id 应补后缀");
  assert.equal(板.elements.find((项) => 项.type === "text").style.fontSize, 56);
  const 长文本 = 板.elements.filter((项) => 项.type === "text").at(-1);
  assert.equal(长文本.text.length, 模型.画布限制.最长文本, "文本必须被截到上限");
  assert.equal(板.elements.find((项) => 项.type === "image").fit, "contain");
});

test("元素增删改移：addTextElement / moveElement / resizeElement / updateElement / deleteElement", () => {
  const 初始 = 模型.normalizeBoard({ w: 1280, h: 720, elements: [] });
  const 加了文本 = 模型.addTextElement(初始, { x: 80, y: 64, w: 600, h: 100, text: "规聚" });
  assert.equal(加了文本.elements.length, 1, "addTextElement 应追加一个文本元素");
  const 文本 = 加了文本.elements[0];
  assert.equal(文本.type, "text");
  assert.equal(文本.text, "规聚");
  assert.equal(文本.x, 80);
  assert.ok(文本.id, "新元素必须有 id");
  assert.equal(初始.elements.length, 0, "纯函数不得就地修改入参");

  const 移动后 = 模型.moveElement(加了文本, 文本.id, 40, -14);
  assert.equal(移动后.elements[0].x, 120);
  assert.equal(移动后.elements[0].y, 50);

  const 缩放后 = 模型.resizeElement(移动后, 文本.id, { x: 200, y: 100, w: 320, h: 60 });
  assert.deepEqual(
    { x: 缩放后.elements[0].x, y: 缩放后.elements[0].y, w: 缩放后.elements[0].w, h: 缩放后.elements[0].h },
    { x: 200, y: 100, w: 320, h: 60 },
  );

  const 改样式 = 模型.updateElement(缩放后, 文本.id, { style: { fontSize: 48, color: "rgb(20, 20, 19)" } });
  assert.equal(改样式.elements[0].style.fontSize, 48);
  assert.equal(改样式.elements[0].style.lineHeight, 1.3, "更新样式应保留原有样式键（深合并一层）");
  assert.equal(缩放后.elements[0].style.fontSize, 32, "更新不得污染入参");

  const 删了 = 模型.deleteElement(改样式, 文本.id);
  assert.equal(删了.elements.length, 0);
  assert.equal(改样式.elements.length, 1, "删除不得影响入参");

  const 命中 = 模型.命中元素(改样式, { x: 260, y: 120 });
  assert.equal(命中, 文本.id, "命中测试应返回被点到的元素");
  assert.equal(模型.命中元素(改样式, { x: 5000, y: 5000 }), "", "点在空白处应返回空串");
});

test("八向缩放几何：边界拖拽不越界、宽高不小于下限", () => {
  const 起点 = { x: 100, y: 100, w: 200, h: 100 };
  assert.deepEqual(模型.调整矩形(起点, "se", 40, 20), { x: 100, y: 100, w: 240, h: 120 });
  assert.deepEqual(模型.调整矩形(起点, "nw", 40, 20), { x: 140, y: 120, w: 160, h: 80 });
  assert.deepEqual(模型.调整矩形(起点, "e", 40, 0), { x: 100, y: 100, w: 240, h: 100 });
  assert.deepEqual(模型.调整矩形(起点, "s", 0, -50), { x: 100, y: 100, w: 200, h: 50 });
  const 缩没了 = 模型.调整矩形(起点, "se", -500, -500, 8);
  assert.equal(缩没了.w, 8, "宽度不得小于下限");
  assert.equal(缩没了.h, 8, "高度不得小于下限");
  const 左上越界 = 模型.调整矩形(起点, "nw", -500, -500);
  assert.deepEqual(左上越界, { x: -400, y: -400, w: 700, h: 600 }, "往左上放大时原点跟着走");
});

test("撤销栈：快照/撤销/重做/上限，重复状态不压栈", () => {
  const 空板 = 模型.normalizeBoard({ w: 800, h: 600, elements: [] });
  let 历史 = 模型.createHistory(空板);
  assert.equal(模型.canUndo(历史), false, "初始无可撤销");
  assert.equal(模型.canRedo(历史), false, "初始无可重做");

  const 一步 = 模型.addTextElement(空板, { text: "A" });
  历史 = 模型.snapshot(历史, 一步);
  assert.equal(模型.canUndo(历史), true, "有一步后应可撤销");
  assert.equal(模型.snapshot(历史, 一步), 历史, "状态未变化不应产生新的一步");

  const 两步 = 模型.addTextElement(一步, { text: "B" });
  历史 = 模型.snapshot(历史, 两步);

  let 结果 = 模型.restore(历史, -1);
  assert.equal(结果.moved, true);
  assert.equal(结果.board.elements.length, 1, "撤销一次应回到只有一个元素的状态");
  历史 = 结果.history;
  assert.equal(模型.canRedo(历史), true, "撤销后应可重做");

  结果 = 模型.restore(历史, 1);
  assert.equal(结果.board.elements.length, 2, "重做应回到两个元素");
  历史 = 结果.history;

  // 撤销后产生新操作：重做栈被截断
  结果 = 模型.restore(历史, -1);
  const 新分支 = 模型.snapshot(结果.history, 模型.addTextElement(结果.board, { text: "C" }));
  assert.equal(模型.canRedo(新分支), false, "撤销后继续编辑应丢弃重做栈");

  // 上限：超过步数后丢掉最早的快照
  let 长历史 = 模型.createHistory(空板, 5);
  let 当前 = 空板;
  for (let i = 0; i < 12; i += 1) {
    当前 = 模型.addTextElement(当前, { text: `T${i}` });
    长历史 = 模型.snapshot(长历史, 当前);
  }
  assert.equal(长历史.栈.length, 5, "撤销栈长度必须受上限约束");
  assert.equal(长历史.指针, 4, "指针必须停在新栈顶");
});

test("适配窗口：把全部板放进视口并居中", () => {
  const 板们 = [
    { path: "a", x: 0, y: 0, w: 1280, h: 720 },
    { path: "b", x: 1360, y: 0, w: 1280, h: 720 },
  ];
  const 适配 = 模型.boardsFitViewport(板们, { w: 800, h: 600 }, 40);
  assert.ok(适配, "有板有视口时必须给出适配结果");
  assert.ok(适配.scale > 0 && 适配.scale <= 4, "缩放必须在合理区间");
  // 两块板内容 2640 x 720，视口 800x600（内边距 40）→ 缩放由宽度决定
  assert.ok(Math.abs(适配.scale - (800 - 80) / 2640) < 1e-6, "缩放应按内容包围盒计算");
  const 左 = 0 * 适配.scale + 适配.tx;
  const 右 = (1360 + 1280) * 适配.scale + 适配.tx;
  assert.ok(左 >= 39.5 && 右 <= 800 - 39.5, "适配后内容必须落在内边距内");
  assert.equal(模型.boardsFitViewport([], { w: 800, h: 600 }), null, "没有板时返回 null");
  assert.equal(模型.boardsFitViewport(板们, { w: 0, h: 0 }), null, "视口无尺寸时返回 null");

  const 可见 = 模型.视野内板(板们, 适配, { w: 800, h: 600 }, 0);
  assert.equal(可见.length, 2, "适配后两块板都应可见");
  const 放大 = 模型.视野内板(板们, { scale: 1, tx: -9000, ty: 0 }, { w: 800, h: 600 }, 0);
  assert.equal(放大.length, 0, "完全移出视口的板不应渲染（性能裁剪）");
});

test("导出计划：兼容板禁 SVG、混尺寸禁 PDF、图片页有提示", () => {
  const 画布 = {
    kind: "deck",
    title: "汇报",
    boards: {
      "boards/cover.board.json": { x: 0, y: 0, w: 1280, h: 720, role: "slide", title: "封面" },
      "legacy/Main.dc.html": { x: 1360, y: 0, w: 1280, h: 720, role: "slide", title: "兼容" },
    },
    order: ["boards/cover.board.json", "legacy/Main.dc.html"],
  };
  const 计划 = 模型.exportPlanForCanvas(画布);
  assert.equal(计划.total, 2);
  assert.equal(计划.hasImagePage, true, "含 .dc.html 时必须有图片页标记");
  assert.equal(计划.boards[0].type, "object");
  assert.equal(计划.boards[0].editable, true, "对象板可编辑（PPTX 文本框）");
  assert.equal(计划.boards[1].type, "html");
  assert.equal(计划.boards[1].imageOnly, true, "兼容板只能整页图片");
  assert.equal(计划.formats.svg.enabled, false, "含兼容板时不得导出 SVG");
  assert.match(计划.formats.svg.reason, /兼容板/);
  assert.equal(计划.formats.pdf.enabled, true, "同尺寸时 PDF 可用");
  assert.equal(计划.formats.pptx.enabled, true);
  assert.match(计划.formats.pptx.reason, /图片/, "PPTX 必须标注兼容板为图片页");
  assert.ok(计划.note.includes("图片页"), "计划必须给出图片页提示");

  const 混尺寸 = 模型.exportPlanForCanvas({
    boards: {
      "boards/a.board.json": { x: 0, y: 0, w: 1280, h: 720 },
      "boards/b.board.json": { x: 0, y: 900, w: 1600, h: 900 },
    },
    order: ["boards/a.board.json", "boards/b.board.json"],
  });
  assert.equal(混尺寸.sameSize, false);
  assert.equal(混尺寸.formats.pdf.enabled, false, "板尺寸不一致时 PDF 应禁用");
  assert.match(混尺寸.formats.pdf.reason, /尺寸不一致/);
  assert.equal(混尺寸.formats.svg.enabled, true, "全对象板时 SVG 可用");

  const 超大 = 模型.exportPlanForCanvas({ boards: { "boards/a.board.json": { x: 0, y: 0, w: 3000, h: 2000 } }, order: ["boards/a.board.json"] });
  assert.equal(超大.overBrowserLimit, true);
  assert.match(超大.formats.png.reason, /2400/, "超限必须提示缩放上限");

  const 空 = 模型.exportPlanForCanvas({ boards: {}, order: [] });
  assert.equal(空.total, 0);
  assert.equal(空.formats.png.enabled, false, "空画布不可导出");
});

test("脏比较：键序无关的稳定序列化", () => {
  const 甲 = 模型.normalizeBoard({ w: 800, h: 600, elements: [{ id: "el-a", type: "text", text: "A" }] });
  const 乙 = 模型.normalizeBoard({ elements: [{ text: "A", type: "text", id: "el-a" }], h: 600, w: 800 });
  assert.equal(模型.isDirty(甲, 乙), false, "同一内容不同键序不算改动");
  const 丙 = 模型.moveElement(甲, "el-a", 1, 0);
  assert.equal(模型.isDirty(甲, 丙), true, "移动 1px 必须判定为有改动");
  assert.equal(模型.isDirty(null, 甲), true);
  assert.equal(模型.isDirty(null, null), false);
});

test("路径与内容安全：素材路径不出 project、SVG 清洗去脚本与外链", () => {
  assert.equal(模型.素材路径("../assets/map.png", "boards/cover.board.json"), "assets/map.png", "板目录的相对路径应解析到 project 根下");
  assert.equal(模型.素材路径("assets/a.png"), "assets/a.png");
  assert.equal(模型.素材路径("../../etc/passwd", "boards/cover.board.json"), "", "不得逃出 project 根");
  assert.equal(模型.素材路径("http://evil.example/a.png"), "", "不得接受外部协议");
  assert.equal(模型.素材路径("/etc/passwd"), "", "不得接受绝对路径");
  assert.equal(模型.素材路径("C:\\Windows\\a.png"), "", "不得接受盘符");
  assert.equal(模型.素材路径("javascript:alert(1)"), "", "不得接受脚本协议");

  const 洗过 = 模型.清洗SVG('<svg><script>alert(1)</script><rect onload="x" href="http://e.com/a"/></svg>');
  assert.doesNotMatch(洗过, /<script/i, "必须去掉 script");
  assert.doesNotMatch(洗过, /onload/i, "必须去掉事件属性");
  assert.doesNotMatch(洗过, /http:\/\/e\.com/, "必须去掉外部引用");
  assert.match(洗过, /<rect/, "安全内容应保留");

  // 板归一化时同样清洗：样式里的注入值应被丢弃
  const 注入 = 模型.normalizeElement({ type: "text", style: { color: "red; background:url(http://x)", fontSize: 20 } });
  assert.equal(注入.style.color, undefined, "带分号/url() 的样式值必须丢弃");
  assert.equal(注入.style.fontSize, 20, "合法样式值保留");
});

test("画布布局：重排 order、更新板坐标/标题、deck 出片序列", () => {
  const 画布 = 模型.normalizeCanvas({
    kind: "deck",
    boards: {
      "boards/a.board.json": { x: 0, y: 0, w: 1280, h: 720, role: "slide" },
      "boards/b.board.json": { x: 1360, y: 0, w: 1280, h: 720, role: "slide" },
      "boards/c.board.json": { x: 2720, y: 0, w: 1280, h: 720, role: "board" },
    },
    order: ["boards/a.board.json", "boards/b.board.json"],
  });
  assert.deepEqual(画布.order, ["boards/a.board.json", "boards/b.board.json", "boards/c.board.json"], "order 必须覆盖全部 boards");

  const 重排 = 模型.重排板(画布, "boards/b.board.json", "boards/a.board.json");
  assert.deepEqual(重排.order.slice(0, 2), ["boards/b.board.json", "boards/a.board.json"], "拖拽排序应写回 order");

  const 移动 = 模型.更新板布局(画布, "boards/a.board.json", { x: 120, y: 80, title: "封面", w: 99999 });
  assert.equal(移动.boards["boards/a.board.json"].x, 120);
  assert.equal(移动.boards["boards/a.board.json"].title, "封面");
  assert.equal(移动.boards["boards/a.board.json"].w, 模型.画布限制.最大尺寸, "板尺寸必须被钳制");

  const 序列 = 模型.deck序列(画布);
  assert.equal(序列.length, 2, "deck 模式只出 role=slide 的板");
  assert.equal(模型.deck序列({ ...画布, kind: "board" }).length, 3, "非 deck 模式返回全部板");

  const 条目 = 模型.板条目(画布);
  assert.equal(条目.find((项) => 项.path === "boards/a.board.json").type, "object");
  assert.equal(条目.find((项) => 项.path === "boards/c.board.json").title, "c", "缺省标题取文件名");
});

/* ───────────────────── 2) 源码接线断言 ───────────────────── */

test("创作画布.jsx：引用 api 契约函数与可选回调，不自己拼业务 URL", () => {
  for (const 名 of [
    "listCanvases",
    "getCanvas",
    "getCanvasBoard",
    "saveCanvasBoard",
    "patchCanvas",
    "createCanvas",
    "importCanvas",
    "exportCanvas",
    "getCanvasExport",
  ]) {
    assert.match(画布源码, new RegExp(`["']${名}["']`), `接口别名表必须覆盖 ${名}`);
  }
  assert.match(画布源码, /import \* as 接口 from "\.\.\/api\.js"/, "取数必须走 api.js 统一出口");
  assert.match(画布源码, /调用\("getCanvas"/, "必须通过解析后的接口调用");
  assert.match(画布源码, /onDirtyChange/, "必须回报脏状态");
  assert.match(画布源码, /onTitleChange/, "必须回报标题");
  assert.match(画布源码, /onClose/, "必须支持关闭");
  assert.match(画布源码, /onCreated/, "占位标签新建后必须通知 App 换成真实 slug 标签");
  assert.match(画布源码, /designTabId/, "标签身份必须由模型统一生成");
  assert.doesNotMatch(画布源码, /fetch\(/, "组件不得绕过 api.js 直接 fetch");
});

test("创作画布.jsx：直接编辑、保存去抖 + CAS、冲突与脏确认", () => {
  assert.match(画布源码, /contentEditable/, "文本必须可行内编辑");
  assert.match(画布源码, /getData\("text\/plain"\)/, "粘贴必须转纯文本");
  assert.match(画布源码, /document\.execCommand\("insertText"/);
  assert.match(画布源码, /画布限制\.保存去抖毫秒/, "保存必须用模型给出的去抖时长");
  assert.equal(模型.画布限制.保存去抖毫秒, 400, "去抖时长必须是 400ms");
  assert.match(画布源码, /saveCanvasBoard", 工作区, 画布键, 路径, 发送板, 发送板\.rev/, "保存必须带 expectedRev（CAS）");
  assert.match(画布源码, /冲突刷新/, "冲突要有刷新分支");
  assert.match(画布源码, /冲突覆盖/, "冲突要有覆盖分支");
  assert.match(画布源码, /askConfirm\(/, "关闭前脏确认走项目统一确认框");
  assert.doesNotMatch(画布源码, /window\.(alert|confirm|prompt)\s*\(/, "禁止原生弹窗（界面一致性守护）");
  assert.match(画布源码, /撤销或重做/, "必须支持撤销重做");
  assert.match(画布源码, /Ctrl\+Z|ctrlKey/, "必须有键盘快捷键");
  assert.match(画布源码, /八向|方向标签/, "必须有八向缩放手柄");
  assert.match(画布源码, /role="toolbar"/, "工具条需要无障碍角色");
  assert.match(画布源码, /aria-label/, "纯图标按钮必须有可访问名称");
  assert.match(画布源码, /oaw-canvas-board-badge/, "兼容板必须有只读角标");
  assert.match(画布源码, /只读·兼容板/);
  assert.match(画布源码, /oaw-canvas-deck/, "deck 模式必须有缩略条");
  assert.match(画布源码, /text\/oaw-canvas-board/, "缩略条必须支持拖拽排序");
  assert.match(画布源码, /视野内板/, "必须只渲染视口内的板（性能）");
  assert.match(画布源码, /oaw-canvas-iframe/, "兼容板必须用沙箱 iframe");
  assert.match(画布源码, /sandbox="allow-same-origin"/, "兼容板 sandbox 必须显式声明");
  assert.doesNotMatch(画布源码, /allow-scripts/, "兼容板 sandbox 绝不能带 allow-scripts");
  assert.doesNotMatch(画布源码, /dangerouslySetInnerHTML/, "不得把外部 HTML 注入文档 DOM");
});

test("创作画布导出视图.jsx：READY/ERROR 握手、单板渲染、只依赖两个取数接口", () => {
  assert.match(导出视图源码, /export default function 创作画布导出视图/, "必须是默认导出的组件");
  assert.match(导出视图源码, /import \{ getCanvas, getCanvasBoard \} from "\.\.\/api\.js"/, "只允许依赖 getCanvas / getCanvasBoard");
  assert.match(导出视图源码, /new URLSearchParams\(window\.location\.search\)/);
  for (const 键 of ["export", "slug", "board", "scale", "workspace"]) {
    assert.match(导出视图源码, new RegExp(`参数\\.get\\("${键}"\\)`), `必须读取 ${键} 参数`);
  }
  assert.match(导出视图源码, /window\.__OAW_EXPORT_READY = true/, "渲染稳定后必须置 READY");
  assert.match(导出视图源码, /window\.__OAW_EXPORT_READY = false/, "离开/失败时必须复位 READY");
  assert.match(导出视图源码, /window\.__OAW_EXPORT_ERROR = /, "失败必须置 ERROR");
  assert.match(导出视图源码, /@page \{ size: \$\{宽\}px \$\{高\}px/, "必须按板尺寸写 @page（printToPDF 一页一板）");
  assert.match(导出视图源码, /等待视口稳定/, "必须等视口尺寸稳定再渲染");
  assert.match(导出视图源码, /等待图片/, "必须等图片解码完成");
  assert.match(导出视图源码, /sandbox="allow-same-origin"/, "兼容板同样用沙箱 iframe");
  assert.doesNotMatch(导出视图源码, /allow-scripts/, "导出视图兼容板也不能带 allow-scripts");
  assert.doesNotMatch(导出视图源码, /oaw-canvas-toolbar|oaw-canvas-inspector/, "导出视图不得渲染交互控件");
});

test("画布模型.js：纯模块（无 React / DOM / 网络）且导出契约函数", () => {
  assert.doesNotMatch(模型源码, /from "react"|from "react-dom"/, "模型层不得依赖 React");
  assert.doesNotMatch(模型源码, /document\.|window\.|fetch\(/, "模型层不得触碰 DOM 或网络");
  for (const 名 of [
    "designTabId",
    "normalizeBoard",
    "addTextElement",
    "moveElement",
    "resizeElement",
    "updateElement",
    "deleteElement",
    "snapshot",
    "restore",
    "boardsFitViewport",
    "exportPlanForCanvas",
    "isDirty",
  ]) {
    assert.equal(typeof 模型[名], "function", `模型必须导出 ${名}`);
  }
});

test("零新依赖：三个新文件只 import react 与仓内相对模块", () => {
  const 允许裸包 = new Set(["react"]);
  for (const [文件, 源码] of [
    ["client/src/components/创作画布.jsx", 画布源码],
    ["client/src/components/创作画布导出视图.jsx", 导出视图源码],
    ["client/src/画布/画布模型.js", 模型源码],
  ]) {
    const 说明符 = [...源码.matchAll(/^\s*import\s+(?:[^"']+from\s+)?["']([^"']+)["']/gm)].map((项) => 项[1]);
    // 模型层是纯函数模块，允许零 import；两个组件必须有 import（react + 仓内模块）
    if (!文件.endsWith("画布模型.js")) assert.ok(说明符.length > 0, `${文件} 应当有 import 语句`);
    for (const 项 of 说明符) {
      const 是相对 = 项.startsWith("./") || 项.startsWith("../");
      if (!是相对) assert.ok(允许裸包.has(项), `${文件} 引入了新依赖：${项}（本模块零新依赖）`);
    }
  }
});

test("样式：创作画布类名存在、色值走令牌（无新增硬编码色值）", () => {
  const 必备类名 = [
    ".oaw-canvas-shell",
    ".oaw-canvas-toolbar",
    ".oaw-canvas-viewport",
    ".oaw-canvas-board",
    ".oaw-canvas-board-paper",
    ".oaw-canvas-board-badge",
    ".oaw-canvas-selection",
    ".oaw-canvas-handle",
    ".oaw-canvas-deck",
    ".oaw-canvas-deck-thumb",
    ".oaw-canvas-inspector",
    ".oaw-canvas-field",
    ".oaw-canvas-empty",
    ".oaw-canvas-state",
    ".oaw-canvas-banner",
    ".oaw-canvas-export",
    ".oaw-canvas-export-page",
    ".oaw-canvas-export-frame",
  ];
  for (const 类 of 必备类名) assert.ok(样式.includes(类), `styles.css 缺少 ${类}`);

  // 新增区块不得引入硬编码十六进制色值（设计令牌一致性测试的棘轮只降不升）
  const 起始 = 样式.indexOf("/* ===== 创作画布");
  assert.ok(起始 > 0, "必须在 styles.css 末尾单独成块追加创作画布样式");
  const 区块 = 样式.slice(起始);
  const 色值 = 区块.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  assert.equal(色值.length, 0, `创作画布样式不得写死色值，发现：${色值.slice(0, 5).join("、")}`);
  assert.doesNotMatch(区块, /z-index:\s*\d/, "层级必须用 --z-* 令牌，不写裸 z-index");
  assert.match(区块, /--oaw-canvas-paper/, "画板纸色必须是组件变量");
  assert.match(区块, /--oaw-canvas-ink/, "画板墨色必须是组件变量");

  // 组件源码同样不得写死色值（界面一致性守护按文件冻结数量，新文件必须为 0）
  for (const [文件, 源码] of [
    ["创作画布.jsx", 画布源码],
    ["创作画布导出视图.jsx", 导出视图源码],
    ["画布模型.js", 模型源码],
  ]) {
    const 命中 = 源码.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
    assert.equal(命中.length, 0, `${文件} 不得写死色值，发现：${命中.slice(0, 5).join("、")}`);
  }
});

test("组件从模型导入的函数名必须真实存在（防止改名后静默 undefined）", () => {
  for (const [文件, 源码] of [
    ["创作画布.jsx", 画布源码],
    ["创作画布导出视图.jsx", 导出视图源码],
  ]) {
    // 只取「只从 画布模型.js 具名导入」的那一条 import（`[^}]*` 保证不跨过别的 import 块）
    const 块 = /^import\s*\{([^}]*)\}\s*from\s*"\.\.\/画布\/画布模型\.js"/m.exec(源码);
    assert.ok(块, `${文件} 必须从 画布/画布模型.js 命名导入`);
    const 名字们 = 块[1]
      .split(",")
      .map((项) => 项.trim())
      .filter(Boolean);
    assert.ok(名字们.length > 0, `${文件} 的模型导入不能为空`);
    for (const 名 of 名字们) {
      // 允许函数与冻结常量（画布限制是 Object.freeze 的数值表）
      assert.notEqual(模型[名], undefined, `${文件} 导入了模型里不存在的符号：${名}`);
    }
  }
});

test("图标名都在 Icon.jsx 注册表里（不新增未注册字形）", () => {
  const 图标源码 = read("client/src/components/Icon.jsx");
  const 注册表 = new Set([...图标源码.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*):\s*Icon/gm)].map((项) => 项[1]));
  const 别名 = [...图标源码.matchAll(/ICON_ALIASES = Object\.freeze\(\{([^}]*)\}\)/g)].map((项) => 项[1]).join("");
  for (const 名 of [...别名.matchAll(/([A-Za-z][A-Za-z0-9]*):/g)].map((项) => 项[1])) 注册表.add(名);
  assert.ok(注册表.size > 40, "应解析出足够多的图标注册项");

  for (const [文件, 源码] of [
    ["创作画布.jsx", 画布源码],
    ["创作画布导出视图.jsx", 导出视图源码],
  ]) {
    for (const 命中 of 源码.matchAll(/<Icon\b[^>]*?name="([^"]+)"/g)) {
      assert.ok(注册表.has(命中[1]), `${文件} 使用了未注册的图标名：${命中[1]}`);
    }
    for (const 命中 of 源码.matchAll(/name=\{([^}]+)\}/g)) {
      // 动态图标名（三元表达式）逐个字面量校验
      for (const 字面 of 命中[1].matchAll(/"([^"]+)"/g)) {
        assert.ok(注册表.has(字面[1]), `${文件} 使用了未注册的图标名：${字面[1]}`);
      }
    }
  }
});

test("无障碍：纯图标按钮都有 aria-label，弹层有 dialog 语义", () => {
  const 按钮们 = [...画布源码.matchAll(/<button\b[\s\S]*?>/g)].map((项) => 项[0]);
  const 缺名 = 按钮们.filter((标签) => !/aria-label|title=/.test(标签));
  // 允许纯文本按钮（如「1:1」「关闭」「取消」「开始导出」）没有 aria-label，但图标按钮必须有
  const 图标按钮 = 缺名.filter((标签) => /<Icon\b/.test(标签));
  assert.equal(图标按钮.length, 0, `存在没有可访问名称的图标按钮：${图标按钮.slice(0, 2).join(" | ")}`);
  assert.match(画布源码, /role="dialog"/, "导出对话框必须有 dialog 语义");
  assert.match(画布源码, /aria-modal="true"/);
  assert.match(画布源码, /role="alert"/, "错误/冲突必须能被读屏播报");
  assert.match(导出视图源码, /role="status"/, "导出视图加载态需要 status");
});

test("Agent 实时刷新接线：canvas_changed → App 递增令牌 → 画布重读（有脏只提示）", () => {
  const app源码 = read("client/src/App.jsx");
  const chat源码 = read("client/src/components/ChatPanel.jsx");
  // ChatPanel：事件与工具活动都接出来
  assert.match(chat源码, /case "canvas_changed":[\s\S]{0,200}?onCanvasChanged\?\.\(data\)/, "ChatPanel 必须把 canvas_changed 交给外层");
  assert.match(chat源码, /startsWith\("canvas_"\)[\s\S]{0,120}?onCanvasActivity\?\.\(\{ active: true/, "canvas_* 工具开始要上报活动");
  assert.match(chat源码, /startsWith\("canvas_"\)[\s\S]{0,120}?onCanvasActivity\?\.\(\{ active: false/, "canvas_* 工具结束要清除活动");
  // App：收到事件递增 revision，并把 busy/令牌传给组件
  assert.match(app源码, /onCanvasChanged=\{\(\) => setCanvasRevision/, "App 必须接收 canvas_changed 并递增令牌");
  assert.match(app源码, /onCanvasActivity=\{\(\{ active \}\) => setCanvasAgentBusy/, "App 必须把 Agent 活动传给画布");
  assert.match(app源码, /refreshToken=\{canvasRevision\}/, "画布组件必须收到刷新令牌");
  assert.match(app源码, /agentBusy=\{canvasAgentBusy\}/, "画布组件必须收到 Agent 活动指示");
  // 组件：令牌变化时干净才自动重读；有脏只提示不丢改动
  assert.match(画布源码, /refreshToken = 0/, "组件必须接受 refreshToken");
  assert.match(画布源码, /上次刷新令牌/, "组件必须记录上次令牌，避免挂载即重读");
  assert.match(画布源码, /if \(有脏\) \{[\s\S]{0,120}?set远端更新\(true\)/, "有未保存修改时只提示，不自动刷新");
  assert.match(画布源码, /Agent 正在编辑/, "Agent 活动时工具条必须有可见状态");
  assert.match(画布源码, /远端更新 &&/, "远端更新提示横幅必须渲染");
});

test("最近画布入口：空态列表点击会打开真实画布，而不是只给提示", () => {
  const app源码 = read("client/src/App.jsx");
  assert.match(画布源码, /onOpenCanvas\(\s*标识\s*\)/, "最近画布列表必须调用 onOpenCanvas");
  assert.match(app源码, /onOpenCanvas=\{\(slug, title\) => handleDesignCreated\(tab\.id, slug, title \|\| slug\)\}/, "App 必须把最近画布点击接到标签替换（打开真实画布）");
  // 画布标签恢复必须等运行开关快照，否则刷新后 design 标签可能被误丢
  assert.match(app源码, /Promise\.resolve\(flagsReady\)\.then\(restore\)/, "画布恢复必须等 flagsReady，避免 design 标签被误判关闭");
});

test("验收反馈补齐：抓手 / 播放 / 版本历史 / 页面设置 / 添加到对话 / 最大化隐藏对话栏 / PPT 预览加速", () => {
  const 样式源码 = read("client/src/styles.css");
  const app源码 = read("client/src/App.jsx");
  const server源码 = read("server/创作画布.mjs");
  const routes源码 = read("server/index.mjs");
  const ppt源码 = read("client/src/components/PptxViewer.jsx");

  // 抓手工具
  assert.match(画布源码, /手形工具/, "必须有抓手工具状态");
  assert.match(画布源码, /pan-mode/, "抓手模式必须落到视图类名");
  assert.match(样式源码, /\.oaw-canvas-viewport\.pan-mode/, "抓手光标样式必须存在");

  // 播放
  assert.match(画布源码, /播放中/, "必须有播放态");
  assert.match(画布源码, /oaw-canvas-play/, "必须有播放覆盖层");
  assert.match(样式源码, /\.oaw-canvas-play\b/, "播放样式必须存在");

  // 添加到对话
  assert.match(画布源码, /onAddToChat/, "组件必须接受 onAddToChat 回调");
  assert.match(画布源码, /designs\/\$\{画布键\}\/project\/canvas\.json/, "必须把画布索引作为 @ 引用");
  assert.match(app源码, /onAddToChat=\{\(text\)/, "App 必须接线 onAddToChat");

  // 页面主题与间距
  assert.match(画布源码, /页面设置/, "必须有页面设置状态");
  assert.match(画布源码, /整理画板/, "必须能按板间距整理画板");
  assert.match(样式源码, /oaw-canvas-safe-area/, "安全边距辅助线样式必须存在");

  // 版本历史
  assert.match(画布源码, /listCanvasHistory/, "前端必须读取版本历史 API");
  assert.match(画布源码, /restoreCanvasHistory/, "前端必须调用恢复 API");
  assert.match(server源码, /export function listCanvasHistory/, "服务端必须导出历史列表");
  assert.match(server源码, /export function restoreBoardHistory/, "服务端必须导出历史恢复");
  assert.match(server源码, /HISTORY_DIR/, "历史快照必须落在 .history/");
  assert.match(routes源码, /\/api\/canvas\/:slug\/history/, "必须注册历史路由");

  // 最大化画布：隐藏对话区与拖动条
  assert.match(样式源码, /\.app\.canvas-maximized \.center-area[\s\S]{0,60}display: none/, "最大化画布必须隐藏对话区");

  // PPT 预览加速
  assert.match(ppt源码, /文件字节缓存/, "PPT 预览必须有字节缓存");
  assert.doesNotMatch(ppt源码, /cache: "no-store"/, "PPT raw 请求不得再强制 no-store");
  assert.match(ppt源码, /首屏缓存/, "PPT 必须有首屏缓存图");
});

console.log(failed ? "\n创作画布界面接线测试：存在失败项" : `\n创作画布界面接线测试：全部通过（${通过数} 例）`);
process.exit(failed ? 1 : 0);
