# OpenDesign 模板目录（本项目口径）

> 2026-11-11 整理后替换上游残留文档（原文描述上游的 design-templates 注册表与 `od.mode`，
> 本项目不存在该机制）。整理依据：[模板库审查报告](../../docs/audits/2026-11-10-模板库审查/审查报告.md)、
> [整理方案](../../docs/plans/2026-11-10-008-模板库整理方案.md)。

## 这个目录在本项目里是什么

1. **模板库页面**（模板库「HTML PPT（OpenDesign）」分类）的数据源：`server/tpl.mjs` 扫描本目录，
   只收录每个模板目录下的 `example.html` 作为预览入口（深度 ≤5，跳过 assets/themes/animations/fonts/scripts/docs/references/examples）。
2. **Agent 的 HTML 风格参考库**：写 PPT/演示/海报/网页类产物时，agent 用 read 读取
   `templates/opendesign/<模板名>/example.html` 照其风格与结构生成，产物写入当前工作区。

## 保留范围（整理后）

- **核心**：`html-ppt-*` 演示风格 47 款（32 款 zhangzara + 15 款专题）+ `html-ppt`、`guizang-ppt` 两个集合
  ——对应"PPT 与 HTML 汇报材料"目标，是 agent 提示词点名的参考来源。
- **通用汇报周边**：dashboard / docs-page / meeting-notes / magazine-poster / wireframe / web-prototype 等。
- 2026-11-11 已移除 24 个与交通规划无关或无法预览的目录（open-design-landing 22.4MB、
  dating-web、clinical-case-report、audio-jingle、invoice、orbit-gmail 等），目录体积 28.4MB → 5.2MB。
  删除记录见 git 历史与整理方案 F 组清单。

## 新增模板约定

1. 每个模板一个目录，**必须**提供 `example.html`（唯一预览入口），否则模板库不展示。
2. 示例页的样式/脚本/字体放在目录内（`assets/` 等），保持自包含、可离线打开；单模板目录建议 ≤5MB。
3. 上游自带的 `SKILL.md` 可保留作文档，但本项目不加载 `od.mode`、不注册到任何技能注册表。
4. deck 类模板请自带翻页逻辑（键盘/滚轮/触摸），不要依赖宿主页面补导航。

## 不要做的事

- 不要把本目录当成 `.claude/skills/` 的替代：需要"执行能力"的放技能，纯"版式参考"的放这里。
- 不要放入含用户数据、真实项目截图或受版权限制的素材。
