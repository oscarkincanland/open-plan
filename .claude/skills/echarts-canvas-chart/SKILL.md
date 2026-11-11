---
name: echarts-canvas-chart
description: >-
  把 ECharts 图表渲染为静态矢量 SVG 并插入创作画布（svg 元素），随 PPTX/SVG/PNG/PDF 导出。
  内置交通规划常用模板（柱状对比/折线趋势/占比/堆叠/OD 桑基）。依赖 echarts，
  首次使用需在技能中心安装到工作区 .oaw/skill-deps/；未安装时改用内置浏览器截图 PNG 兜底。
requires:
  runtime: [{ kind: node, version: ">=18" }]
  npm: [echarts]
---

# ECharts 画布图表插入

把 ECharts option 渲染成**静态矢量 SVG**，落到创作画布素材目录并用 `canvas_write` 作为 svg 元素上板。
画布内是静态图（无交互/动画）；导出 PPTX 时该图表为**内嵌矢量图片**（清晰可缩放，但不能在 PPT 里改数据）。

## 何时用 / 不用

- ✅ 用户要在画布/画布 PPT 里放一张数据图表（柱状、折线、占比、堆叠、OD 桑基等静态成图）。
- ✅ 与 `baoyu-echarts` 技能互补：它负责"option 怎么写"（图表类型识别与配置），本技能负责"渲染并落到画布"。
- ❌ 画布上要交互/动画图表——画布对象模型不执行脚本，做不到。
- ❌ PPT 里要可编辑的图表对象（改数据/配色）——当前导出为图片，属后续方案二范围。

## 第 0 步：依赖准备

echarts 安装在 `<workspace>/.oaw/skill-deps/echarts-canvas-chart/`（技能中心安装，或手动）：

```bash
npm install echarts --prefix "<workspace>/.oaw/skill-deps/echarts-canvas-chart"
```

检测是否已装（退出码 0=已装）：

```bash
node -e "require(process.argv[1]+'/node_modules/echarts/package.json')" "<workspace>/.oaw/skill-deps/echarts-canvas-chart"
```

未安装时：提示用户在技能中心点安装；用户拒绝/离线时走兜底——
用**内置浏览器**打开含 ECharts 的本地 HTML（CDN 或脚本内联）渲染后截图 PNG，再把 PNG 作为 image 元素上板（位图，次选）。

## 第 1 步：写 option（JSON，不执行代码）

从 `templates/` 选一个起步改数据（只改数据与文案，不改结构）：

| 模板 | 适用 |
|---|---|
| `templates/bar-compare.json` | 分组柱状对比（区县/方案对比） |
| `templates/line-trend.json` | 多系列折线趋势 |
| `templates/pie-share.json` | 占比饼/环 |
| `templates/bar-stack.json` | 堆叠柱（时段分布等） |
| `templates/sankey-od.json` | OD 流向桑基 |

约定：`width/height` 与目标画板一致（默认 1280×720）；`fontFamily` 保持 `Microsoft YaHei`；
标题注明"（示例数据）"除非数据来自用户真实文件；option 必须是纯 JSON——禁止函数、JS 表达式。

## 第 2 步：渲染 SVG 到画布素材目录

```bash
node "<本技能目录>/scripts/render-chart.mjs" \
  --option "<option.json 路径>" \
  --out "<workspace>/designs/<slug>/project/assets/chart-<名>.svg" \
  --width 1280 --height 720 \
  --depsDir "<workspace>/.oaw/skill-deps/echarts-canvas-chart"
```

- 成功：写出 SVG 文件（脚本退出码 0）；退出码 2 = echarts 未安装（按第 0 步处理）。
- `--out` 必须落在目标画布的 `project/assets/` 下，文件名用 `chart-<语义名>.svg`。

## 第 3 步：canvas_write 上板

在目标板追加一个 svg 元素（`src` 相对**板所在目录**，故用 `../assets/…`）：

```json
{ "type": "svg", "src": "../assets/chart-<名>.svg", "x": 40, "y": 120, "w": 1280, "h": 720 }
```

- `w/h` 与渲染尺寸一致（等比缩放可按比例改，但不建议放大超过 1.5 倍）；
- 上板前先 `canvas_read` 该板确认版面位置，避免压住已有元素；
- 保存后前端会实时显示；用户可拖动/缩放该图表卡片。

## 第 4 步：交付说明（告知用户）

- 导出 PPTX：图表页为**矢量图片**，清晰但不可在 PPT 内改数据；
- 导出 SVG/PNG/PDF：同样支持；
- 若 option 数据是演示性质，图表标题已含"（示例数据）"，不得表述为真实调查数据。

## 排错

| 现象 | 处置 |
|---|---|
| 退出码 2 / `Cannot find module 'echarts'` | 依赖未装，回第 0 步 |
| SVG 里中文乱码/缺字 | 确认 option 的 textStyle.fontFamily 为系统已有字体（默认微软雅黑） |
| 画布上不显示 | 检查 `src` 是否 `../assets/…`（相对板目录）、文件确实在 assets 下、canvas.json rev 已提交 |
| option 含函数报错 | option 只能是 JSON；把 formatter 等改为静态文案 |
