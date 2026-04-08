require('dotenv').config();
const express = require('express');
const path = require('path');
const cron = require('node-cron');
const { PrismaClient } = require('@prisma/client');
const { collectSearch } = require('./collector');
const apiRoutes = require('./routes/api');
const proxyRoutes = require('./routes/proxy');

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// API routes
app.use('/api', apiRoutes);
app.use('/api/ml', proxyRoutes);

// Cron: daily collection at 06:00 São Paulo time
const hour = process.env.COLLECT_HOUR || '6';
const minute = process.env.COLLECT_MINUTE || '0';
const timezone = process.env.COLLECT_TIMEZONE || 'America/Sao_Paulo';

cron.schedule(`${minute} ${hour} * * *`, async () => {
  console.log(`[CRON] Starting daily collection at ${new Date().toISOString()}`);
  try {
    const searches = await prisma.search.findMany({ where: { isActive: true } });
    for (const search of searches) {
      try {
        await collectSearch(search.term, search.category, search.maxResults);
        await prisma.search.update({
          where: { id: search.id },
          data: { lastRunAt: new Date() }
        });
        console.log(`[CRON] Completed collection for "${search.term}"`);
      } catch (err) {
        console.error(`[CRON] Error collecting "${search.term}":`, err.message);
      }
    }
  } catch (err) {
    console.error('[CRON] Error fetching searches:', err.message);
  }
}, { timezone });

// Cleanup: delete snapshots older than 90 days (runs daily at 05:00)
cron.schedule(`0 5 * * *`, async () => {
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);
    const result = await prisma.productSnapshot.deleteMany({
      where: { collectedDate: { lt: cutoff } }
    });
    console.log(`[CLEANUP] Deleted ${result.count} snapshots older than 90 days`);
  } catch (err) {
    console.error('[CLEANUP] Error:', err.message);
  }
}, { timezone });

app.listen(PORT, () => {
  console.log(`PulseDados ML running on http://localhost:${PORT}`);
});
