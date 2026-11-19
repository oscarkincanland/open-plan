/**
 * 知识库路由分组（L3 路由模块）。
 *
 * 由 server/index.mjs 在鉴权中间件之后、`/api` 404 兜底之前调用注册；
 * 依赖通过参数注入（kb），禁止反向 import index.mjs。
 * 迁移自 index.mjs 的「知识库（本地索引 + IMA 云端）」与「文档 ↔ 知识库联动」两段，
 * 行为、响应结构与错误映射逐字保留。
 */
export function registerKbRoutes(app, { kb }) {
  app.get("/api/kb/status", async (_req, res) => {
    await kb.scan();
    res.json(kb.status());
  });

  app.post("/api/kb/roots", async (req, res) => {
    const r = kb.addRoot(req.body?.path);
    if (!r.ok) return res.status(400).json(r);
    await kb.scan(true);
    res.json({ ok: true, roots: r.roots, fileCount: kb.status().fileCount });
  });

  app.delete("/api/kb/roots", async (req, res) => {
    const r = kb.removeRoot(req.body?.path);
    await kb.scan(true);
    res.json(r);
  });

  app.get("/api/kb/tree", async (req, res) => {
    await kb.scan();
    const rootIdx = parseInt(req.query.root, 10);
    const dir = req.query.dir || "";
    res.json(kb.getTreeLevel(isNaN(rootIdx) ? 0 : rootIdx, dir));
  });

  app.get("/api/kb/search", async (req, res) => {
    await kb.scan();
    const rootIdx = parseInt(req.query.root, 10);
    res.json({
      results: kb.search(req.query.q || "", isNaN(rootIdx) ? null : rootIdx, parseInt(req.query.limit, 10) || 30),
    });
  });

  app.get("/api/kb/graph", async (req, res) => {
    await kb.scan();
    const rootIdx = parseInt(req.query.root, 10);
    const include = (req.query.include || "links").split(",").filter(Boolean);
    res.json(kb.getGraph({ rootIdx: isNaN(rootIdx) ? null : rootIdx, include, maxNodes: parseInt(req.query.max, 10) || 800 }));
  });

  app.get("/api/kb/doc", async (req, res) => {
    await kb.scan();
    const rootIdx = parseInt(req.query.root, 10);
    const doc = kb.getDoc(req.query.path || "", isNaN(rootIdx) ? null : rootIdx);
    if (!doc) return res.status(404).json({ error: "not found" });
    res.json(doc);
  });

  // IMA 云端知识库（凭证未配置时返回 configured:false）
  app.get("/api/kb/ima/status", async (_req, res) => res.json(await kb.imaStatus()));
  app.get("/api/kb/ima/bases", async (_req, res) => res.json(await kb.imaListBases()));
  app.get("/api/kb/ima/search", async (req, res) => res.json(await kb.imaSearch(req.query.q || "", req.query.kb || "")));
  app.get("/api/kb/ima/doc", async (req, res) => res.json(await kb.imaDoc(req.query.media_id || "")));

  // ---------- 文档 ↔ 知识库联动 ----------
  // docx → md 入知识库（工作区注册为 kb 根）
  app.post("/api/kb/ingest", async (req, res) => {
    try {
      const r = await kb.ingestDocx(req.body?.name);
      if (!r.ok) return res.status(400).json(r);
      res.json(r);
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // kb 文档 → docx 写工作区
  app.post("/api/kb/export-docx", async (req, res) => {
    try {
      const rootIdx = parseInt(req.body?.rootIdx, 10);
      const r = await kb.exportDocx(req.body?.relPath, isNaN(rootIdx) ? null : rootIdx);
      if (!r.ok) return res.status(400).json(r);
      res.json(r);
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });
}
