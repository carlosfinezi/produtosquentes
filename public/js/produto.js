// Get product ID from URL
const params = new URLSearchParams(window.location.search);
const productId = params.get('id');

let chartPrice, chartSales, chartRevenue;

document.addEventListener('DOMContentLoaded', () => {
  if (!productId) {
    document.getElementById('loadingState').textContent = 'ID do produto nao informado.';
    return;
  }
  loadProduct();

  // Tab switching
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const tabName = tab.dataset.tab;
      document.getElementById('chartPrice').style.display = tabName === 'price' ? 'block' : 'none';
      document.getElementById('chartSales').style.display = tabName === 'sales' ? 'block' : 'none';
      document.getElementById('chartRevenue').style.display = tabName === 'revenue' ? 'block' : 'none';
    });
  });
});

async function loadProduct() {
  try {
    const data = await apiFetch(`/api/products/${productId}`);

    document.getElementById('loadingState').style.display = 'none';
    document.getElementById('productContent').style.display = 'block';

    const product = data.product;
    document.title = `${product.title} — PulseDados ML`;

    // Header
    document.getElementById('productTitle').textContent = product.title;
    document.getElementById('btnViewML').href = product.permalink || '#';

    // Image
    if (product.thumbnail) {
      const img = document.getElementById('productImage');
      // ML thumbnails: replace -I.jpg with -O.jpg for larger image
      img.src = product.thumbnail.replace('-I.jpg', '-O.jpg');
    }

    // Badges
    const badges = document.getElementById('badges');
    if (product.freeShipping) badges.innerHTML += '<span class="badge badge-green">Frete Gratis</span>';
    if (product.catalogProductId) badges.innerHTML += '<span class="badge badge-blue">Catalogo</span>';
    if (product.condition === 'new') badges.innerHTML += '<span class="badge badge-yellow">Novo</span>';

    // Details
    const details = document.getElementById('infoDetails');
    const infoRows = [
      ['Vendedor', product.sellerNickname || '—'],
      ['Condicao', product.condition === 'new' ? 'Novo' : product.condition === 'used' ? 'Usado' : '—'],
      ['Categoria', product.categoryPath || product.categoryName || '—'],
      ['Tipo de Anuncio', product.listingType || '—'],
      ['ID Catalogo', product.catalogProductId || '—'],
      ['Vendas Totais', formatNumberFull(data.totalSales)],
      ['Avaliacoes', '—'],
      ['Primeira Coleta', formatDate(data.firstSeenDate)],
      ['Dias Ativos', `${data.daysActive} dias`]
    ];
    details.innerHTML = infoRows.map(([label, value]) => `
      <div class="info-row">
        <span class="info-label">${label}</span>
        <span class="info-value">${value}</span>
      </div>
    `).join('');

    // Price Cards
    document.getElementById('priceNow').textContent = formatCurrency(data.currentPrice);
    document.getElementById('priceMin').textContent = formatCurrency(data.minPriceEver);
    document.getElementById('discountMax').textContent = formatPercent(data.maxDiscountEver);

    // Metrics
    document.getElementById('revenueMonthly').textContent = formatCurrency(data.monthlyRevenueAvg);
    document.getElementById('revenueWeekly').textContent = formatCurrency(data.weeklyRevenueAvg);
    document.getElementById('revenueDaily').textContent = formatCurrency(data.dailyRevenueAvg);

    document.getElementById('salesMonthly').textContent =
      `${formatNumber(data.monthlySalesAvg)} (${formatNumber(data.totalSales)} total)`;
    document.getElementById('salesWeekly').textContent = formatNumber(data.weeklySalesAvg);
    document.getElementById('salesDaily').textContent = formatNumber(data.dailySalesAvg);

    // Check if first day (no history)
    if (data.priceHistory.length <= 1) {
      document.getElementById('noHistoryBanner').style.display = 'block';
    }

    // Charts
    renderCharts(data);

    // Related sellers (same catalog)
    if (product.catalogProductId) {
      loadRelated(product.catalogProductId, product.id);
    }
  } catch (err) {
    document.getElementById('loadingState').textContent = `Erro ao carregar produto: ${err.message}`;
  }
}

function renderCharts(data) {
  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: {
        ticks: { color: '#8b8fa3', font: { size: 11 }, maxRotation: 45 },
        grid: { color: '#2a2d3e' }
      },
      y: {
        ticks: { color: '#8b8fa3', font: { size: 11 } },
        grid: { color: '#2a2d3e' }
      }
    }
  };

  const dates = data.priceHistory.map(h => h.date);

  // Price chart
  chartPrice = new Chart(document.getElementById('chartPrice'), {
    type: 'line',
    data: {
      labels: dates,
      datasets: [{
        data: data.priceHistory.map(h => h.price),
        borderColor: '#6c5ce7',
        backgroundColor: 'rgba(108, 92, 231, 0.1)',
        fill: true,
        tension: 0.3,
        pointRadius: 2,
        pointHoverRadius: 5
      }]
    },
    options: {
      ...chartOptions,
      scales: {
        ...chartOptions.scales,
        y: {
          ...chartOptions.scales.y,
          ticks: {
            ...chartOptions.scales.y.ticks,
            callback: v => 'R$ ' + v.toFixed(0)
          }
        }
      }
    }
  });

  // Sales chart
  const salesDates = data.salesHistory.map(h => h.date);
  chartSales = new Chart(document.getElementById('chartSales'), {
    type: 'bar',
    data: {
      labels: salesDates,
      datasets: [{
        data: data.salesHistory.map(h => h.sales || 0),
        backgroundColor: '#00b894',
        borderRadius: 3
      }]
    },
    options: chartOptions
  });

  // Revenue chart
  chartRevenue = new Chart(document.getElementById('chartRevenue'), {
    type: 'line',
    data: {
      labels: salesDates,
      datasets: [{
        data: data.salesHistory.map(h => h.revenue || 0),
        borderColor: '#fdcb6e',
        backgroundColor: 'rgba(253, 203, 110, 0.1)',
        fill: true,
        tension: 0.3,
        pointRadius: 2,
        pointHoverRadius: 5
      }]
    },
    options: {
      ...chartOptions,
      scales: {
        ...chartOptions.scales,
        y: {
          ...chartOptions.scales.y,
          ticks: {
            ...chartOptions.scales.y.ticks,
            callback: v => 'R$ ' + formatNumber(v)
          }
        }
      }
    }
  });
}

async function loadRelated(catalogId, currentId) {
  try {
    const data = await apiFetch(`/api/products?q=&page=1&limit=20`);
    const related = data.products.filter(p =>
      p.id !== currentId && p.catalogProductId === catalogId
    );

    if (related.length === 0) return;

    document.getElementById('relatedSection').style.display = 'block';
    document.getElementById('relatedBody').innerHTML = related.map(p => `
      <tr>
        <td>${p.sellerNickname || '—'}</td>
        <td>${formatCurrency(p.price)}</td>
        <td>${formatNumber(p.soldQuantity)}</td>
        <td>${p.freeShipping ? '<span class="badge badge-green">Sim</span>' : 'Nao'}</td>
        <td><a href="/produto.html?id=${p.id}">Ver detalhes</a></td>
      </tr>
    `).join('');
  } catch {
    // Silently fail for related products
  }
}
