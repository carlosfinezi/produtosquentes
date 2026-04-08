// State
let currentQuery = '';
let currentPage = 1;
let currentSort = 'sales';
let currentOrder = 'desc';
const LIMIT = 50;

// Chart instances
let chartCategories, chartPrices, chartTopSales, chartTopRevenue;

// DOM
const searchInput = document.getElementById('searchInput');
const btnSearch = document.getElementById('btnSearch');
const btnSaveSearch = document.getElementById('btnSaveSearch');
const statusIndicator = document.getElementById('statusIndicator');
const productTableBody = document.getElementById('productTableBody');
const paginationEl = document.getElementById('pagination');

// Init
document.addEventListener('DOMContentLoaded', () => {
  loadStatus();
  loadSavedSearches();

  btnSearch.addEventListener('click', () => doSearch());
  searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  btnSaveSearch.addEventListener('click', saveSearch);

  document.getElementById('filterSort').addEventListener('change', e => {
    currentSort = e.target.value;
    currentPage = 1;
    loadProducts();
  });
  document.getElementById('filterOrder').addEventListener('change', e => {
    currentOrder = e.target.value;
    currentPage = 1;
    loadProducts();
  });

  document.getElementById('btnExportCSV').addEventListener('click', () => {
    if (currentQuery) window.open(`/api/export/csv?q=${encodeURIComponent(currentQuery)}`);
  });
  document.getElementById('btnExportJSON').addEventListener('click', () => {
    if (currentQuery) window.open(`/api/export/json?q=${encodeURIComponent(currentQuery)}`);
  });
});

async function loadStatus() {
  try {
    const data = await apiFetch('/api/status');
    const parts = [];
    parts.push(`${formatNumber(data.totalProducts)} produtos`);
    if (data.lastCollection) {
      parts.push(`Ultima coleta: ${formatRelativeDate(data.lastCollection.at)}`);
    }
    statusIndicator.textContent = parts.join(' | ');
  } catch {
    statusIndicator.textContent = 'Sistema ativo';
  }
}

async function doSearch() {
  const q = searchInput.value.trim();
  if (!q) return;
  currentQuery = q;
  currentPage = 1;
  await Promise.all([loadProducts(), loadMetrics()]);
}

// --- Products Table ---

async function loadProducts() {
  if (!currentQuery) return;
  productTableBody.innerHTML = '<tr><td colspan="6" class="loading">Carregando...</td></tr>';

  try {
    // Try local database first
    const params = new URLSearchParams({
      q: currentQuery,
      sort: currentSort,
      order: currentOrder,
      page: currentPage,
      limit: LIMIT
    });

    let data = await apiFetch(`/api/products?${params}`);

    // If no local data, try ML API directly
    if (data.products.length === 0) {
      const mlData = await apiFetch(`/api/ml/search?q=${encodeURIComponent(currentQuery)}&limit=50`);
      if (mlData.results && mlData.results.length > 0) {
        renderMLResults(mlData.results);
        showToast('Mostrando resultados da API do Mercado Livre. Salve a busca para coletar dados historicos.');
        return;
      }
    }

    renderProducts(data.products, data.total);
  } catch (err) {
    productTableBody.innerHTML = `<tr><td colspan="6" class="empty-state">Erro: ${err.message}</td></tr>`;
  }
}

function renderProducts(products, total) {
  if (products.length === 0) {
    productTableBody.innerHTML = '<tr><td colspan="6" class="empty-state">Nenhum produto encontrado</td></tr>';
    paginationEl.innerHTML = '';
    return;
  }

  productTableBody.innerHTML = products.map(p => `
    <tr>
      <td>
        <div class="product-cell">
          <img class="product-thumb" src="${p.thumbnail || ''}" alt="" onerror="this.style.display='none'" />
          <a href="/produto.html?id=${p.id}" class="product-name" title="${p.title || ''}">${truncate(p.title)}</a>
        </div>
      </td>
      <td>${formatCurrency(p.price)}</td>
      <td>${formatNumber(p.monthlySales)}</td>
      <td>${formatCurrency(p.monthlyRevenue)}</td>
      <td>${truncate(p.categoryName || '', 25)}</td>
      <td>${p.freeShipping ? '<span class="badge badge-green">Gratis</span>' : '—'}</td>
    </tr>
  `).join('');

  renderPagination(total);
}

