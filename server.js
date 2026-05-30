const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Configuración ──────────────────────────────────────────────────────────
const SIZES = ['S', 'M', 'L', 'XL', 'XXL', 'XXXL'];
const STOCK_FILE = path.join(__dirname, 'stock.json');
const LOG_FILE = path.join(__dirname, 'log.json');

const TN_TOKEN    = process.env.TN_TOKEN;
const TN_STORE_ID = process.env.TN_STORE_ID;
const ADMIN_PASS  = process.env.ADMIN_PASSWORD || 'dtf2024';
const WH_SECRET   = process.env.WEBHOOK_SECRET || '';

// ─── Helpers de persistencia ────────────────────────────────────────────────
function getStock() {
  if (!fs.existsSync(STOCK_FILE)) {
    const init = {};
    SIZES.forEach(s => init[s] = 0);
    fs.writeFileSync(STOCK_FILE, JSON.stringify(init, null, 2));
    return init;
  }
  return JSON.parse(fs.readFileSync(STOCK_FILE, 'utf8'));
}

function saveStock(stock) {
  fs.writeFileSync(STOCK_FILE, JSON.stringify(stock, null, 2));
}

function addLog(entry) {
  let logs = [];
  if (fs.existsSync(LOG_FILE)) {
    try { logs = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch {}
  }
  logs.unshift({ ...entry, ts: new Date().toISOString() });
  if (logs.length > 100) logs = logs.slice(0, 100);
  fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
}

// ─── Middleware de autenticación para el panel ───────────────────────────────
function auth(req, res, next) {
  const pass = req.headers['x-admin-password'];
  if (pass !== ADMIN_PASS) return res.status(401).json({ error: 'No autorizado' });
  next();
}

// ─── API del panel de gestión ───────────────────────────────────────────────
app.get('/api/stock', auth, (req, res) => {
  res.json(getStock());
});

app.put('/api/stock', auth, (req, res) => {
  const { size, quantity } = req.body;
  if (!SIZES.includes(size) || typeof quantity !== 'number') {
    return res.status(400).json({ error: 'Datos inválidos' });
  }
  const stock = getStock();
  stock[size] = Math.max(0, Math.round(quantity));
  saveStock(stock);
  addLog({ tipo: 'manual', mensaje: `Stock de talle ${size} actualizado a ${stock[size]}` });
  res.json({ ok: true, stock });
});

app.get('/api/logs', auth, (req, res) => {
  if (!fs.existsSync(LOG_FILE)) return res.json([]);
  try { res.json(JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'))); }
  catch { res.json([]); }
});

// ─── Tiendanube: cerrar talles en 0 en todos los lisos ──────────────────────
async function getTNProducts() {
  let allProducts = [];
  let page = 1;
  while (true) {
    const res = await fetch(
      `https://api.tiendanube.com/v1/${TN_STORE_ID}/products?per_page=50&page=${page}&fields=id,name,variants`,
      { headers: { 'Authentication': `bearer ${TN_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    if (!res.ok) throw new Error(`Error Tiendanube API: ${res.status}`);
    const data = await res.json();
    allProducts = [...allProducts, ...data];
    if (data.length < 50) break;
    page++;
  }
  return allProducts;
}

async function closeSizesOnTiendanube(sizes) {
  const products = await getTNProducts();
  const lisos = products.filter(p => {
    const tags = (p.tags || '').toLowerCase();
    return tags.includes('dtf');
  });

  const results = [];
  for (const product of lisos) {
    const productName = product.name?.es || product.name?.en || `#${product.id}`;
    for (const variant of product.variants || []) {
      const val = (variant.values || []).find(v =>
        sizes.includes((v.es || v.en || '').toUpperCase())
      );
      if (!val) continue;
      const size = (val.es || val.en).toUpperCase();

      try {
        await fetch(
          `https://api.tiendanube.com/v1/${TN_STORE_ID}/products/${product.id}/variants/${variant.id}`,
          {
            method: 'PUT',
            headers: { 'Authentication': `bearer ${TN_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ stock: 0 })
          }
        );
        results.push(`✓ ${productName} · talle ${size} cerrado`);
      } catch (e) {
        results.push(`✗ Error en ${productName} · ${size}: ${e.message}`);
      }
    }
  }
  return results;
}

// ─── Sincronización manual ────────────────────────────────────────────────────
app.post('/api/sync', auth, async (req, res) => {
  if (!TN_TOKEN || !TN_STORE_ID) {
    return res.status(400).json({ error: 'Configurá TN_TOKEN y TN_STORE_ID en las variables de entorno' });
  }
  try {
    const stock = getStock();
    const zeroSizes = SIZES.filter(s => stock[s] === 0);
    let results = [];
    if (zeroSizes.length === 0) {
      results = ['No hay talles en 0 — todo en orden'];
    } else {
      results = await closeSizesOnTiendanube(zeroSizes);
    }
    addLog({ tipo: 'sync_manual', mensaje: `Sync manual — talles en 0: [${zeroSizes.join(', ')}]`, resultados: results });
    res.json({ ok: true, closedSizes: zeroSizes, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Webhook de Tiendanube ────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  // Verificar secret si está configurado
  if (WH_SECRET) {
    const sig = req.headers['x-linkedstore-token'];
    if (sig !== WH_SECRET) return res.status(401).json({ error: 'Token inválido' });
  }

  const { event, id } = req.body;
  res.json({ ok: true }); // Responder rápido a Tiendanube

  if (event !== 'order/paid') return;

  try {
    // Obtener detalle del pedido
    const orderRes = await fetch(
      `https://api.tiendanube.com/v1/${TN_STORE_ID}/orders/${id}`,
      { headers: { 'Authentication': `bearer ${TN_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    const order = await orderRes.json();

    const stock = getStock();
    const changedSizes = new Set();

    for (const item of order.products || []) {
      const tags = (item.tags || '').toLowerCase();
      if (!tags.includes('dtf')) continue; // Solo descuenta productos con etiqueta "dtf"

      const sizeVal = (item.variant?.values || []).find(v =>
        SIZES.includes((v.es || v.en || '').toUpperCase())
      );
      if (!sizeVal) continue;

      const size = (sizeVal.es || sizeVal.en).toUpperCase();
      if (!SIZES.includes(size)) continue;

      stock[size] = Math.max(0, (stock[size] || 0) - (item.quantity || 1));
      changedSizes.add(size);
    }

    saveStock(stock);

    const zeroSizes = [...changedSizes].filter(s => stock[s] === 0);
    let syncResults = [];
    if (zeroSizes.length > 0) {
      syncResults = await closeSizesOnTiendanube(zeroSizes);
      addLog({
        tipo: 'webhook_pedido',
        mensaje: `Pedido #${id} — talles descontados: [${[...changedSizes].join(', ')}] — cerrados en TN: [${zeroSizes.join(', ')}]`,
        resultados: syncResults
      });
    } else {
      addLog({
        tipo: 'webhook_pedido',
        mensaje: `Pedido #${id} — talles descontados: [${[...changedSizes].join(', ')}]`
      });
    }
  } catch (e) {
    addLog({ tipo: 'error', mensaje: `Error procesando pedido #${id}: ${e.message}` });
    console.error('Webhook error:', e);
  }
});

// ─── Inicio del servidor ──────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ DTF Stock Manager corriendo en puerto ${PORT}`);
  console.log(`   Panel: http://localhost:${PORT}`);
  console.log(`   Webhook URL: http://localhost:${PORT}/webhook`);
});
