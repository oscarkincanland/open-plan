/**
 * 创作画布模板回归（test:canvas-template）：模板库列表、画布另存为模板、导入画布为模板、
 * createCanvas 按 templateSlug 实例化（{{title}} 占位符替换、坐标/pages/assets 保持）、
 * 错误分支（重复 slug、非法 slug、confirmed 门禁、内置模板不可删、来源越界）。
 *
 * 运行：node scripts/创作画布模板测试.mjs
 * 临时工作区使用 os.tmpdir()，脚本结束（含异常）后整体清理，不触碰用户真实工作区。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createCanvas,
  createBoard,
  deleteCanvasTemplate,
  importCanvasTemplate,
  listCanvasTemplates,
  readBoard,
  readCanvas,
  saveCanvasAsTemplate,
  writeBoard,
} from "../server/创作画布.mjs";

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

/** 断言抛出指定 CANVAS_* 错误码。 */
function expectCode(fn, code, hint = "") {
  try {
    fn();
  } catch (error) {
    assert.equal(error?.code, code, `${hint} 期望 ${code}，实际 ${error?.code}: ${error?.message}`);
    return error;
  }
  assert.fail(`${hint} 应抛出 ${code}，但没有抛错`);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-canvas-template-"));
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(tmpRoot, "ws-")));
const designs = path.join(workspace, "designs");