function renderMLResults(results) {
  productTableBody.innerHTML = results.map(p => `
    <tr>
      <td>
        <div class="product-cell">
          <img class="product-thumb" src="${p.thumbnail || ''}" alt="" onerror="this.style.display='none'" />
          <a href="${p.permalink || '#'}" target="_blank" class="product-name" title="${p.title || ''}">${truncate(p.title)}</a>
        </div>
      </td>
      <td>${formatCurrency(p.price)}</td>
      <td>${formatNumber(p.sold_quantity || 0)}</td>
      <td>${formatCurrency((p.sold_quantity || 0) * (p.price || 0))}</td>
      <td>—</td>
      <td>${p.shipping?.free_shipping ? '<span class="badge badge-green">Gratis</span>' : '—'}</td>
    </tr>
  `).join('');

  paginationEl.innerHTML = '';
}

function renderPagination(total) {
  const totalPages = Math.ceil(total / LIMIT);
  if (totalPages <= 1) { paginationEl.innerHTML = ''; return; }

  paginationEl.innerHTML = `
    <button ${currentPage <= 1 ? 'disabled' : ''} id="prevPage">Anterior</button>
    <span class="page-info">Pagina ${currentPage} de ${totalPages} (${total} produtos)</span>
    <button ${currentPage >= totalPages ? 'disabled' : ''} id="nextPage">Proxima</button>
  `;

  document.getElementById('prevPage')?.addEventListener('click', () => {
    if (currentPage > 1) { currentPage--; loadProducts(); }
  });
  document.getElementById('nextPage')?.addEventListener('click', () => {
    if (currentPage < totalPages) { currentPage++; loadProducts(); }
  });
}

// --- Metrics / KPIs ---

async function loadMetrics() {
  if (!currentQuery) return;

  try {
    const data = await apiFetch(`/api/metrics?q=${encodeURIComponent(currentQuery)}`);

    document.getElementById('kpiAvgPrice').textContent = formatCurrency(data.avgPrice);
    document.getElementById('kpiPriceRange').textContent =
      `Min: ${formatCurrency(data.minPrice)} | Max: ${formatCurrency(data.maxPrice)}`;

    document.getElementById('kpiTotalSales').textContent = formatNumber(data.totalSales);
    document.getElementById('kpiAvgSales').textContent =
      `Media por produto: ${formatNumber(data.avgMonthlySales)}`;

    document.getElementById('kpiTotalRevenue').textContent = formatCurrency(data.totalRevenue);
    document.getElementById('kpiAvgRevenue').textContent =
      data.totalProducts > 0
        ? `Media: ${formatCurrency(data.totalRevenue / data.totalProducts)}/produto`
        : '';

    document.getElementById('kpiFreeShipping').textContent = formatNumber(data.freeShippingCount);
    document.getElementById('kpiFreeShippingSub').textContent =
      `de ${data.totalProducts} produtos`;

    document.getElementById('kpiDiscounted').textContent = formatNumber(data.discountedCount);
    document.getElementById('kpiDiscountedSub').textContent = 'produtos em promocao';

    renderCharts(data);
  } catch (err) {
    console.error('Error loading metrics:', err);
  }
}

// --- Charts ---

