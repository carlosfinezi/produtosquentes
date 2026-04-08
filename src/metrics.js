const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function getProductMetrics(productId) {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) return null;

  // Latest snapshot
  const latestSnapshot = await prisma.productSnapshot.findFirst({
    where: { productId },
    orderBy: { collectedDate: 'desc' }
  });

  // Price stats
  const priceStats = await prisma.productSnapshot.aggregate({
    where: { productId },
    _min: { price: true },
    _max: { price: true, discountPercent: true }
  });

  // 30-day averages
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const monthlyAgg = await prisma.productSnapshot.aggregate({
    where: {
      productId,
      collectedDate: { gte: thirtyDaysAgo },
      dailySales: { not: null }
    },
    _sum: { dailySales: true, dailyRevenue: true },
    _avg: { dailySales: true, dailyRevenue: true },
    _count: true
  });

  // Weekly (last 7 days)
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const weeklyAgg = await prisma.productSnapshot.aggregate({
    where: {
      productId,
      collectedDate: { gte: sevenDaysAgo },
      dailySales: { not: null }
    },
    _sum: { dailySales: true, dailyRevenue: true }
  });

  // 90-day history for charts
  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

  const history = await prisma.productSnapshot.findMany({
    where: {
      productId,
      collectedDate: { gte: ninetyDaysAgo }
    },
    orderBy: { collectedDate: 'asc' },
    select: {
      collectedDate: true,
      price: true,
      dailySales: true,
      dailyRevenue: true,
      soldQuantity: true
    }
  });

  const daysActive = Math.floor(
    (Date.now() - new Date(product.createdAt).getTime()) / (1000 * 60 * 60 * 24)
  );

  return {
    product,
    currentPrice: latestSnapshot?.price || 0,
    minPriceEver: priceStats._min.price || 0,
    maxPriceEver: priceStats._max.price || 0,
    maxDiscountEver: priceStats._max.discountPercent || 0,

    totalSales: latestSnapshot?.soldQuantity || 0,
    dailySalesAvg: Math.round(monthlyAgg._avg.dailySales || 0),
    weeklySalesAvg: Math.round((weeklyAgg._sum.dailySales || 0)),
    monthlySalesAvg: Math.round(monthlyAgg._sum.dailySales || 0),

    dailyRevenueAvg: Math.round(monthlyAgg._avg.dailyRevenue || 0),
    weeklyRevenueAvg: Math.round((weeklyAgg._sum.dailyRevenue || 0)),
    monthlyRevenueAvg: Math.round(monthlyAgg._sum.dailyRevenue || 0),

    daysActive,
    firstSeenDate: product.createdAt.toISOString().split('T')[0],

    priceHistory: history.map(h => ({
      date: h.collectedDate.toISOString().split('T')[0],
      price: h.price
    })),
    salesHistory: history.map(h => ({
      date: h.collectedDate.toISOString().split('T')[0],
      sales: h.dailySales,
      revenue: h.dailyRevenue,
      totalSales: h.soldQuantity
    }))
  };
}

async function getSearchMetrics(query, filters = {}) {
  const where = {};
  const snapshotWhere = {};

  if (query) {
    const terms = query.split(/\s+/).filter(Boolean);
    where.AND = terms.map(t => ({ title: { contains: t, mode: 'insensitive' } }));
  }
  if (filters.category) {
    where.categoryId = filters.category;
  }

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  // Get products matching query
  const products = await prisma.product.findMany({
    where,
    include: {
      snapshots: {
        where: { collectedDate: { gte: thirtyDaysAgo } },
        orderBy: { collectedDate: 'desc' }
      }
    }
  });

  const totalProducts = products.length;
  let totalSales = 0;
  let totalRevenue = 0;
  let priceSum = 0;
  let minPrice = Infinity;
  let maxPrice = 0;
  let freeShippingCount = 0;
  let discountedCount = 0;

  const categoryMap = new Map();
  const productMetrics = [];

  for (const product of products) {
    const latestSnapshot = product.snapshots[0];
    if (!latestSnapshot) continue;

    const price = latestSnapshot.price;
    priceSum += price;
    if (price < minPrice) minPrice = price;
    if (price > maxPrice) maxPrice = price;
    if (product.freeShipping) freeShippingCount++;
    if (latestSnapshot.discountPercent > 0) discountedCount++;

    const monthlySales = product.snapshots.reduce((sum, s) => sum + (s.dailySales || 0), 0);
    const monthlyRevenue = product.snapshots.reduce((sum, s) => sum + (s.dailyRevenue || 0), 0);

    totalSales += monthlySales;
    totalRevenue += monthlyRevenue;

    // Category grouping
    const catName = product.categoryName || 'Sem categoria';
    if (!categoryMap.has(catName)) {
      categoryMap.set(catName, { name: catName, products: 0, revenue: 0, sales: 0 });
    }
    const cat = categoryMap.get(catName);
    cat.products++;
    cat.revenue += monthlyRevenue;
    cat.sales += monthlySales;

    productMetrics.push({
      id: product.id,
      title: product.title,
      thumbnail: product.thumbnail,
      categoryName: product.categoryName,
      freeShipping: product.freeShipping,
      price,
      monthlySales,
      monthlyRevenue,
      soldQuantity: latestSnapshot.soldQuantity
    });
  }

  // Sort for tops
  const topBySales = [...productMetrics].sort((a, b) => b.monthlySales - a.monthlySales).slice(0, 20);
  const topByRevenue = [...productMetrics].sort((a, b) => b.monthlyRevenue - a.monthlyRevenue).slice(0, 20);
  const cheapest = [...productMetrics].sort((a, b) => a.price - b.price).slice(0, 20);

  const byCategory = [...categoryMap.values()].sort((a, b) => b.revenue - a.revenue);

  return {
    totalProducts,
    avgPrice: totalProducts > 0 ? Math.round((priceSum / totalProducts) * 100) / 100 : 0,
    minPrice: minPrice === Infinity ? 0 : minPrice,
    maxPrice,
    totalSales,
    totalRevenue: Math.round(totalRevenue),
    avgMonthlySales: totalProducts > 0 ? Math.round(totalSales / totalProducts) : 0,
    freeShippingCount,
    discountedCount,
    byCategory,
    topBySales,
    topByRevenue,
    cheapest
  };
}

module.exports = { getProductMetrics, getSearchMetrics };
