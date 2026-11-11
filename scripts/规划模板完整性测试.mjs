/**
 * 规划模板库完整性测试（test:template-integrity）
 *
 * 防回归目标（2026-11-11 模板库整理）：
 *   1. templates/traffic-material 的 13 份写作模板 + 1 份素材库维护文档全部存在；
 *   2. 各模板一级/二级标题编号连续，无断档（03 曾出现 3.2 缺失、§5 整节缺失）；
 *   3. 已修复的关键内容不回退（03 总则八条、05 六级服务水平、09 现行标准、06 自检清单、12 定位声明）；
 *   4. agent 提示词与工作区模板的数量口径与磁盘实际一致，且不含过期数字；
 *   5. opendesign 库体积/数量口径正确，2026-11-11 移除的 24 个目录不再出现，且不再有无法预览的模板目录；
 *   6. tpl.mjs 的每个分类都有真实存在的模板（无空分类）。
 *
 * 运行：node scripts/规划模板完整性测试.mjs
 * 只读：不写任何文件，不启动服务。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getCategories, getTemplatesByCategory } from "../server/tpl.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MATERIAL = path.join(ROOT, "templates", "traffic-material");
const OPENDESIGN = path.join(ROOT, "templates", "opendesign");

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

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

function listDirs(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

/** 一级标题：阿拉伯（## 1.）或中文（## 一、），要求从 1 连续。 */
function checkTopLevelNumbering(label, content) {
  const headings = content.split(/\r?\n/).filter((line) => /^## /.test(line));
  const arabic = headings.map((line) => line.match(/^## (\d+)\./)).filter(Boolean).map((m) => Number(m[1]));
  const chineseMap = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };
  const chinese = headings.map((line) => line.match(/^## ([一二三四五六七八九十]+)、/)).filter(Boolean).map((m) => chineseMap[m[1]]);

  for (const [kind, nums] of [["阿拉伯", arabic], ["中文", chinese]]) {
    if (nums.length < 2) continue;
    nums.forEach((num, index) => {
      assert.equal(num, index + 1, `${label} 一级标题（${kind}）编号应从 1 连续，第 ${index + 1} 个为 ${num}`);
    });
  }
}

/** 二级标题：仅当某一级章节下的 ### 全部是 N.M 形式时，校验 M 从 1 连续。 */
function checkSubNumbering(label, content) {
  const lines = content.split(/\r?\n/);
  let current = label;
  let subs = [];
  const flush = () => {
    if (subs.length >= 2) {
      subs.forEach((num, index) => {
        assert.equal(num, index + 1, `${label} ${current} 下二级标题编号应连续，第 ${index + 1} 个为 ${num}`);
      });
    }
    subs = [];
  };
  for (const line of lines) {
    if (/^## /.test(line)) {
      flush();
      current = line.replace(/^## /, "").trim();
      continue;
    }
    const match = line.match(/^### (\d+)\.(\d+)/);
    if (match) subs.push(Number(match[2]));
  }
  flush();
}

// ---------- 1. traffic-material 清单 ----------
console.log("▶ traffic-material 清单与结构");

const EXPECTED = [
  "00_总览通用规范.md",
  "00_格式数据汇总.md",
  "01_年度工作报告模板.md",
  "02_五年发展规划模板.md",
  "03_规划文本条文式模板.md",
  "04_工程可行性研究报告模板.md",
  "05_线位论证预可模板.md",
  "06_选址和用地预审论证模板.md",
  "07_交通影响评价模板.md",
  "08_汇报材料模板.md",
  "09_物流园区规划模板.md",
  "10_规划研究报告模板.md",
  "11_PPT汇报模板.md",
  "12_素材库深挖.md",
];

check("14 份文件全部存在（13 份写作模板 + 1 份维护文档）", () => {
  const actual = fs.readdirSync(MATERIAL).filter((name) => name.endsWith(".md")).sort();
  assert.deepEqual(actual.sort(), EXPECTED.slice().sort());
});

for (const name of EXPECTED) {
  check(`${name} 标题编号连续`, () => {
    const content = fs.readFileSync(path.join(MATERIAL, name), "utf8");
    checkTopLevelNumbering(name, content);
    checkSubNumbering(name, content);
  });
}

// ---------- 2. 已修复内容不回退 ----------
console.log("▶ 修复内容防回退");

check("03 总则八条与 §4/§5 结构完整（无残句、无整节缺失）", () => {
  const content = read("templates/traffic-material/03_规划文本条文式模板.md");
  for (const n of ["第1条 规划目的", "第2条 规划依据", "第3条 规划范围", "第4条 规划年限", "第5条 规划对象", "第6条 规划原则", "第7条 文本效力", "第8条 解释与修订"]) {
    assert.ok(content.includes(`#### ${n}`), `03 缺少总则「${n}」`);
  }
  assert.ok(content.includes("## 5. 文本与说明书分离模板"), "03 缺少 §5 文本与说明书分离模板");
  assert.ok(!content.includes("## 6. 文本与说明书分离模板"), "03 仍存在旧 §6 缺号版本");
  assert.ok(content.includes("#### 第3条 交通趋势"), "03 第二章前三条不完整");
});

check("05 服务水平为六级框架、车道数判定无自相矛盾", () => {
  const content = read("templates/traffic-material/05_线位论证预可模板.md");
  assert.ok(!content.includes("公路服务水平分四级"), "05 仍残留四级服务水平旧框架");
  assert.ok(content.includes("分为**六级**"), "05 未声明六级服务水平");
  assert.ok(!content.includes("远景年交通量超过 20000 pcu/d 应选六车道"), "05 仍残留『超过 20000 应选六车道』的硬性表述");
});

check("09 引用现行标准（GB 50072-2021、GB 55037-2022）", () => {
  const content = read("templates/traffic-material/09_物流园区规划模板.md");
  assert.ok(!content.includes("GB 50072-2010"), "09 仍引用 GB 50072-2010");
  assert.ok(content.includes("GB 50072-2021"), "09 未更新为 GB 50072-2021");
  assert.ok(content.includes("GB 55037-2022"), "09 未补注 GB 55037-2022");
  assert.ok(!content.includes("GB/T 21334-2017"), "09 仍写死未经核实的 GB/T 21334-2017");
});

check("06 无遗留整改注记且含报批前校核", () => {
  const content = read("templates/traffic-material/06_选址和用地预审论证模板.md");
  assert.ok(!content.includes("待与 5.2/5.3 必备清单合并"), "06 仍残留编辑期注记");
  assert.ok(content.includes("## 八、报批前校核"), "06 缺少报批前校核清单");
});

check("12 已声明为非写作模板", () => {
  const content = read("templates/traffic-material/12_素材库深挖.md");
  assert.ok(content.includes("不是写作模板"), "12 缺少定位声明");
  assert.ok(!content.includes("第十一套模板"), "12 仍残留『第十一套模板』旧说法");
});

// ---------- 3. 提示词数量口径 ----------
console.log("▶ 提示词口径");

check("agent.mjs 数量口径与磁盘一致（13 份写作模板 / 90 目录 / 87 可预览 / 47 款）", () => {
  const content = read("server/agent.mjs");
  assert.ok(content.includes("13 份交通规划写作模板"), "agent.mjs 未声明 13 份写作模板");
  assert.ok(content.includes("90 个模板目录"), "agent.mjs 未声明 90 个模板目录");
  assert.ok(content.includes("87 个含 example.html"), "agent.mjs 未声明 87 个可预览模板");
  assert.ok(content.includes("47 款"), "agent.mjs 未声明 47 款 html-ppt-*");
  assert.ok(!content.includes("157 个 HTML 模板"), "agent.mjs 仍残留过期数字 157");
  assert.ok(!content.includes("14 份交通规划详版模板"), "agent.mjs 仍残留 14 份旧口径");
});

check("工作区初始化提示词口径一致", () => {
  const content = read("server/工作区初始化.mjs");
  assert.ok(content.includes("13 份写作模板"), "工作区初始化未声明 13 份写作模板");
  assert.ok(!content.includes("（14 类）"), "工作区初始化仍残留「14 类」");
  assert.ok(!content.includes("共 14 类"), "工作区初始化仍残留「共 14 类」");
});

// ---------- 4. opendesign 库 ----------
console.log("▶ opendesign 库");

const REMOVED = [
  "open-design-landing",
  "dcf-valuation",
  "hyperframes",
  "last30days",
  "replit-deck",
  "x-research",
  "audio-jingle",
  "video-shortform",
  "sprite-animation",
  "webgl-experience",
  "dating-web",
  "clinical-case-report",
  "email-marketing",
  "invoice",
  "contact-widget",
  "gamified-app",
  "orbit-gmail",
  "orbit-notion",
  "orbit-linear",
  "waitlist-page",
  "tweaks",
  "github-dashboard",
  "social-media-matrix-tracker-template",
  "trading-analysis-dashboard-template",
];

check("已移除的 24 个目录不再出现", () => {
  const dirs = listDirs(OPENDESIGN);
  for (const name of REMOVED) {
    assert.ok(!dirs.includes(name), `已确认移除的目录仍存在：${name}`);
  }
});

check("目录数量 90 / example.html 87 / html-ppt-* 47", () => {
  const dirs = listDirs(OPENDESIGN);
  assert.equal(dirs.length, 90, `模板目录应为 90，实际 ${dirs.length}`);
  const previewable = dirs.filter((name) => fs.existsSync(path.join(OPENDESIGN, name, "example.html")));
  assert.equal(previewable.length, 87, `含 example.html 的目录应为 87，实际 ${previewable.length}`);
  const ppt = dirs.filter((name) => /^html-ppt-/.test(name));
  assert.equal(ppt.length, 47, `html-ppt-* 目录应为 47，实际 ${ppt.length}`);
});

check("无预览目录仅限已知 3 个（html-ppt/guizang-ppt 集合 + live-artifact）", () => {
  const dirs = listDirs(OPENDESIGN);
  const known = new Set(["html-ppt", "guizang-ppt", "live-artifact"]);
  const noExample = dirs.filter((name) => !fs.existsSync(path.join(OPENDESIGN, name, "example.html")));
  assert.deepEqual(
    noExample.slice().sort(),
    [...known].sort(),
    `无 example.html 的目录与已知清单不符：${noExample.join(", ")}`,
  );
});

check("opendesign 目录说明已替换为本项目口径", () => {
  const content = fs.readFileSync(path.join(OPENDESIGN, "AGENTS.md"), "utf8");
  assert.ok(content.includes("本项目口径"), "AGENTS.md 未替换为本项目口径");
  assert.ok(!content.includes("/api/design-templates"), "AGENTS.md 仍残留上游注册表描述");
});

// ---------- 5. tpl.mjs 无空分类 ----------
console.log("▶ 模板库分类");

check("每个分类都有真实模板（无空分类）", () => {
  const categories = getCategories();
  assert.deepEqual(categories.map((item) => item.id), ["htmlppt", "sucaiku"], `分类应为 htmlppt/sucaiku，实际 ${categories.map((item) => item.id).join("/")}`);
  for (const category of categories) {
    const items = getTemplatesByCategory(category.id);
    assert.ok(items.length > 0, `分类「${category.name}」没有任何模板`);
  }
});

check("规划素材库分类收录 14 份 markdown", () => {
  const items = getTemplatesByCategory("sucaiku");
  assert.equal(items.length, 14, `规划素材库应 14 条，实际 ${items.length}`);
});

console.log(`\n通过 ${passed.length} 项`);
