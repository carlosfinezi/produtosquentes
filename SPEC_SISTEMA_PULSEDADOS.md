# PulseDados ML — Especificacao Tecnica Completa

## Contexto para o desenvolvedor (Claude Code)

Preciso que voce construa um sistema web completo de monitoramento de produtos do Mercado Livre, similar ao JoomPulse (joompulse.com). O sistema roda numa VPS Linux com PostgreSQL ja instalado. O frontend e o backend devem ser um unico projeto Node.js.

A API publica do Mercado Livre (https://api.mercadolibre.com) fornece dados de produtos em tempo real. O diferencial deste sistema e coletar esses dados diariamente e armazena-los no PostgreSQL para calcular metricas historicas (medias diarias, semanais, mensais, precos minimos registrados, etc).

---

## 1. Stack Tecnologico

- **Runtime**: Node.js (versao 18+)
- **Framework backend**: Express.js
- **Banco de dados**: PostgreSQL (ja instalado na VPS)
- **ORM**: Prisma
- **Frontend**: HTML + CSS + JavaScript vanilla (servido pelo Express como arquivos estaticos)
- **Agendamento**: node-cron (coleta automatica diaria)
- **HTTP client**: axios (para chamar API do ML)
- **Graficos no frontend**: Chart.js (via CDN)

---

## 2. Estrutura de Pastas

```
pulsedados/
├── prisma/
│   └── schema.prisma
├── src/
│   ├── server.js              # Entry point: Express + rotas + cron
│   ├── collector.js           # Logica de coleta da API do ML
│   ├── metrics.js             # Calculo de metricas historicas
│   └── routes/
│       ├── api.js             # Endpoints REST da API interna
│       └── proxy.js           # Proxy para API do ML (evita CORS)
├── public/
│   ├── index.html             # Dashboard principal
│   ├── produto.html           # Pagina de detalhe do produto
│   ├── css/
│   │   └── style.css
│   └── js/
│       ├── dashboard.js       # Logica do dashboard
│       ├── produto.js         # Logica da pagina de detalhe
│       └── utils.js           # Formatadores, helpers
├── package.json
├── .env
└── README.md
```

---

## 3. Banco de Dados — Schema PostgreSQL (Prisma)

### 3.1 Tabela `products` — Dados atuais de cada produto

```prisma
model Product {
  id                String   @id                // MLB ID (ex: "MLB6047955038")
  title             String
  permalink         String?
  thumbnail         String?
  categoryId        String?
  categoryName      String?
  categoryPath      String?                     // "Celulares > Acessorios > Fones"
  sellerId          String?
  sellerNickname    String?
  condition         String?                     // "new" ou "used"
  listingType       String?                     // "gold_special", "gold_pro", etc
  catalogProductId  String?                     // ID do catalogo ML
  freeShipping      Boolean  @default(false)
  createdAt         DateTime @default(now())    // Primeira vez que vimos este produto
  updatedAt         DateTime @updatedAt

  // Relacao com snapshots
  snapshots         ProductSnapshot[]

  @@index([categoryId])
  @@index([sellerNickname])
  @@index([catalogProductId])
}
```

### 3.2 Tabela `product_snapshots` — Foto diaria de cada produto

Esta e a tabela mais importante. Cada linha e um "snapshot" diario dos dados do produto.

```prisma
model ProductSnapshot {
  id                 Int      @id @default(autoincrement())
  productId          String
  product            Product  @relation(fields: [productId], references: [id])

  // Dados que mudam diariamente
  price              Float                      // Preco atual
  originalPrice      Float?                     // Preco original (sem desconto)
  soldQuantity       Int                        // ACUMULADO total de vendas (da API)
  availableQuantity  Int?
  reviewsCount       Int?                       // Total de avaliacoes
  reviewsRating      Float?                     // Nota media (ex: 4.8)

  // Calculados no momento da coleta
  dailySales         Int?                       // Vendas do dia (delta do soldQuantity)
  dailyRevenue       Float?                     // dailySales * price
  discountPercent    Float?                     // (originalPrice - price) / originalPrice * 100

  // Metadados
  collectedAt        DateTime @default(now())   // Momento exato da coleta
  collectedDate      DateTime                   // Apenas a data (YYYY-MM-DD), sem hora

  @@unique([productId, collectedDate])          // Um snapshot por produto por dia
  @@index([collectedDate])
  @@index([productId, collectedDate])
}
```

### 3.3 Tabela `searches` — Buscas salvas para coleta automatica

```prisma
model Search {
  id          Int      @id @default(autoincrement())
  term        String                             // "fone bluetooth"
  category    String?                            // "MLB1051" (opcional)
  maxResults  Int      @default(200)             // Quantos produtos coletar
  isActive    Boolean  @default(true)            // Se esta ativa para coleta diaria
  lastRunAt   DateTime?
  createdAt   DateTime @default(now())

  @@unique([term, category])
}
```

### 3.4 Tabela `collection_logs` — Log de cada execucao do coletor

```prisma
model CollectionLog {
  id             Int      @id @default(autoincrement())
  searchTerm     String
  productsFound  Int
  snapshotsSaved Int
  errors         Int      @default(0)
  durationMs     Int                             // Tempo de execucao em ms
  status         String                          // "success", "partial", "error"
  errorMessage   String?
  createdAt      DateTime @default(now())
}
```

---

## 4. Coletor de Dados (`collector.js`)

### 4.1 Fluxo principal

A funcao `collectSearch(term, category, maxResults)` faz o seguinte:

1. Consulta `GET https://api.mercadolibre.com/sites/MLB/search?q={term}&limit=50&offset={offset}`
   - Se `category` informada, adiciona `&category={category}`
   - Pagina ate atingir `maxResults` ou acabar os resultados
   - Pausa 1 segundo entre cada request (rate limiting)

2. Para cada item retornado pela API, extrai:
   ```
   id, title, price, original_price, sold_quantity, available_quantity,
   category_id, seller.id, seller.nickname, condition, listing_type_id,
   catalog_product_id, shipping.free_shipping, thumbnail, permalink
   ```

3. Busca nomes das categorias (com cache):
   - `GET https://api.mercadolibre.com/categories/{category_id}`
   - Armazena `name` e `path_from_root` como "Cat1 > Cat2 > Cat3"
   - Cache em memoria para nao repetir

4. Para cada produto:
   - Faz UPSERT na tabela `products` (cria se nao existe, atualiza se ja existe)
   - Busca o snapshot de ontem deste produto para calcular o delta:
     - `dailySales = soldQuantity_hoje - soldQuantity_ontem` (se > 0, senao 0)
     - `dailyRevenue = dailySales * price`
     - `discountPercent = originalPrice ? ((originalPrice - price) / originalPrice * 100) : 0`
   - Insere novo `ProductSnapshot` com a data de hoje

5. Registra na tabela `collection_logs`

### 4.2 Agendamento com node-cron

No `server.js`, agendar execucao diaria as 06:00 (horario de Brasilia):

```javascript
cron.schedule('0 6 * * *', async () => {
  const searches = await prisma.search.findMany({ where: { isActive: true } });
  for (const search of searches) {
    await collectSearch(search.term, search.category, search.maxResults);
    await prisma.search.update({ where: { id: search.id }, data: { lastRunAt: new Date() } });
  }
}, { timezone: "America/Sao_Paulo" });
```

### 4.3 Coleta manual via API

Endpoint `POST /api/collect` que permite disparar uma coleta manualmente (o dashboard usa isso para busca sob demanda).

---

## 5. Calculo de Metricas (`metrics.js`)

### 5.1 Metricas de um produto individual

Funcao `getProductMetrics(productId)` retorna:

```javascript
{
  // Preco
  currentPrice: 73.00,
  minPriceEver: 65.00,          // SELECT MIN(price) FROM snapshots WHERE productId = X
  maxPriceEver: 99.00,          // SELECT MAX(price)
  maxDiscountEver: 27.3,        // SELECT MAX(discountPercent)

  // Vendas
  totalSales: 50000,            // Ultimo soldQuantity (acumulado)
  dailySalesAvg: 424,           // AVG(dailySales) ultimos 30 dias
  weeklySalesAvg: 2968,         // SUM(dailySales) ultimos 7 dias (media de 4 semanas)
  monthlySalesAvg: 12712,       // SUM(dailySales) ultimos 30 dias

  // Receita
  dailyRevenueAvg: 30952,       // AVG(dailyRevenue) ultimos 30 dias
  weeklyRevenueAvg: 216664,     // SUM(dailyRevenue) ultimos 7 dias (media de 4 semanas)
  monthlyRevenueAvg: 927744,    // SUM(dailyRevenue) ultimos 30 dias

  // Tempo
  daysActive: 118,              // DATEDIFF(now, product.createdAt)
  firstSeenDate: "2025-12-12",  // product.createdAt

  // Historico para graficos
  priceHistory: [               // Ultimos 90 dias
    { date: "2026-01-15", price: 78.00 },
    { date: "2026-01-16", price: 73.00 },
    ...
  ],
  salesHistory: [               // Ultimos 90 dias
    { date: "2026-01-15", sales: 400, revenue: 31200 },
    ...
  ]
}
```

### 5.2 Metricas agregadas de uma busca

Funcao `getSearchMetrics(term, filters)` retorna:

```javascript
{
  totalProducts: 1000,
  avgPrice: 142.50,
  minPrice: 12.90,
  maxPrice: 1298.00,
  totalSales: 500000,           // Soma dos dailySales de todos os produtos (ultimo dia)
  totalRevenue: 85000000,
  avgMonthlySales: 1200,
  freeShippingCount: 750,
  discountedCount: 320,

  // Agrupamentos
  byCategory: [
    { name: "Celulares e Telefones", products: 600, revenue: 50000000, sales: 300000 },
    ...
  ],
  byState: [                     // Se disponivel da API
    { name: "Sao Paulo", products: 400, sales: 200000 },
    ...
  ],

  // Top produtos
  topBySales: [ ...top 20 produtos por vendas... ],
  topByRevenue: [ ...top 20 produtos por receita... ],
  cheapest: [ ...top 20 mais baratos... ]
}
```

### 5.3 Queries SQL importantes

**Vendas diarias dos ultimos 30 dias de um produto:**
```sql
SELECT "collectedDate", "dailySales", "dailyRevenue", "price"
FROM "ProductSnapshot"
WHERE "productId" = $1
  AND "collectedDate" >= CURRENT_DATE - INTERVAL '30 days'
ORDER BY "collectedDate" ASC;
```

**Media mensal de vendas de um produto:**
```sql
SELECT COALESCE(SUM("dailySales"), 0) as monthly_sales,
       COALESCE(SUM("dailyRevenue"), 0) as monthly_revenue
FROM "ProductSnapshot"
WHERE "productId" = $1
  AND "collectedDate" >= CURRENT_DATE - INTERVAL '30 days';
```

**Top produtos por receita mensal (de uma busca):**
```sql
SELECT p.id, p.title, p.thumbnail, p."categoryName", p."freeShipping",
       SUM(s."dailySales") as monthly_sales,
       SUM(s."dailyRevenue") as monthly_revenue,
       AVG(s.price) as avg_price
FROM "Product" p
JOIN "ProductSnapshot" s ON s."productId" = p.id
WHERE p.title ILIKE '%fone%' AND p.title ILIKE '%bluetooth%'
  AND s."collectedDate" >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY p.id
ORDER BY monthly_revenue DESC
LIMIT 20;
```

---

## 6. API REST (rotas)

### 6.1 Busca e Coleta

| Metodo | Rota | Descricao |
|--------|------|-----------|
| `GET` | `/api/search?q=termo&limit=200` | Busca produtos na API do ML (proxy, sem CORS) e retorna resultados em tempo real |
| `POST` | `/api/collect` | Dispara coleta manual. Body: `{ term, category?, maxResults? }`. Salva no banco |
| `GET` | `/api/searches` | Lista buscas salvas |
| `POST` | `/api/searches` | Cria nova busca para coleta automatica. Body: `{ term, category?, maxResults? }` |
| `DELETE` | `/api/searches/:id` | Remove busca salva |

### 6.2 Produtos e Metricas

| Metodo | Rota | Descricao |
|--------|------|-----------|
| `GET` | `/api/products?q=termo&category=X&sort=revenue&order=desc&page=1&limit=50` | Lista produtos do banco com filtros e paginacao |
| `GET` | `/api/products/:id` | Detalhe completo de um produto com todas as metricas historicas |
| `GET` | `/api/products/:id/history?days=90` | Historico de precos e vendas (para graficos) |
| `GET` | `/api/metrics?q=termo&category=X` | Metricas agregadas de uma busca (KPIs, agrupamentos) |

### 6.3 Proxy para ML (evita CORS)

| Metodo | Rota | Descricao |
|--------|------|-----------|
| `GET` | `/api/ml/search?q=termo&limit=50&offset=0` | Proxy para `api.mercadolibre.com/sites/MLB/search` |
| `GET` | `/api/ml/categories` | Proxy para lista de categorias do MLB |
| `GET` | `/api/ml/category/:id` | Proxy para detalhes de uma categoria |

### 6.4 Exportacao

| Metodo | Rota | Descricao |
|--------|------|-----------|
| `GET` | `/api/export/csv?q=termo` | Exporta produtos filtrados em CSV |
| `GET` | `/api/export/json?q=termo` | Exporta produtos filtrados em JSON |

### 6.5 Admin / Status

| Metodo | Rota | Descricao |
|--------|------|-----------|
| `GET` | `/api/status` | Status do sistema: ultima coleta, total de produtos no banco, uptime |
| `GET` | `/api/logs?limit=20` | Ultimos logs de coleta |

---

## 7. Frontend — Dashboard (`public/index.html`)

### 7.1 Layout

Tema escuro, similar ao que ja foi construido. Estrutura:

1. **Header fixo**: Logo "PulseDados ML", barra de busca, status da ultima coleta
2. **Barra de busca**: Campo de texto + botao "Buscar" + botao "Salvar busca para coleta diaria"
3. **KPI Cards** (5 cards em grid):
   - Preco Medio (com min/max no subtexto)
   - Total de Vendas (com media por produto)
   - Receita Estimada (com media por produto)
   - Com Frete Gratis (de N produtos)
   - Com Desconto (produtos em promocao)
4. **Graficos** (2 colunas):
   - Esquerda: Bar chart horizontal — Top categorias por receita
   - Direita: Histograma — Distribuicao de precos
5. **Graficos** (2 colunas):
   - Esquerda: Bar chart — Top estados por vendas
   - Direita: Bar chart — Top 10 mais vendidos
6. **Tabela de produtos** com:
   - Filtros: texto, categoria (dropdown), frete, ordenacao
   - Colunas: Imagem, Nome (link para detalhe), Preco, Vendas mensais, Receita mensal, Categoria, Frete, Estado
   - Paginacao
   - Botoes: Exportar CSV, Exportar JSON, Salvar no banco

### 7.2 Fluxo de interacao

1. Usuario digita "fone bluetooth" e clica Buscar
2. Frontend chama `GET /api/products?q=fone+bluetooth` (dados do banco)
3. Se nao tem dados no banco, chama `GET /api/ml/search?q=fone+bluetooth` (API do ML direto)
4. Mostra resultados no dashboard
5. Usuario pode clicar "Salvar busca" que chama `POST /api/searches` + `POST /api/collect`
6. A partir dai, coleta automatica todo dia as 06h

---

## 8. Frontend — Detalhe do Produto (`public/produto.html`)

Acessado via `produto.html?id=MLB6047955038`

### 8.1 Layout

1. **Header**: Titulo do produto (grande), botoes "Monitorar" e "Ver no Mercado Livre"
2. **Info basica** (3 colunas):
   - Esquerda: Imagem do produto, badges (Full, Frete gratis, Catalogo)
   - Centro: Marca, Vendedor, Classificacao, Avaliacoes, Visualizacoes, Categorias, Data criacao, Dias ativos
   - Direita: Cards de preco (Preco atual, Preco minimo registrado, Desconto maximo registrado)
3. **Cards de metricas** (2 cards):
   - Receita media: mensal, semanal, diaria
   - Vendas medias: mensal (+ total), semanal, diaria
4. **Graficos** (abas):
   - Aba "Preco": Line chart com historico de precos (Chart.js)
   - Aba "Vendas": Bar chart com vendas diarias
   - Aba "Receita": Line chart com receita diaria
5. **Tabela**: Outros vendedores do mesmo catalogo (se catalogProductId existir)

---

## 9. Variaveis de Ambiente (.env)

```
DATABASE_URL="postgresql://usuario:senha@localhost:5432/pulsedados"
PORT=3000
ML_API_BASE="https://api.mercadolibre.com"
ML_SITE_ID="MLB"
COLLECT_HOUR="6"
COLLECT_MINUTE="0"
COLLECT_TIMEZONE="America/Sao_Paulo"
MAX_REQUESTS_PER_SECOND=1
```

---

## 10. Comandos para Rodar

```bash
# 1. Instalar dependencias
npm install

# 2. Configurar banco (criar tabelas)
npx prisma migrate dev --name init

# 3. Rodar o servidor
npm start

# 4. Acessar no navegador
# http://localhost:3000
```

Para producao com PM2:
```bash
pm2 start src/server.js --name pulsedados
pm2 save
pm2 startup
```

---

## 11. Regras de Negocio Importantes

### 11.1 Calculo de vendas diarias

O campo `sold_quantity` da API do ML e ACUMULATIVO (total historico). Para saber as vendas do dia:

```
vendas_hoje = sold_quantity_hoje - sold_quantity_ontem
```

Se o resultado for negativo (produto removido e recriado), considerar 0.
Se nao existir snapshot de ontem (produto novo), dailySales = null (nao calcular).

### 11.2 Rate limiting da API do ML

- Maximo 1 request por segundo
- Se receber HTTP 429, aguardar 60 segundos e retomar
- Timeout de 15 segundos por request

### 11.3 Snapshot unico por dia

O constraint `@@unique([productId, collectedDate])` garante que so existe um snapshot por produto por dia. Se rodar a coleta 2 vezes no mesmo dia, usar UPSERT (atualizar em vez de duplicar).

### 11.4 Categorias com cache

Ao buscar nomes de categorias na API (`/categories/{id}`), cachear em memoria (Map) durante a execucao da coleta. Categorias nao mudam frequentemente.

### 11.5 Quando nao tem dados historicos

Se o produto foi coletado hoje pela primeira vez:
- Mostrar metricas atuais (preco, soldQuantity total) 
- Mostrar "Coleta iniciada hoje — metricas historicas disponiveis a partir de amanha"
- dailySales, weeklyAvg, monthlyAvg = mostrar "—" ou "Aguardando dados"

---

## 12. Resultado Esperado

Apos implementar tudo, o sistema deve:

1. **Buscar produtos** digitando um termo e ver resultados instantaneos
2. **Salvar buscas** para coleta automatica diaria
3. **Acumular dados** automaticamente a cada dia as 06h
4. **Calcular metricas** identicas ao JoomPulse:
   - Receita media mensal/semanal/diaria
   - Vendas medias mensal/semanal/diaria
   - Preco minimo registrado
   - Desconto maximo registrado
   - Dias ativos
5. **Mostrar graficos** de historico de preco e vendas
6. **Exportar** em CSV e JSON
7. **Pagina de detalhe** com todas as metricas de cada produto

A partir de 30 dias de coleta, as metricas mensais serao precisas. Apos 90 dias, tera tendencias e sazonalidades.

---

## 13. O Que NAO Fazer

- NAO usar Python em nenhum lugar — tudo em Node.js
- NAO usar frameworks frontend pesados (React, Vue, etc.) — usar HTML/CSS/JS puro com Chart.js
- NAO criar autenticacao/login neste MVP — acesso direto
- NAO fazer scraping do site do ML — usar apenas a API publica oficial
- NAO armazenar mais de 90 dias de snapshots por produto (criar rotina de limpeza)