function renderCharts(data) {
  const defaultOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: '#8b8fa3', font: { size: 11 } }, grid: { color: '#2a2d3e' } },
      y: { ticks: { color: '#8b8fa3', font: { size: 11 } }, grid: { color: '#2a2d3e' } }
    }
  };

  // Categories by Revenue
  if (chartCategories) chartCategories.destroy();
  const catData = (data.byCategory || []).slice(0, 8);
  chartCategories = new Chart(document.getElementById('chartCategories'), {
    type: 'bar',
    data: {
      labels: catData.map(c => truncate(c.name, 20)),
      datasets: [{
        data: catData.map(c => c.revenue),
        backgroundColor: '#6c5ce7',
        borderRadius: 4
      }]
    },
    options: { ...defaultOptions, indexAxis: 'y' }
  });

  // Price Distribution
  if (chartPrices) chartPrices.destroy();
  const prices = (data.topBySales || []).map(p => p.price).filter(Boolean).sort((a, b) => a - b);
  if (prices.length > 0) {
    const bucketCount = 10;
    const min = prices[0];
    const max = prices[prices.length - 1];
    const step = (max - min) / bucketCount || 1;
    const buckets = Array(bucketCount).fill(0);
    const labels = [];
    for (let i = 0; i < bucketCount; i++) {
      const from = min + step * i;
      const to = from + step;
      labels.push(`${formatCurrency(from)}`);
      prices.forEach(p => { if (p >= from && p < to) buckets[i]++; });
    }
    chartPrices = new Chart(document.getElementById('chartPrices'), {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          data: buckets,
          backgroundColor: '#74b9ff',
          borderRadius: 4
        }]
      },
      options: defaultOptions
    });
  }

  // Top 10 by Sales
  if (chartTopSales) chartTopSales.destroy();
  const topSales = (data.topBySales || []).slice(0, 10);
  chartTopSales = new Chart(document.getElementById('chartTopSales'), {
    type: 'bar',
    data: {
      labels: topSales.map(p => truncate(p.title, 18)),
      datasets: [{
        data: topSales.map(p => p.monthlySales),
        backgroundColor: '#00b894',
        borderRadius: 4
      }]
    },
    options: { ...defaultOptions, indexAxis: 'y' }
  });

  // Top 10 by Revenue
  if (chartTopRevenue) chartTopRevenue.destroy();
  const topRev = (data.topByRevenue || []).slice(0, 10);
  chartTopRevenue = new Chart(document.getElementById('chartTopRevenue'), {
    type: 'bar',
    data: {
      labels: topRev.map(p => truncate(p.title, 18)),
      datasets: [{
        data: topRev.map(p => p.monthlyRevenue),
        backgroundColor: '#fdcb6e',
        borderRadius: 4
      }]
    },
    options: { ...defaultOptions, indexAxis: 'y' }
  });
}

// --- Save Search ---

async function saveSearch() {
  const term = searchInput.value.trim();
  if (!term) return;

  try {
    await apiPost('/api/searches', { term });
    await apiPost('/api/collect', { term });
    showToast(`Busca "${term}" salva! Coleta iniciada e sera repetida diariamente as 06h.`);
    loadSavedSearches();
  } catch (err) {
    showToast('Erro ao salvar busca: ' + err.message);
  }
}

async function loadSavedSearches() {
  try {
    const searches = await apiFetch('/api/searches');
    const container = document.getElementById('savedSearches');

    if (searches.length === 0) {
      container.innerHTML = '<div class="empty-state">Nenhuma busca salva</div>';
      return;
    }

    container.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Termo</th>
            <th>Categoria</th>
            <th>Max Resultados</th>
            <th>Ultima Coleta</th>
            <th>Status</th>
            <th>Acoes</th>
          </tr>
        </thead>
        <tbody>
          ${searches.map(s => `
            <tr>
              <td><a href="#" class="search-link" data-term="${s.term}">${s.term}</a></td>
              <td>${s.category || '—'}</td>
              <td>${s.maxResults}</td>
              <td>${s.lastRunAt ? formatRelativeDate(s.lastRunAt) : 'Nunca'}</td>
              <td>${s.isActive ? '<span class="badge badge-green">Ativa</span>' : '<span class="badge badge-yellow">Inativa</span>'}</td>
              <td>
                <button class="btn btn-sm btn-secondary collect-btn" data-term="${s.term}">Coletar Agora</button>
                <button class="btn btn-sm btn-danger delete-btn" data-id="${s.id}">Remover</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;

    // Event listeners
    container.querySelectorAll('.search-link').forEach(link => {
      link.addEventListener('click', e => {
        e.preventDefault();
        searchInput.value = link.dataset.term;
        doSearch();
      });
    });

    container.querySelectorAll('.collect-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        await apiPost('/api/collect', { term: btn.dataset.term });
        showToast(`Coleta iniciada para "${btn.dataset.term}"`);
      });
    });

    container.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        await fetch(`/api/searches/${btn.dataset.id}`, { method: 'DELETE' });
        loadSavedSearches();
        showToast('Busca removida');
      });
    });
  } catch (err) {
    console.error('Error loading searches:', err);
  }
}

// --- Toast ---

function showToast(message) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}
