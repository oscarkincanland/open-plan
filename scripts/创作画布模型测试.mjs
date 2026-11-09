/**
 * 创作画布模型回归（test:canvas-model）：slug/路径校验、schema、元素类型、CAS、
 * 限额、兼容画布识别、导入不改原字节、软删除、操作日志。
 *
 * 运行：node scripts/创作画布模型测试.mjs
 * 临时工作区使用 os.tmpdir()，脚本结束（含异常）后整体清理，不触碰用户真实工作区。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CANVAS_LIMITS,
  createBoard,
  createCanvas,
  deleteBoard,
  deleteCanvas,
  diffCanvasVersions,
  duplicateBoard,
  importCanvas,
  listCanvases,
  listCanvasHistory,
  listCanvasVersions,
  listOperations,
  readBoard,
  readCanvas,
  readCanvasAsset,
  readCanvasVersion,
  restoreBoardHistory,
  restoreCanvasVersion,
  updateCanvas,
  updatePages,
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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oaw-canvas-model-"));
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(tmpRoot, "ws-")));
const designs = path.join(workspace, "designs");

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function textElement(overrides = {}) {
  return {
    id: "el-title",
    type: "text",
    x: 80, y: 64, w: 960, h: 120,
    text: "规聚 · 交通规划 AI 工作台",
    style: { fontSize: 56, fontWeight: 700, fontFamily: "Microsoft YaHei", color: "#141413", textAlign: "left", lineHeight: 1.2 },
    ...overrides,
  };
}

try {
  // ---------- 创建 / 读取 / 列表 ----------
  console.log("▶ 创建 / 读取 / 列表");

  check("createCanvas 缺省模板写出 canvas.json + 一块空对象板", () => {
    const result = createCanvas(workspace, { slug: "deck-a", title: "汇报 A", kind: "deck", template: "deck" });
    assert.equal(result.slug, "deck-a");
    assert.equal(result.boards, 1);
    const canvasFile = path.join(designs, "deck-a", "project", "canvas.json");
    assert.ok(fs.existsSync(canvasFile), "canvas.json 应存在");
    const canvas = JSON.parse(fs.readFileSync(canvasFile, "utf8"));
    assert.equal(canvas.v, 3);
    assert.equal(canvas.format, "oaw-canvas");
    assert.equal(canvas.rev, 1);
    assert.equal(canvas.kind, "deck");
    assert.deepEqual(canvas.order, ["boards/cover.board.json"]);
    assert.equal(canvas.boards["boards/cover.board.json"].role, "slide");
    const board = JSON.parse(fs.readFileSync(path.join(designs, "deck-a", "project", "boards", "cover.board.json"), "utf8"));
    assert.equal(board.rev, 1);
    assert.equal(board.w, 1280);
    // 目录骨架：assets / legacy / exports / .trash
    for (const sub of ["assets", "legacy"]) assert.ok(fs.existsSync(path.join(designs, "deck-a", "project", sub)), sub);
    for (const sub of ["exports", ".trash"]) assert.ok(fs.existsSync(path.join(designs, "deck-a", sub)), sub);
  });

  check("createCanvas 重名 → CANVAS_EXISTS", () => {
    expectCode(() => createCanvas(workspace, { slug: "deck-a", title: "重复" }), "CANVAS_EXISTS");
  });

  check("createCanvas 由标题生成中文 slug；非法 slug → CANVAS_INVALID", () => {
    const result = createCanvas(workspace, { title: "规聚 10 分钟汇报", template: "cover" });
    assert.match(result.slug, /^规聚-10-分钟汇报$/u);
    for (const bad of ["../evil", "a/b", "a.b", "Bad Slug", "a\\b"]) {
      expectCode(() => createCanvas(workspace, { slug: bad, title: "x" }), "CANVAS_INVALID", `slug=${JSON.stringify(bad)}`);
    }
  });

  check("未知模板 → CANVAS_INVALID", () => {
    expectCode(() => createCanvas(workspace, { slug: "deck-bad-template", title: "x", template: "nope" }), "CANVAS_INVALID");
  });

  check("readCanvas 返回 canvas 摘要 + boards + compatible=false", () => {
    const { canvas, boards, compatible } = readCanvas(workspace, "deck-a");
    assert.equal(compatible, false);
    assert.equal(canvas.title, "汇报 A");
    assert.equal(canvas.managed, true);
    assert.equal(boards.length, 1);
    assert.deepEqual(
      Object.keys(boards[0]).sort(),
      ["exists", "h", "kind", "page", "path", "role", "title", "w", "x", "y"].sort(),
    );
    assert.equal(boards[0].path, "boards/cover.board.json");
    assert.equal(boards[0].kind, "object");
    assert.equal(boards[0].exists, true);
  });

  check("readCanvas 不存在的画布 → CANVAS_NOT_FOUND", () => {
    expectCode(() => readCanvas(workspace, "nope"), "CANVAS_NOT_FOUND");
  });

  check("listCanvases 输出 slug/title/kind/boards/updatedAt/path", () => {
    const { canvases } = listCanvases(workspace);
    const deck = canvases.find((item) => item.slug === "deck-a");
    assert.ok(deck, "应列出 deck-a");
    assert.equal(deck.boards, 1);
    assert.equal(deck.kind, "deck");
    assert.equal(deck.path, "designs/deck-a/project/canvas.json");
    assert.ok(deck.updatedAt, "updatedAt 应存在");
    assert.equal(typeof deck.compatible, "boolean");
  });

  // ---------- 写板 + CAS ----------
  console.log("▶ 写板 / CAS / schema");

  check("writeBoard 新建板 → rev=1 且自动登记进 canvas.json", () => {
    const result = writeBoard(workspace, "deck-a", "boards/body.board.json", {
      v: 1, w: 1280, h: 720, background: "#ffffff", elements: [textElement()],
    }, { actor: "agent" });
    assert.equal(result.rev, 1);
    assert.equal(result.created, true);
    assert.equal(result.canvasRev, 2);
    const { boards } = readCanvas(workspace, "deck-a");
    const added = boards.find((item) => item.path === "boards/body.board.json");
    assert.ok(added, "新板应登记进 canvas.json");
    assert.equal(added.y, 840, "新板应排在已有板下方");
    const { board, rev } = readBoard(workspace, "deck-a", "boards/body.board.json");
    assert.equal(rev, 1);
    assert.equal(board.elements[0].text, "规聚 · 交通规划 AI 工作台");
  });

  check("writeBoard expectedRev 命中 → rev 递增；不命中 → CANVAS_REV_CONFLICT", () => {
    const next = writeBoard(workspace, "deck-a", "boards/body.board.json", {
      v: 1, w: 1280, h: 720, elements: [textElement({ text: "第二次保存" })],
    }, { expectedRev: 1 });
    assert.equal(next.rev, 2);
    const conflict = expectCode(() => writeBoard(workspace, "deck-a", "boards/body.board.json", {
      v: 1, w: 1280, h: 720, elements: [],
    }, { expectedRev: 1 }), "CANVAS_REV_CONFLICT");
    assert.equal(conflict.details.expectedRev, 1);
    assert.equal(conflict.details.actualRev, 2);
    assert.equal(readBoard(workspace, "deck-a", "boards/body.board.json").rev, 2);
  });

  check("updateCanvas 标题/坐标/order + expectedRev CAS", () => {
    const before = readCanvas(workspace, "deck-a").canvas.rev;
    const conflict = expectCode(() => updateCanvas(workspace, "deck-a", { title: "冲突", expectedRev: before + 99 }), "CANVAS_REV_CONFLICT");
    assert.equal(conflict.details.actualRev, before);
    const updated = updateCanvas(workspace, "deck-a", {
      title: "汇报 A（改）",
      expectedRev: before,
      boards: {
        // order + boards 同时给出 = 整体替换，必须是全量映射（与前端画布状态一致）
        "boards/body.board.json": { x: 1400, y: 0, w: 1280, h: 720, title: "正文" },
        "boards/cover.board.json": { x: 0, y: 0, w: 1280, h: 720, title: "封面" },
      },
      order: ["boards/body.board.json", "boards/cover.board.json"],
    });
    assert.equal(updated.rev, before + 1);
    const { canvas, boards } = readCanvas(workspace, "deck-a");
    assert.equal(canvas.title, "汇报 A（改）");
    assert.deepEqual(canvas.order, ["boards/body.board.json", "boards/cover.board.json"]);
    assert.equal(boards[0].path, "boards/body.board.json");
    assert.equal(boards[0].x, 1400);
    assert.equal(boards[0].title, "正文");
  });

  check("updateCanvas order 未覆盖全部板 → CANVAS_INVALID", () => {
    expectCode(() => updateCanvas(workspace, "deck-a", { order: ["boards/cover.board.json"] }), "CANVAS_INVALID");
  });

  check("updateCanvas boards+order = 整体替换（删除板不移除文件）", () => {
    createCanvas(workspace, { slug: "replace-canvas", title: "替换画布" });
    writeBoard(workspace, "replace-canvas", "boards/one.board.json", { v: 1, w: 640, h: 360, elements: [] });
    writeBoard(workspace, "replace-canvas", "boards/two.board.json", { v: 1, w: 640, h: 360, elements: [] });
    assert.equal(readCanvas(workspace, "replace-canvas").boards.length, 3);
    // 前端删除一块板：boards/order 都是“删掉后”的全量状态
    const afterDelete = updateCanvas(workspace, "replace-canvas", {
      boards: {
        "boards/cover.board.json": { x: 0, y: 0, w: 640, h: 360, title: "封面" },
        "boards/one.board.json": { x: 700, y: 0, w: 640, h: 360, title: "一" },
      },
      order: ["boards/cover.board.json", "boards/one.board.json"],
    });
    assert.equal(afterDelete.boards, 2);
    const { canvas } = readCanvas(workspace, "replace-canvas");
    assert.deepEqual(canvas.order, ["boards/cover.board.json", "boards/one.board.json"]);
    assert.equal(canvas.boards["boards/two.board.json"], undefined);
    assert.equal(canvas.boards["boards/one.board.json"].x, 700);
    assert.ok(fs.existsSync(path.join(designs, "replace-canvas", "project", "boards", "two.board.json")), "替换语义不删文件");
    // 只给 boards → 合并（其余板保留）
    updateCanvas(workspace, "replace-canvas", { boards: { "boards/one.board.json": { x: 42 } } });
    assert.equal(readCanvas(workspace, "replace-canvas").boards.length, 2);
    assert.equal(readCanvas(workspace, "replace-canvas").canvas.boards["boards/one.board.json"].x, 42);
  });

  check("updateCanvas 板坐标越界 → CANVAS_INVALID", () => {
    expectCode(() => updateCanvas(workspace, "deck-a", {
      boards: { "boards/body.board.json": { w: 10 } },
    }), "CANVAS_INVALID");
  });

  check("元素类型非法 / id 重复 / 类型白名单", () => {
    const good = { v: 1, w: 1280, h: 720, elements: [textElement()] };
    expectCode(() => writeBoard(workspace, "deck-a", "boards/bad.board.json", {
      ...good, elements: [{ ...good.elements[0], type: "video" }],
    }), "CANVAS_INVALID");
    expectCode(() => writeBoard(workspace, "deck-a", "boards/bad.board.json", {
      ...good, elements: [textElement(), textElement()],
    }), "CANVAS_INVALID");
    // rect / line / image / svg 均为合法类型（含 line 的 x1..y2 与 image 的 src）
    const ok = writeBoard(workspace, "deck-a", "boards/all-types.board.json", {
      v: 1, w: 640, h: 360,
      elements: [
        { id: "t1", type: "text", x: 0, y: 0, w: 100, h: 40, text: "hi", style: { fontSize: 20 } },
        { id: "r1", type: "rect", x: 0, y: 50, w: 100, h: 2, style: { fill: "#d6dce5" } },
        { id: "l1", type: "line", x1: 0, y1: 0, x2: 100, y2: 100, style: { stroke: "#141413", strokeWidth: 2 } },
        { id: "s1", type: "svg", x: 0, y: 0, w: 100, h: 100, markup: "<svg viewBox=\"0 0 10 10\"><rect width=\"10\" height=\"10\"/></svg>" },
      ],
    });
    assert.equal(ok.rev, 1);
    const { board } = readBoard(workspace, "deck-a", "boards/all-types.board.json");
    assert.deepEqual(board.elements.map((item) => item.type), ["text", "rect", "line", "svg"]);
    assert.equal(board.w, 640);
  });

  check("图片 src 只允许 project 内相对路径（../ 逃逸/绝对路径/URL 拒绝）", () => {
    const base = { v: 1, w: 1280, h: 720, elements: [] };
    const imageEl = (src) => ({ id: "img-1", type: "image", x: 0, y: 0, w: 100, h: 100, src });
    for (const src of ["http://evil/x.png", "https://evil/x.png", "C:/Windows/x.png", "/etc/passwd", "../../outside.png", "javascript:alert(1)"]) {
      expectCode(() => writeBoard(workspace, "deck-a", "boards/img.board.json", {
        ...base, elements: [imageEl(src)],
      }), "CANVAS_INVALID", `src=${src}`);
    }
    // ../assets/... 相对板文件目录、解析后仍在 project 内 → 允许（计划 §3.3 示例写法）
    const ok = writeBoard(workspace, "deck-a", "boards/img.board.json", {
      ...base, elements: [imageEl("../assets/map.png")],
    });
    assert.equal(ok.rev, 1);
  });

  check("SVG 块 markup 落盘即 sanitize（去 script/on*/foreignObject/外链）", () => {
    writeBoard(workspace, "deck-a", "boards/svg.board.json", {
      v: 1, w: 640, h: 360,
      elements: [{
        id: "svg-1", type: "svg", x: 0, y: 0, w: 100, h: 100,
        markup: '<svg viewBox="0 0 10 10"><script>alert(1)</script><rect onclick="x()" width="10" height="10" fill="red"/><image href="https://evil/x.png"/><foreignObject><div/></foreignObject></svg>',
      }],
    });
    const { board } = readBoard(workspace, "deck-a", "boards/svg.board.json");
    const markup = board.elements[0].markup;
    assert.ok(!/<script/i.test(markup), `script 应被移除：${markup}`);
    assert.ok(!/onclick/i.test(markup), `on* 应被移除：${markup}`);
    assert.ok(!/foreignObject/i.test(markup), `foreignObject 应被移除：${markup}`);
    assert.ok(!/https?:\/\//i.test(markup), `外链应被移除：${markup}`);
    assert.match(markup, /<rect/);
  });

  // ---------- 路径穿越 ----------
  console.log("▶ 路径穿越拒绝");

  check("writeBoard 穿越/绝对路径/exports·.trash/legacy 全部拒绝", () => {
    const board = { v: 1, w: 640, h: 360, elements: [] };
    for (const bad of [
      "boards/../../evil.board.json",
      "../evil.board.json",
      "C:/tmp/evil.board.json",
      "//server/share/evil.board.json",
      "/abs/evil.board.json",
      "https://evil/x.board.json",
      "exports/evil.board.json",
      ".trash/evil.board.json",
      "legacy/evil.board.json",
      ".hidden/evil.board.json",
    ]) {
      expectCode(() => writeBoard(workspace, "deck-a", bad, board), "CANVAS_PATH_DENIED", `path=${bad}`);
    }
  });

  check("画板文件名必须是 [A-Za-z0-9_-]{1,64}.board.json", () => {
    const board = { v: 1, w: 640, h: 360, elements: [] };
    expectCode(() => writeBoard(workspace, "deck-a", "boards/中文名.board.json", board), "CANVAS_PATH_DENIED");
    expectCode(() => writeBoard(workspace, "deck-a", "boards/cover.html", board), "CANVAS_PATH_DENIED");
  });

  check("readBoard 穿越 → CANVAS_PATH_DENIED；不存在 → CANVAS_NOT_FOUND", () => {
    expectCode(() => readBoard(workspace, "deck-a", "../../etc/passwd"), "CANVAS_PATH_DENIED");
    expectCode(() => readBoard(workspace, "deck-a", "boards/none.board.json"), "CANVAS_NOT_FOUND");
  });

  // ---------- 限额 ----------
  console.log("▶ 限额");

  check("单板元素 > 500 → CANVAS_LIMIT", () => {
    const elements = Array.from({ length: CANVAS_LIMITS.elements + 1 }, (_, index) => ({
      id: `e${index}`, type: "rect", x: 0, y: 0, w: 10, h: 10, style: { fill: "#fff" },
    }));
    expectCode(() => writeBoard(workspace, "deck-a", "boards/limit.board.json", { v: 1, w: 1280, h: 720, elements }), "CANVAS_LIMIT");
  });

  check("单元素文本 > 20000 字符 → CANVAS_LIMIT", () => {
    expectCode(() => writeBoard(workspace, "deck-a", "boards/limit.board.json", {
      v: 1, w: 1280, h: 720,
      elements: [textElement({ text: "字".repeat(CANVAS_LIMITS.textChars + 1) })],
    }), "CANVAS_LIMIT");
  });

  check("单板文件 > 5MB → CANVAS_LIMIT", () => {
    const chunk = "字".repeat(12000);
    const elements = Array.from({ length: CANVAS_LIMITS.elements }, (_, index) => ({
      id: `big${index}`, type: "text", x: 0, y: 0, w: 100, h: 20, text: chunk, style: { fontSize: 12 },
    }));
    expectCode(() => writeBoard(workspace, "deck-a", "boards/limit.board.json", { v: 1, w: 1280, h: 720, elements }), "CANVAS_LIMIT");
  });

  check("CANVAS_LIMITS 常量齐全", () => {
    for (const key of ["boards", "files", "bytes", "boardBytes", "elements", "textChars"]) {
      assert.equal(typeof CANVAS_LIMITS[key], "number", `CANVAS_LIMITS.${key}`);
    }
    assert.equal(CANVAS_LIMITS.boards, 200);
    assert.equal(CANVAS_LIMITS.boardBytes, 5 * 1024 * 1024);
  });

  // ---------- 兼容画布识别 / 导入 ----------
  console.log("▶ 兼容画布识别与导入");

  const compatRoot = path.join(designs, "compat-src");
  const compatProject = path.join(compatRoot, "project");
  function makeCompatCanvas() {
    fs.mkdirSync(path.join(compatProject, "shots"), { recursive: true });
    fs.writeFileSync(path.join(compatProject, "Main.dc.html"), "<!doctype html><html><body><h1>封面</h1></body></html>", "utf8");
    fs.writeFileSync(path.join(compatProject, "02-why.dc.html"), "<!doctype html><html><body><h1>为什么</h1></body></html>", "utf8");
    fs.writeFileSync(path.join(compatProject, "shots", "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
    fs.writeFileSync(path.join(compatProject, "canvas.json"), JSON.stringify({
      v: 3,
      title: "外部画布",
      boards: {
        "Main.dc.html": { x: 0, y: 0, w: 1280, h: 720, title: "封面" },
        "02-why.dc.html": { x: 1360, y: 0, w: 1280, h: 720, title: "为什么" },
      },
      order: ["Main.dc.html", "02-why.dc.html"],
      pages: [{ id: "page-1", name: "Page 1" }],
      designSystems: [],
    }, null, 2), "utf8");
  }
  makeCompatCanvas();

  check("兼容画布：canvas.json 的 boards 键以 .dc.html 结尾 → compatible=true", () => {
    const { canvas, boards, compatible } = readCanvas(workspace, "compat-src");
    assert.equal(compatible, true);
    assert.equal(canvas.managed, false, "没有 format: oaw-canvas 应视为外部画布");
    assert.deepEqual(boards.map((item) => item.path), ["Main.dc.html", "02-why.dc.html"]);
    assert.ok(boards.every((item) => item.kind === "html"));
    assert.ok(boards.every((item) => item.exists === true));
  });

  check("readBoard 兼容板返回 html 文本、rev=0", () => {
    const { board, rev } = readBoard(workspace, "compat-src", "Main.dc.html");
    assert.equal(rev, 0);
    assert.equal(board.kind, "html");
    assert.match(board.html, /<h1>封面<\/h1>/);
  });

  check("外部画布只写最小字段：updateCanvas 不加 rev/pages/order", () => {
    const before = JSON.stringify(JSON.parse(fs.readFileSync(path.join(compatProject, "canvas.json"), "utf8")));
    const result = updateCanvas(workspace, "compat-src", {
      title: "外部画布（改名）",
      pages: [{ id: "p9", name: "不应写入" }],
      boards: { "Main.dc.html": { x: 40, y: 40 } },
    });
    assert.equal(result.managed, false);
    assert.equal(result.rev, 0);
    assert.ok(result.warnings.some((item) => item.includes("外部兼容画布")), JSON.stringify(result.warnings));
    const after = JSON.parse(fs.readFileSync(path.join(compatProject, "canvas.json"), "utf8"));
    assert.equal(after.title, "外部画布（改名）");
    assert.equal(after.boards["Main.dc.html"].x, 40);
    assert.equal(after.boards["Main.dc.html"].y, 40);
    assert.equal(after.rev, undefined, "外部画布不应补 rev");
    assert.equal(after.pages.length, 1, "pages 应保持原样");
    assert.notEqual(before, JSON.stringify(after));
  });

  check("外部画布不允许新增对象板 → CANVAS_INVALID", () => {
    expectCode(() => writeBoard(workspace, "compat-src", "boards/new.board.json", { v: 1, w: 100, h: 100, elements: [] }), "CANVAS_INVALID");
  });

  check("importCanvas 复制到 legacy/ 且原字节不变、来源目录不变", () => {
    const sourceMain = path.join(compatProject, "Main.dc.html");
    const sourceShot = path.join(compatProject, "shots", "shot.png");
    const sourceCanvasJson = path.join(compatProject, "canvas.json");
    const beforeHashes = {
      main: sha256(sourceMain),
      shot: sha256(sourceShot),
      canvas: sha256(sourceCanvasJson),
    };
    const result = importCanvas(workspace, { sourcePath: compatRoot, slug: "imported", title: "导入画布" });
    assert.equal(result.slug, "imported");
    assert.equal(result.boardCount, 2);
    assert.deepEqual(result.boards.map((item) => item.path), ["legacy/Main.dc.html", "legacy/02-why.dc.html"]);
    assert.equal(result.compatible, true);

    const legacyMain = path.join(designs, "imported", "project", "legacy", "Main.dc.html");
    const legacyShot = path.join(designs, "imported", "project", "legacy", "shots", "shot.png");
    assert.ok(fs.existsSync(legacyMain));
    assert.equal(sha256(legacyMain), beforeHashes.main, "legacy 板文件必须与原字节一致");
    assert.equal(sha256(legacyShot), beforeHashes.shot, "legacy 素材必须与原字节一致");
    assert.equal(sha256(sourceMain), beforeHashes.main, "来源文件不得被改写");
    assert.equal(sha256(sourceShot), beforeHashes.shot);
    assert.equal(sha256(sourceCanvasJson), beforeHashes.canvas, "来源 canvas.json 不得被改写");

    const { canvas, boards, compatible } = readCanvas(workspace, "imported");
    assert.equal(compatible, true);
    assert.equal(canvas.managed, true);
    assert.equal(canvas.title, "导入画布");
    assert.deepEqual(boards.map((item) => item.path), ["legacy/Main.dc.html", "legacy/02-why.dc.html"]);
    assert.deepEqual(readCanvas(workspace, "imported").canvas.order, ["legacy/Main.dc.html", "legacy/02-why.dc.html"]);
    // 导入后读兼容板内容可用
    assert.match(readBoard(workspace, "imported", "legacy/Main.dc.html").board.html, /封面/);
  });

  check("importCanvas 同一 slug 再次导入 → CANVAS_EXISTS", () => {
    expectCode(() => importCanvas(workspace, { sourcePath: compatRoot, slug: "imported" }), "CANVAS_EXISTS");
  });

  check("importCanvas 工作区外来源 → CANVAS_PATH_DENIED", () => {
    const outside = path.join(tmpRoot, "outside");
    fs.mkdirSync(path.join(outside, "project"), { recursive: true });
    fs.writeFileSync(path.join(outside, "project", "canvas.json"), JSON.stringify({ v: 3, boards: { "x.dc.html": { x: 0, y: 0, w: 1280, h: 720 } } }));
    fs.writeFileSync(path.join(outside, "project", "x.dc.html"), "<html></html>");
    expectCode(() => importCanvas(workspace, { sourcePath: outside, slug: "outside-import" }), "CANVAS_PATH_DENIED");
    expectCode(() => importCanvas(workspace, { sourcePath: "../../etc", slug: "bad-import" }), "CANVAS_PATH_DENIED");
  });

  check("importCanvas 非画布来源 → CANVAS_INVALID", () => {
    fs.mkdirSync(path.join(designs, "not-a-canvas"), { recursive: true });
    expectCode(() => importCanvas(workspace, { sourcePath: path.join(designs, "not-a-canvas"), slug: "nope-import" }), "CANVAS_INVALID");
  });

  // ---------- 软删除 ----------
  console.log("▶ 软删除");

  check("deleteBoard 需要 confirmed，缺省 → CANVAS_CONFIRM_REQUIRED", () => {
    expectCode(() => deleteBoard(workspace, "deck-a", "boards/all-types.board.json"), "CANVAS_CONFIRM_REQUIRED");
  });

  check("deleteBoard 移入 .trash 并从索引移除", () => {
    const result = deleteBoard(workspace, "deck-a", "boards/all-types.board.json", { confirmed: true });
    assert.equal(result.ok, true);
    assert.match(result.trash, /^designs\/deck-a\/\.trash\//);
    assert.ok(fs.existsSync(path.join(workspace, result.trash)), "回收站副本应存在");
    assert.equal(fs.existsSync(path.join(designs, "deck-a", "project", "boards", "all-types.board.json")), false, "原板文件应移走");
    const { boards } = readCanvas(workspace, "deck-a");
    assert.ok(!boards.some((item) => item.path === "boards/all-types.board.json"), "板应从 canvas.json 移除");
    expectCode(() => readBoard(workspace, "deck-a", "boards/all-types.board.json"), "CANVAS_NOT_FOUND");
  });

  check("deleteCanvas 需要 confirmed；确认后整体移入 designs/.trash", () => {
    expectCode(() => deleteCanvas(workspace, "deck-a"), "CANVAS_CONFIRM_REQUIRED");
    const original = path.join(designs, "deck-a");
    const result = deleteCanvas(workspace, "deck-a", { confirmed: true });
    assert.equal(result.ok, true);
    assert.match(result.trash, /^designs\/\.trash\/deck-a-/);
    assert.equal(fs.existsSync(original), false, "原目录应移走");
    assert.ok(fs.existsSync(path.join(workspace, result.trash, "project", "canvas.json")), "回收站应保留画布文件");
    // 删除日志随目录一起进回收站
    const opsFile = path.join(workspace, result.trash, "operations.jsonl");
    const ops = fs.readFileSync(opsFile, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(ops.some((item) => item.action === "delete"), "回收站内应保留 delete 日志");
    expectCode(() => readCanvas(workspace, "deck-a"), "CANVAS_NOT_FOUND");
    assert.ok(!listCanvases(workspace).canvases.some((item) => item.slug === "deck-a"));
  });

  // ---------- 操作日志 ----------
  console.log("▶ 操作日志 operations.jsonl");

  check("readCanvasAsset 读素材字节；越界/非白名单类型拒绝", () => {
    createCanvas(workspace, { slug: "readasset", title: "素材画布" });
    const canvasFile = path.join(designs, "readasset", "project", "assets", "a.png");
    fs.mkdirSync(path.dirname(canvasFile), { recursive: true });
    fs.writeFileSync(canvasFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    const asset = readCanvasAsset(workspace, "readasset", "assets/a.png");
    assert.equal(asset.mime, "image/png");
    assert.equal(asset.bytes, 7);
    assert.equal(asset.buffer.length, 7);
    expectCode(() => readCanvasAsset(workspace, "readasset", "../canvas.json"), "CANVAS_PATH_DENIED");
    expectCode(() => readCanvasAsset(workspace, "readasset", "assets/none.png"), "CANVAS_NOT_FOUND");
    fs.writeFileSync(path.join(designs, "readasset", "project", "assets", "bad.exe"), "MZ");
    expectCode(() => readCanvasAsset(workspace, "readasset", "assets/bad.exe"), "CANVAS_INVALID");
  });

  check("operations.jsonl 记录 create/save/import，含 actor/时间/摘要", () => {
    const ops = listOperations(workspace, "imported", { limit: 50 });
    assert.ok(ops.length >= 1, `至少 1 条日志，实际 ${ops.length}`);
    assert.ok(ops.some((item) => item.action === "import"), "应有 import");
    const createOps = listOperations(workspace, "规聚-10-分钟汇报", { limit: 20 });
    assert.ok(createOps.some((item) => item.action === "create" && item.actor === "ui"));
    for (const entry of ops) {
      assert.ok(entry.ts && !Number.isNaN(Date.parse(entry.ts)), "ts 应为 ISO 时间");
      assert.equal(typeof entry.summary, "string");
      assert.ok(["ui", "agent", "system"].includes(entry.actor));
    }
  });

  check("writeBoard 传 actor=agent 时日志记录 agent", () => {
    createCanvas(workspace, { slug: "ops-canvas", title: "日志画布" });
    writeBoard(workspace, "ops-canvas", "boards/x.board.json", { v: 1, w: 640, h: 360, elements: [] }, { actor: "agent" });
    const ops = listOperations(workspace, "ops-canvas", { limit: 20 });
    assert.ok(ops.some((item) => item.action === "save" && item.actor === "agent" && item.boardPath === "boards/x.board.json"));
  });

  // ---------- 版本历史 ----------
  console.log("▶ 版本历史");

  check("writeBoard 覆盖前留存快照；listCanvasHistory 只返回元数据", () => {
    createCanvas(workspace, { slug: "history-canvas", title: "历史画布" });
    writeBoard(workspace, "history-canvas", "boards/h.board.json", { v: 1, w: 800, h: 600, elements: [] }, { actor: "ui" });
    writeBoard(workspace, "history-canvas", "boards/h.board.json", { v: 1, w: 800, h: 600, elements: [textElement()] }, { actor: "agent" });
    const history = listCanvasHistory(workspace, "history-canvas", { boardPath: "boards/h.board.json" });
    assert.equal(history.items.length, 1, `应有 1 条历史，实际 ${history.items.length}`);
    assert.equal(history.items[0].rev, 1);
    assert.equal(history.items[0].actor, "agent", "快照记录的 actor = 触发这次保存的操作者");
    assert.equal(history.items[0].content, undefined, "列表不应返回内容");
    assert.ok(history.items[0].bytes > 0);
    const file = path.join(designs, "history-canvas", ".history", "boards_h.board.json.jsonl");
    assert.ok(fs.existsSync(file), "历史文件应写入 .history/");
  });

  check("restoreBoardHistory 恢复旧内容并产生新 rev；未知 id → CANVAS_HISTORY_NOT_FOUND", () => {
    const history = listCanvasHistory(workspace, "history-canvas", { boardPath: "boards/h.board.json" });
    const restored = restoreBoardHistory(workspace, "history-canvas", {
      boardPath: "boards/h.board.json",
      id: history.items[0].id,
      expectedRev: 2,
    });
    assert.equal(restored.rev, 3);
    const after = readBoard(workspace, "history-canvas", "boards/h.board.json");
    assert.equal(after.rev, 3);
    assert.equal(after.board.elements.length, 0, "应恢复到空板内容");
    expectCode(
      () => restoreBoardHistory(workspace, "history-canvas", { boardPath: "boards/h.board.json", id: "nope" }),
      "CANVAS_HISTORY_NOT_FOUND",
    );
  });

  // ---------- 画板/页与画布级版本（2026-11-09-004） ----------
  console.log("▶ 画板/页与画布级版本");

  check("createBoard/duplicateBoard/deleteBoard：页归属、元素 id 重生成、软删", () => {
    const created = createCanvas(workspace, { title: "画板 CRUD", slug: "board-crud", kind: "deck", template: "deck" });
    assert.equal(created.kind, "deck");
    const pageId = readCanvas(workspace, "board-crud").canvas.pages[0].id;
    const first = createBoard(workspace, "board-crud", { title: "内容页", page: pageId, template: "cover" });
    assert.equal(first.page, pageId);
    assert.ok(fs.existsSync(path.join(workspace, "designs", "board-crud", "project", first.boardPath)));
    const copied = duplicateBoard(workspace, "board-crud", first.boardPath, { title: "内容页副本" });
    assert.notEqual(copied.boardPath, first.boardPath);
    const copy = readBoard(workspace, "board-crud", copied.boardPath).board;
    const source = readBoard(workspace, "board-crud", first.boardPath).board;
    assert.equal(copy.elements.length, source.elements.length);
    assert.notEqual(copy.elements[0].id, source.elements[0].id, "复制板必须重新生成元素 id");
    const deleted = deleteBoard(workspace, "board-crud", copied.boardPath, { confirmed: true });
    assert.ok(deleted.trash.includes(".trash/"));
    assert.ok(!fs.existsSync(path.join(workspace, "designs", "board-crud", "project", copied.boardPath)));
    assert.ok(!readCanvas(workspace, "board-crud").boards.some((item) => item.path === copied.boardPath));
  });

  check("updatePages：新增页、删除页时板移动到 moveTo/第一页、至少保留一页", () => {
    createCanvas(workspace, { title: "页管理", slug: "page-canvas", kind: "deck", template: "deck" });
    const p1 = readCanvas(workspace, "page-canvas").canvas.pages[0].id;
    const board = createBoard(workspace, "page-canvas", { title: "归属测试", page: p1 });
    const updated = updatePages(workspace, "page-canvas", {
      pages: [{ id: p1, name: "第一页" }, { id: "p2", name: "第二页" }],
    });
    assert.equal(updated.pages.length, 2);
    const moved = updatePages(workspace, "page-canvas", {
      pages: [{ id: p1, name: "第一页" }, { id: "p2", name: "第二页" }],
      moveTo: "p2",
    });
    assert.equal(moved.removedPages.length, 0);
    const movedBoard = readCanvas(workspace, "page-canvas").boards.find((item) => item.path === board.boardPath);
    assert.equal(movedBoard.page, p1, "未删除页时不应移动板");
    const afterDelete = updatePages(workspace, "page-canvas", {
      pages: [{ id: "p2", name: "第二页" }],
    });
    assert.deepEqual(afterDelete.removedPages, [p1]);
    assert.equal(readCanvas(workspace, "page-canvas").boards.find((item) => item.path === board.boardPath).page, "p2");
    expectCode(() => updatePages(workspace, "page-canvas", { pages: [] }), "CANVAS_INVALID");
  });

  check("画布级版本：同 runId 合并、diff、恢复、删除可回滚", () => {
    createCanvas(workspace, { title: "版本画布", slug: "version-canvas", template: "blank" });
    const v1 = listCanvasVersions(workspace, "version-canvas").items;
    assert.equal(v1.length, 1);
    assert.equal(v1[0].n, 1);
    assert.ok(v1[0].changes.length >= 2, "新建版本应包含 canvas.json 与首块板");

    const first = createBoard(workspace, "version-canvas", { title: "A", actor: "agent", runId: "run_same" });
    const second = createBoard(workspace, "version-canvas", { title: "B", actor: "agent", runId: "run_same" });
    const merged = listCanvasVersions(workspace, "version-canvas").items;
    const agentVersions = merged.filter((item) => item.by === "agent");
    assert.equal(agentVersions.length, 1, "同一 runId 的连续写板应合并为一条版本");
    assert.equal(agentVersions[0].n, 2);
    assert.ok(agentVersions[0].changes.some((item) => item.path === first.boardPath));

    const beforeDelete = listCanvasVersions(workspace, "version-canvas").items[0].n;
    deleteBoard(workspace, "version-canvas", second.boardPath, { confirmed: true, actor: "ui" });
    const afterDelete = listCanvasVersions(workspace, "version-canvas").items[0];
    assert.equal(afterDelete.by, "human");
    assert.ok(afterDelete.changes.some((item) => item.path === second.boardPath && item.status === "deleted"), "删除板必须进入版本 changes(null)");

    const restored = restoreCanvasVersion(workspace, "version-canvas", { version: beforeDelete, actor: "ui" });
    assert.ok(restored.restored.includes(second.boardPath));
    assert.ok(readCanvas(workspace, "version-canvas").boards.some((item) => item.path === second.boardPath), "恢复版本应把删除的板带回来");
    const latest = listCanvasVersions(workspace, "version-canvas").items[0];
    assert.equal(latest.restoredFrom, beforeDelete);

    const version = readCanvasVersion(workspace, "version-canvas", beforeDelete);
    assert.ok(version.files >= 3);
    const diff = diffCanvasVersions(workspace, "version-canvas", { from: 1, to: null });
    assert.ok(diff.added.includes(first.boardPath));
    expectCode(() => restoreCanvasVersion(workspace, "version-canvas", { version: 999 }), "CANVAS_VERSION_NOT_FOUND");
  });

  // ---------- 工作区校验 ----------
  console.log("▶ 工作区与边界");

  check("非法工作区 → CANVAS_WORKSPACE_INVALID", () => {
    expectCode(() => listCanvases(path.join(tmpRoot, "no-such-workspace")), "CANVAS_WORKSPACE_INVALID");
    expectCode(() => createCanvas("", { title: "x" }), "CANVAS_WORKSPACE_INVALID");
  });

  check("listCanvases 在 designs 缺失时返回空列表", () => {
    const empty = fs.mkdtempSync(path.join(tmpRoot, "empty-"));
    assert.deepEqual(listCanvases(empty).canvases, []);
  });
} finally {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
}

if (process.exitCode) {
  console.error(`创作画布模型回归：存在失败用例（通过 ${passed.length} 项）`);
} else {
  console.log(`创作画布模型回归：通过（${passed.length} 项）`);
}
