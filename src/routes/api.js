const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { collectSearch } = require('../collector');
const { getProductMetrics, getSearchMetrics } = require('../metrics');

const router = express.Router();
const prisma = new PrismaClient();

// ---------- Products ----------

// GET /api/products?q=termo&category=X&sort=revenue&order=desc&page=1&limit=50
router.get('/products', async (req, res) => {
  try {
    const { q, category, sort = 'updatedAt', order = 'desc', page = 1, limit = 50 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const where = {};
    if (q) {
      const terms = q.split(/\s+/).filter(Boolean);
      where.AND = terms.map(t => ({ title: { contains: t, mode: 'insensitive' } }));
    }
    if (category) where.categoryId = category;

    // For sorting by sales/revenue, we need to include snapshots
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const products = await prisma.product.findMany({
      where,
      include: {
        snapshots: {
          where: { collectedDate: { gte: thirtyDaysAgo } },
          orderBy: { collectedDate: 'desc' }
        }
      }
    });

    // Calculate metrics for sorting and response
    const enriched = products.map(p => {
      const latest = p.snapshots[0];
      const monthlySales = p.snapshots.reduce((sum, s) => sum + (s.dailySales || 0), 0);
      const monthlyRevenue = p.snapshots.reduce((sum, s) => sum + (s.dailyRevenue || 0), 0);
      return {
        id: p.id,
        title: p.title,
        permalink: p.permalink,
        thumbnail: p.thumbnail,
        categoryId: p.categoryId,
        categoryName: p.categoryName,
        sellerNickname: p.sellerNickname,
        condition: p.condition,
        freeShipping: p.freeShipping,
        price: latest?.price || 0,
        originalPrice: latest?.originalPrice || null,
        soldQuantity: latest?.soldQuantity || 0,
        monthlySales,
        monthlyRevenue,
        discountPercent: latest?.discountPercent || 0,
        updatedAt: p.updatedAt
      };
    });

    // Sort
    const sortKey = sort === 'revenue' ? 'monthlyRevenue'
      : sort === 'sales' ? 'monthlySales'
      : sort === 'price' ? 'price'
      : 'monthlySales';
    const dir = order === 'asc' ? 1 : -1;
    enriched.sort((a, b) => (a[sortKey] - b[sortKey]) * dir);

    const total = enriched.length;
    const paginated = enriched.slice(skip, skip + take);

    res.json({ products: paginated, total, page: parseInt(page), limit: take });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/products/:id
router.get('/products/:id', async (req, res) => {
  try {
    const metrics = await getProductMetrics(req.params.id);
    if (!metrics) return res.status(404).json({ error: 'Product not found' });
    res.json(metrics);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/products/:id/history?days=90
router.get('/products/:id/history', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 90;
    const since = new Date();
    since.setDate(since.getDate() - days);

    const history = await prisma.productSnapshot.findMany({
      where: {
        productId: req.params.id,
        collectedDate: { gte: since }
      },
      orderBy: { collectedDate: 'asc' },
      select: {
        collectedDate: true,
        price: true,
        originalPrice: true,
        dailySales: true,
        dailyRevenue: true,
        soldQuantity: true,
        discountPercent: true
      }
    });

    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Metrics ----------

// GET /api/metrics?q=termo&category=X
router.get('/metrics', async (req, res) => {
  try {
    const { q, category } = req.query;
    const metrics = await getSearchMetrics(q, { category });
    res.json(metrics);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Collection ----------

// POST /api/collect { term, category?, maxResults? }
router.post('/collect', async (req, res) => {
  try {
    const { term, category, maxResults = 200 } = req.body;
    if (!term) return res.status(400).json({ error: 'term is required' });

    // Run collection async and respond immediately
    res.json({ message: `Collection started for "${term}"`, status: 'running' });

    collectSearch(term, category, maxResults).catch(err => {
      console.error(`[API] Collection error for "${term}":`, err.message);
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Searches ----------

// GET /api/searches
router.get('/searches', async (req, res) => {
  try {
    const searches = await prisma.search.findMany({ orderBy: { createdAt: 'desc' } });
    res.json(searches);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/searches { term, category?, maxResults? }
router.post('/searches', async (req, res) => {
  try {
    const { term, category, maxResults = 200 } = req.body;
    if (!term) return res.status(400).json({ error: 'term is required' });

    const cat = category || '';
    const search = await prisma.search.upsert({
      where: { term_category: { term, category: cat } },
      create: { term, category: cat, maxResults },
      update: { maxResults, isActive: true }
    });
    res.json(search);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/searches/:id
router.delete('/searches/:id', async (req, res) => {
  try {
    await prisma.search.delete({ where: { id: parseInt(req.params.id) } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Export ----------

// GET /api/export/csv?q=termo
router.get('/export/csv', async (req, res) => {
  try {
    const { q, category } = req.query;
    const where = {};
    if (q) {
      const terms = q.split(/\s+/).filter(Boolean);
      where.AND = terms.map(t => ({ title: { contains: t, mode: 'insensitive' } }));
    }
    if (category) where.categoryId = category;

    const products = await prisma.product.findMany({
      where,
      include: {
        snapshots: { orderBy: { collectedDate: 'desc' }, take: 1 }
      }
    });

    const header = 'ID,Title,Price,Original Price,Sold Quantity,Category,Seller,Free Shipping,Condition,Permalink\n';
    const rows = products.map(p => {
      const s = p.snapshots[0];
      const title = `"${(p.title || '').replace(/"/g, '""')}"`;
      return [
        p.id, title, s?.price || 0, s?.originalPrice || '',
        s?.soldQuantity || 0, `"${p.categoryName || ''}"`,
        `"${p.sellerNickname || ''}"`, p.freeShipping,
        p.condition || '', `"${p.permalink || ''}"`
      ].join(',');
    }).join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="pulsedados_export.csv"');
    res.send(header + rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/export/json?q=termo
router.get('/export/json', async (req, res) => {
  try {
    const { q, category } = req.query;
    const where = {};
    if (q) {
      const terms = q.split(/\s+/).filter(Boolean);
      where.AND = terms.map(t => ({ title: { contains: t, mode: 'insensitive' } }));
    }
    if (category) where.categoryId = category;

    const products = await prisma.product.findMany({
      where,
      include: {
        snapshots: { orderBy: { collectedDate: 'desc' }, take: 1 }
      }
    });

    res.setHeader('Content-Disposition', 'attachment; filename="pulsedados_export.json"');
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Admin / Status ----------

// GET /api/status
router.get('/status', async (req, res) => {
  try {
    const totalProducts = await prisma.product.count();
    const totalSnapshots = await prisma.productSnapshot.count();
    const totalSearches = await prisma.search.count({ where: { isActive: true } });

    const lastLog = await prisma.collectionLog.findFirst({
      orderBy: { createdAt: 'desc' }
    });

    res.json({
      totalProducts,
      totalSnapshots,
      activeSearches: totalSearches,
      lastCollection: lastLog ? {
        term: lastLog.searchTerm,
        status: lastLog.status,
        productsFound: lastLog.productsFound,
        at: lastLog.createdAt
      } : null,
      uptime: process.uptime()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/logs?limit=20
router.get('/logs', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const logs = await prisma.collectionLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit
    });
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
