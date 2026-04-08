const express = require('express');
const axios = require('axios');
const router = express.Router();

const ML_API = process.env.ML_API_BASE || 'https://api.mercadolibre.com';
const SITE_ID = process.env.ML_SITE_ID || 'MLB';
const TIMEOUT = 15000;

// GET /api/ml/search?q=termo&limit=50&offset=0
router.get('/search', async (req, res) => {
  try {
    const { q, limit = 50, offset = 0, category } = req.query;
    const params = { q, limit, offset };
    if (category) params.category = category;

    const { data } = await axios.get(`${ML_API}/sites/${SITE_ID}/search`, {
      params,
      timeout: TIMEOUT
    });
    res.json(data);
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// GET /api/ml/categories
router.get('/categories', async (req, res) => {
  try {
    const { data } = await axios.get(`${ML_API}/sites/${SITE_ID}/categories`, {
      timeout: TIMEOUT
    });
    res.json(data);
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// GET /api/ml/category/:id
router.get('/category/:id', async (req, res) => {
  try {
    const { data } = await axios.get(`${ML_API}/categories/${req.params.id}`, {
      timeout: TIMEOUT
    });
    res.json(data);
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

module.exports = router;
