const axios = require('axios');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const ML_API = process.env.ML_API_BASE || 'https://api.mercadolibre.com';
const SITE_ID = process.env.ML_SITE_ID || 'MLB';
const TIMEOUT = 15000;

// In-memory cache for category names
const categoryCache = new Map();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function getYesterday() {
  const today = getToday();
  today.setDate(today.getDate() - 1);
  return today;
}

async function fetchWithRetry(url, params = {}) {
  try {
    const { data } = await axios.get(url, { params, timeout: TIMEOUT });
    return data;
  } catch (err) {
    if (err.response?.status === 429) {
      console.log('[COLLECTOR] Rate limited (429). Waiting 60s...');
      await sleep(60000);
      const { data } = await axios.get(url, { params, timeout: TIMEOUT });
      return data;
    }
    throw err;
  }
}

async function getCategoryInfo(categoryId) {
  if (!categoryId) return { name: null, path: null };
  if (categoryCache.has(categoryId)) return categoryCache.get(categoryId);

  try {
    const data = await fetchWithRetry(`${ML_API}/categories/${categoryId}`);
    const info = {
      name: data.name || null,
      path: data.path_from_root
        ? data.path_from_root.map(c => c.name).join(' > ')
        : null
    };
    categoryCache.set(categoryId, info);
    return info;
  } catch {
    const fallback = { name: null, path: null };
    categoryCache.set(categoryId, fallback);
    return fallback;
  }
}

async function collectSearch(term, category, maxResults = 200) {
  const startTime = Date.now();
  const today = getToday();
  const yesterday = getYesterday();
  let productsFound = 0;
  let snapshotsSaved = 0;
  let errors = 0;

  console.log(`[COLLECTOR] Starting collection for "${term}" (max: ${maxResults})`);

  try {
    // 1. Fetch products from ML API with pagination
    const allItems = [];
    let offset = 0;
    const limit = 50;

    while (allItems.length < maxResults) {
      const params = { q: term, limit, offset };
      if (category) params.category = category;

      const data = await fetchWithRetry(`${ML_API}/sites/${SITE_ID}/search`, params);
      const items = data.results || [];

      if (items.length === 0) break;
      allItems.push(...items);
      offset += limit;

      if (offset >= (data.paging?.total || 0)) break;

      await sleep(1000); // Rate limiting: 1 req/s
    }

    const itemsToProcess = allItems.slice(0, maxResults);
    productsFound = itemsToProcess.length;
    console.log(`[COLLECTOR] Found ${productsFound} products for "${term}"`);

    // 2. Process each product
    for (const item of itemsToProcess) {
      try {
        const catInfo = await getCategoryInfo(item.category_id);

        // Upsert product
        await prisma.product.upsert({
          where: { id: item.id },
          create: {
            id: item.id,
            title: item.title,
            permalink: item.permalink || null,
            thumbnail: item.thumbnail || null,
            categoryId: item.category_id || null,
            categoryName: catInfo.name,
            categoryPath: catInfo.path,
            sellerId: item.seller?.id?.toString() || null,
            sellerNickname: item.seller?.nickname || null,
            condition: item.condition || null,
            listingType: item.listing_type_id || null,
            catalogProductId: item.catalog_product_id || null,
            freeShipping: item.shipping?.free_shipping || false
          },
          update: {
            title: item.title,
            permalink: item.permalink || null,
            thumbnail: item.thumbnail || null,
            categoryId: item.category_id || null,
            categoryName: catInfo.name,
            categoryPath: catInfo.path,
            sellerId: item.seller?.id?.toString() || null,
            sellerNickname: item.seller?.nickname || null,
            condition: item.condition || null,
            listingType: item.listing_type_id || null,
            catalogProductId: item.catalog_product_id || null,
            freeShipping: item.shipping?.free_shipping || false
          }
        });

        // Get yesterday's snapshot for delta calculation
        const yesterdaySnapshot = await prisma.productSnapshot.findUnique({
          where: {
            productId_collectedDate: {
              productId: item.id,
              collectedDate: yesterday
            }
          }
        });

        const soldQuantity = item.sold_quantity || 0;
        const price = item.price || 0;
        const originalPrice = item.original_price || null;

        let dailySales = null;
        let dailyRevenue = null;
        if (yesterdaySnapshot) {
          const delta = soldQuantity - yesterdaySnapshot.soldQuantity;
          dailySales = delta > 0 ? delta : 0;
          dailyRevenue = dailySales * price;
        }

        const discountPercent = originalPrice && originalPrice > price
          ? ((originalPrice - price) / originalPrice) * 100
          : 0;

        // Upsert snapshot (one per product per day)
        await prisma.productSnapshot.upsert({
          where: {
            productId_collectedDate: {
              productId: item.id,
              collectedDate: today
            }
          },
          create: {
            productId: item.id,
            price,
            originalPrice,
            soldQuantity,
            availableQuantity: item.available_quantity ?? null,
            reviewsCount: item.reviews?.total || null,
            reviewsRating: item.reviews?.rating_average || null,
            dailySales,
            dailyRevenue,
            discountPercent,
            collectedDate: today
          },
          update: {
            price,
            originalPrice,
            soldQuantity,
            availableQuantity: item.available_quantity ?? null,
            reviewsCount: item.reviews?.total || null,
            reviewsRating: item.reviews?.rating_average || null,
            dailySales,
            dailyRevenue,
            discountPercent
          }
        });

        snapshotsSaved++;
      } catch (err) {
        errors++;
        console.error(`[COLLECTOR] Error processing ${item.id}:`, err.message);
      }
    }

    // 3. Log collection result
    const durationMs = Date.now() - startTime;
    const status = errors === 0 ? 'success' : errors < productsFound ? 'partial' : 'error';

    await prisma.collectionLog.create({
      data: {
        searchTerm: term,
        productsFound,
        snapshotsSaved,
        errors,
        durationMs,
        status
      }
    });

    console.log(`[COLLECTOR] Done "${term}": ${snapshotsSaved} saved, ${errors} errors, ${durationMs}ms`);
    return { productsFound, snapshotsSaved, errors, durationMs, status };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    await prisma.collectionLog.create({
      data: {
        searchTerm: term,
        productsFound,
        snapshotsSaved,
        errors: errors + 1,
        durationMs,
        status: 'error',
        errorMessage: err.message
      }
    });
    console.error(`[COLLECTOR] Fatal error for "${term}":`, err.message);
    throw err;
  }
}

module.exports = { collectSearch };