try {
  // ---------- 模板列表 ----------
  console.log("▶ 模板列表");

  check("listCanvasTemplates 返回 4 条内置模板且均为 builtin", () => {
    const { templates } = listCanvasTemplates(workspace);
    const builtin = templates.filter((item) => item.builtin);
    assert.equal(builtin.length, 4, `内置模板应为 4 条，实际 ${builtin.length}`);
    assert.deepEqual(builtin.map((item) => item.slug), ["blank", "cover", "onepager", "deck"]);
  });

  check("模板库目录不存在时列表仍可用（只有内置）", () => {
    assert.ok(!fs.existsSync(path.join(designs, ".templates")), "初始状态不应有 .templates");
    const { templates } = listCanvasTemplates(workspace);
    assert.equal(templates.every((item) => item.builtin), true);
  });

  // ---------- 另存为模板 + 实例化 ----------
  console.log("▶ 另存为模板 + 实例化");

  check("createCanvas + writeBoard 准备带占位符的源画布", () => {
    const created = createCanvas(workspace, { slug: "src-deck", title: "季度汇报", kind: "deck" });
    assert.equal(created.kind, "deck");
    writeBoard(
      workspace,
      "src-deck",
      "boards/outline.board.json",
      {
        v: 1,
        w: 1280,
        h: 720,
        background: "#f7f8fa",
        elements: [
          { id: "el-h1", type: "text", x: 80, y: 60, w: 900, h: 90, text: "{{title}} · 提纲", style: { fontSize: 40, fontWeight: 700, color: "#111111" } },
          { id: "el-box", type: "rect", x: 80, y: 200, w: 400, h: 300, style: { fill: "#2f6bff", radius: 8 } },
        ],
      },
      { title: "{{title}} 提纲页", actor: "ui" },
    );
    // 第二页：pages 分组
    const board2 = createBoard(workspace, "src-deck", { title: "结论页", path: "boards/conclusion.board.json", page: "p1" });
    assert.equal(board2.boardPath, "boards/conclusion.board.json");
  });

  check("saveCanvasAsTemplate 生成 oaw-canvas-template 且不带 rev", () => {
    const saved = saveCanvasAsTemplate(workspace, "src-deck", { title: "季度汇报模板" });
    assert.equal(saved.kind, "deck");
    assert.ok(saved.boards >= 2, `模板应至少 2 块板，实际 ${saved.boards}`);
    const file = path.join(designs, ".templates", saved.slug, "project", "canvas.json");
    assert.ok(fs.existsSync(file), "模板 canvas.json 应存在");
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(doc.format, "oaw-canvas-template");
    assert.equal(doc.title, "季度汇报模板");
    assert.equal(doc.rev, undefined, "模板不应带 rev");
    assert.equal(doc.boards["boards/outline.board.json"].title, "{{title}} 提纲页");
    const board = JSON.parse(fs.readFileSync(path.join(designs, ".templates", saved.slug, "project", "boards", "outline.board.json"), "utf8"));
    assert.equal(board.rev, undefined, "模板板不应带 rev");
    assert.equal(board.elements[0].text, "{{title}} · 提纲");
  });

  check("listCanvasTemplates 出现用户模板", () => {
    const { templates } = listCanvasTemplates(workspace);
    const user = templates.filter((item) => !item.builtin);
    assert.equal(user.length, 1);
    assert.equal(user[0].title, "季度汇报模板");
    assert.equal(user[0].kind, "deck");
  });

  check("createCanvas(templateSlug) 实例化：占位符替换、pages 保留、rev 重置", () => {
    const created = createCanvas(workspace, { slug: "实例化画布", title: "十一月汇报", templateSlug: "季度汇报模板" });
    assert.equal(created.kind, "deck", "kind 应以模板为准");
    assert.equal(created.boards, 3, "模板含封面/提纲/结论共 3 块板");
    const { canvas, boards } = readCanvas(workspace, "实例化画布");
    assert.equal(canvas.format, "oaw-canvas");
    assert.equal(canvas.rev, 1);
    assert.equal(canvas.pages.length, 1, "模板 pages 应保留");
    const outline = boards.find((item) => item.path === "boards/outline.board.json");
    assert.ok(outline, "实例化画布应含提纲板");
    assert.equal(outline.title, "十一月汇报 提纲页", "板标题占位符应替换");
    const board = readBoard(workspace, "实例化画布", "boards/outline.board.json").board;
    assert.equal(board.elements[0].text, "十一月汇报 · 提纲", "文本占位符应替换");
    assert.equal(board.background, "#f7f8fa", "板背景应保持");
    assert.equal(board.rev, 1, "实例化板 rev 从 1 起算");
    // 源画布不受影响
    const sourceBoard = readBoard(workspace, "src-deck", "boards/outline.board.json").board;
    assert.equal(sourceBoard.elements[0].text, "{{title}} · 提纲", "源画布占位符不应被改写");
  });

  check("saveCanvasAsTemplate 重复 slug 报 CANVAS_EXISTS", () => {
    const first = saveCanvasAsTemplate(workspace, "src-deck", { title: "另一个名字" });
    expectCode(() => saveCanvasAsTemplate(workspace, "src-deck", { title: "另一个名字" }), "CANVAS_EXISTS");
    // 清理第一个，避免影响后续计数
    deleteCanvasTemplate(workspace, first.slug, { confirmed: true });
  });

  // ---------- 导入为模板 ----------
  console.log("▶ 导入为模板");

  check("importCanvasTemplate 从工作区画布目录导入模板并可实例化", () => {
    // 手工构造源画布目录（工作区内、非创作画布 API 创建）
    const sourceDir = path.join(designs, "外部画布", "project");
    fs.mkdirSync(path.join(sourceDir, "boards"), { recursive: true });
    fs.mkdirSync(path.join(sourceDir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "assets", "logo.txt"), "demo-asset", "utf8");
    fs.writeFileSync(
      path.join(sourceDir, "boards", "page.board.json"),
      JSON.stringify({ v: 1, w: 960, h: 540, background: "#ffffff", rev: 7, elements: [{ id: "el-t", type: "text", x: 10, y: 10, w: 300, h: 60, text: "{{title}} 页", style: { fontSize: 24 } }] }), "utf8",
    );
    fs.writeFileSync(
      path.join(sourceDir, "canvas.json"),
      JSON.stringify({
        v: 3,
        title: "外部来源画布",
        kind: "board",
        boards: { "boards/page.board.json": { x: 0, y: 0, w: 960, h: 540, title: "页面" } },
        order: ["boards/page.board.json"],
      }),
      "utf8",
    );
    const imported = importCanvasTemplate(workspace, { sourcePath: path.join(designs, "外部画布"), title: "外部模板" });
    assert.ok(imported.slug, "导入应返回模板 slug");
    const created = createCanvas(workspace, { title: "来自外部模板", templateSlug: imported.slug });
    assert.equal(created.boards, 1);
    const board = readBoard(workspace, created.slug, "boards/page.board.json").board;
    assert.equal(board.elements[0].text, "来自外部模板 页", "实例化应替换占位符");
    assert.equal(board.rev, 1);
    assert.ok(fs.existsSync(path.join(designs, created.slug, "project", "assets", "logo.txt")), "assets 应随模板复制");
  });

  check("importCanvasTemplate 来源越界报 CANVAS_PATH_DENIED", () => {
    expectCode(() => importCanvasTemplate(workspace, { sourcePath: path.join(os.tmpdir(), "outside-canvas") }), "CANVAS_PATH_DENIED");
    expectCode(() => importCanvasTemplate(workspace, { sourcePath: path.join(workspace, "..", "escape") }), "CANVAS_PATH_DENIED");
  });

  check("importCanvasTemplate 来源缺画板报 CANVAS_INVALID", () => {
    const emptyDir = path.join(designs, "空画布", "project");
    fs.mkdirSync(emptyDir, { recursive: true });
    fs.writeFileSync(path.join(emptyDir, "canvas.json"), JSON.stringify({ v: 3, title: "空", boards: {}, order: [] }), "utf8");
    expectCode(() => importCanvasTemplate(workspace, { sourcePath: path.join(designs, "空画布") }), "CANVAS_INVALID");
  });

  // ---------- 删除与门禁 ----------
  console.log("▶ 删除与门禁");

  check("deleteCanvasTemplate 无 confirmed 报 CANVAS_CONFIRM_REQUIRED", () => {
    const 用户模板 = listCanvasTemplates(workspace).templates.filter((item) => !item.builtin);
    assert.ok(用户模板.length >= 1, "应存在用户模板");
    expectCode(() => deleteCanvasTemplate(workspace, 用户模板[0].slug, {}), "CANVAS_CONFIRM_REQUIRED");
    // 逐个清理全部用户模板，再断言列表为空
    for (const 项 of 用户模板) {
      const deleted = deleteCanvasTemplate(workspace, 项.slug, { confirmed: true });
      assert.equal(deleted.ok, true);
      assert.ok(deleted.trash.includes(".trash"), "应软删到 .templates/.trash");
    }
    const after = listCanvasTemplates(workspace).templates.filter((item) => !item.builtin);
    assert.equal(after.length, 0, "删除后用户模板应为空");
  });

  check("内置模板不可删除", () => {
    expectCode(() => deleteCanvasTemplate(workspace, "blank", { confirmed: true }), "CANVAS_INVALID");
  });

  check("模板 slug 非法报 CANVAS_INVALID", () => {
    expectCode(() => saveCanvasAsTemplate(workspace, "src-deck", { title: "x", templateSlug: "非法 slug" }), "CANVAS_INVALID");
    expectCode(() => createCanvas(workspace, { title: "y", templateSlug: "../escape" }), "CANVAS_INVALID");
  });

  check("createCanvas 引用不存在的模板报 CANVAS_NOT_FOUND", () => {
    expectCode(() => createCanvas(workspace, { title: "z", templateSlug: "ghost-tpl" }), "CANVAS_NOT_FOUND");
  });

  check("模板列表不受损坏模板目录影响", () => {
    const broken = path.join(designs, ".templates", "broken-tpl", "project");
    fs.mkdirSync(broken, { recursive: true });
    fs.writeFileSync(path.join(broken, "canvas.json"), "{not-json", "utf8");
    const { templates } = listCanvasTemplates(workspace);
    assert.equal(templates.some((item) => item.slug === "broken-tpl"), false, "损坏模板应被跳过");
    assert.equal(templates.filter((item) => item.builtin).length, 4, "内置模板不受影响");
  });
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\n创作画布模板测试：${passed.length} 项通过${process.exitCode ? "（存在失败）" : ""}`);
