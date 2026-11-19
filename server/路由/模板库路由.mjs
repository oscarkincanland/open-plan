/**
 * 模板库路由分组（L3 路由模块）。
 *
 * 由 server/index.mjs 在鉴权中间件之后、`/api` 404 兜底之前调用注册；
 * 依赖通过参数注入（tpl），禁止反向 import index.mjs。
 * 迁移自 index.mjs 的「模版库」段，行为、响应结构与错误映射逐字保留；
 * generate-notice 的动态导入路径按新目录调整为 `../notice.mjs`。
 */
export function registerTplRoutes(app, { tpl }) {
  app.get("/api/templates", (req, res) => {
    const cat = req.query.category;
    const cats = tpl.getCategories();
    const items = tpl.getTemplatesByCategory(cat);
    res.json({ categories: cats, items, total: items.length });
  });

  app.get("/api/templates/content", (req, res) => {
    const relPath = req.query.path || "";
    if (!relPath) return res.status(400).json({ error: "path required" });
    const c = tpl.getTemplateContent(relPath);
    if (!c) return res.status(404).json({ error: "not found" });
    res.json(c);
  });

  app.post("/api/templates/refresh", (_req, res) => {
    tpl.refresh();
    res.json({ ok: true, total: tpl.getTemplates().length });
  });

  // 红头会议通知生成（docx 库生成 → 写工作区）
  app.post("/api/templates/generate-notice", async (req, res) => {
    try {
      const { generateNotice } = await import("../notice.mjs");
      const r = await generateNotice(req.body || {});
      res.json({ ok: true, name: r.name });
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });
}
