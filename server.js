const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const SIZES = ['S', 'M', 'L', 'XL', 'XXL'];
const STOCK_FILE = path.join(__dirname, 'stock.json');
const LOG_FILE = path.join(__dirname, 'log.json');
const CATS_FILE = path.join(__dirname, 'categorias.json');

const TN_TOKEN = process.env.TN_TOKEN;
const TN_STORE_ID = process.env.TN_STORE_ID;
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'dtf2024';
const WH_SECRET = process.env.WEBHOOK_SECRET || '';

const SKU_MAP = {
  'RN': 'remera-negra',
  'RB': 'remera-blanca',
  'BN': 'buzo-negro',
  'BV': 'buzo-verde',
  'BB': 'buzo-boxy-azul',
};

function getCatFromSku(sku) {
  if (!sku) return null;
  const parts = sku.split('-');
  return SKU_MAP[parts[0].toUpperCase()] || null;
}

function getSizeFromSku(sku) {
  if (!sku) return null;
  const parts = sku.split('-');
  if (parts.length < 2) return null;
  return parts[1].toUpperCase();
}

const DEFAULT_CATS = [
  { id: 'remera-negra', nombre: 'Remeras Negras', emoji: '👕', skuPrefix: 'RN' },
  { id: 'remera-blanca', nombre: 'Remeras Blancas', emoji: '👕', skuPrefix: 'RB' },
  { id: 'buzo-negro', nombre: 'Buzos Negros', emoji: '🧥', skuPrefix: 'BN' },
  { id: 'buzo-verde', nombre: 'Buzos Verdes', emoji: '🧥', skuPrefix: 'BV' },
  { id: 'buzo-boxy-azul', nombre: 'Buzos Boxy Azules', emoji: '🧥', skuPrefix: 'BB' },
];

function getCategorias() {
  if (!fs.existsSync(CATS_FILE)) {
    fs.writeFileSync(CATS_FILE, JSON.stringify(DEFAULT_CATS, null, 2));
    return DEFAULT_CATS;
  }
  return JSON.parse(fs.readFileSync(CATS_FILE, 'utf8'));
}

function saveCategorias(cats) {
  fs.writeFileSync(CATS_FILE, JSON.stringify(cats, null, 2));
  cats.forEach(function(c) { if (c.skuPrefix) SKU_MAP[c.skuPrefix.toUpperCase()] = c.id; });
}

function getStock() {
  const cats = getCategorias();
  let stock = {};
  if (fs.existsSync(STOCK_FILE)) {
    try { stock = JSON.parse(fs.readFileSync(STOCK_FILE, 'utf8')); } catch(e) {}
  }
  cats.forEach(function(c) {
    if (!stock[c.id]) stock[c.id] = {};
    SIZES.forEach(function(s) { if (stock[c.id][s] === undefined) stock[c.id][s] = 0; });
  });
  return stock;
}

function saveStock(stock) {
  fs.writeFileSync(STOCK_FILE, JSON.stringify(stock, null, 2));
}

function addLog(entry) {
  let logs = [];
  if (fs.existsSync(LOG_FILE)) {
    try { logs = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch(e) {}
  }
  logs.unshift(Object.assign({}, entry, { ts: new Date().toISOString() }));
  if (logs.length > 100) logs = logs.slice(0, 100);
  fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
}

function auth(req, res, next) {
  if (req.headers['x-admin-password'] !== ADMIN_PASS) return res.status(401).json({ error: 'No autorizado' });
  next();
}

app.get('/api/categorias', auth, function(req, res) { res.json(getCategorias()); });

app.post('/api/categorias', auth, function(req, res) {
  const nombre = req.body.nombre;
  const emoji = req.body.emoji;
  const skuPrefix = req.body.skuPrefix;
  if (!nombre || !skuPrefix) return res.status(400).json({ error: 'Faltan datos' });
  const cats = getCategorias();
  const id = nombre.toLowerCase().split(' ').join('-');
  const prefix = skuPrefix.toUpperCase();
  if (cats.find(function(c) { return c.id === id; })) return res.status(400).json({ error: 'Ya existe esa categoria' });
  if (cats.find(function(c) { return c.skuPrefix === prefix; })) return res.status(400).json({ error: 'Ese prefijo SKU ya esta en uso' });
  cats.push({ id: id, nombre: nombre, emoji: emoji || '📦', skuPrefix: prefix });
  saveCategorias(cats);
  addLog({ tipo: 'config', mensaje: 'Nueva categoria: ' + nombre });
  res.json({ ok: true, categorias: cats });
});

app.delete('/api/categorias/:id', auth, function(req, res) {
  let cats = getCategorias();
  cats = cats.filter(function(c) { return c.id !== req.params.id; });
  saveCategorias(cats);
  addLog({ tipo: 'config', mensaje: 'Categoria eliminada: ' + req.params.id });
  res.json({ ok: true, categorias: cats });
});

app.get('/api/stock', auth, function(req, res) {
  res.json({ stock: getStock(), categorias: getCategorias() });
});

app.put('/api/stock', auth, function(req, res) {
  const categoriaId = req.body.categoriaId;
  const size = req.body.size;
  const quantity = req.body.quantity;
  if (!SIZES.includes(size) || typeof quantity !== 'number') return res.status(400).json({ error: 'Datos invalidos' });
  const stock = getStock();
  if (!stock[categoriaId]) stock[categoriaId] = {};
  stock[categoriaId][size] = Math.max(0, Math.round(quantity));
  saveStock(stock);
  addLog({ tipo: 'manual', mensaje: 'Stock ' + categoriaId + ' talle ' + size + ' actualizado a ' + stock[categoriaId][size] });
  res.json({ ok: true, stock: stock, categorias: getCategorias() });
});

app.get('/api/logs', auth, function(req, res) {
  if (!fs.existsSync(LOG_FILE)) return res.json([]);
  try { res.json(JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'))); } catch(e) { res.json([]); }
});

async function getTNProducts() {
  let all = [];
  let page = 1;
  while (true) {
    const r = await fetch(
      'https://api.tiendanube.com/v1/' + TN_STORE_ID + '/products?per_page=50&page=' + page + '&fields=id,name,variants',
      { headers: { 'Authentication': 'bearer ' + TN_TOKEN, 'Content-Type': 'application/json' } }
    );
    if (!r.ok) throw new Error('Error API: ' + r.status);
    const d = await r.json();
    all = all.concat(d);
    if (d.length < 50) break;
    page++;
  }
  return all;
}

async function closeSizesBySku(skuPrefix, sizes, products) {
  const results = [];
  for (let i = 0; i < products.length; i++) {
    const product = products[i];
    const name = (product.name && product.name.es) || (product.name && product.name.en) || '#' + product.id;
    const variants = product.variants || [];
    for (let j = 0; j < variants.length; j++) {
      const variant = variants[j];
      const sku = (variant.sku || '').toUpperCase();
      if (sku.indexOf(skuPrefix + '-') !== 0) continue;
      const size = getSizeFromSku(sku);
      if (!size || !sizes.includes(size)) continue;
      try {
        await fetch(
          'https://api.tiendanube.com/v1/' + TN_STORE_ID + '/products/' + product.id + '/variants/' + variant.id,
          { method: 'PUT', headers: { 'Authentication': 'bearer ' + TN_TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify({ stock: 0 }) }
        );
        results.push('✓ ' + name + ' · ' + size + ' cerrado');
      } catch(e) {
        results.push('✗ Error ' + name + ' · ' + size);
      }
    }
  }
  return results;
}

app.post('/api/sync', auth, async function(req, res) {
  if (!TN_TOKEN || !TN_STORE_ID) return res.status(400).json({ error: 'Falta TN_TOKEN o TN_STORE_ID' });
  try {
    const stock = getStock();
    const cats = getCategorias();
    const products = await getTNProducts();
    const results = [];
    for (let i = 0; i < cats.length; i++) {
      const cat = cats[i];
      const zeroSizes = SIZES.filter(function(s) { return (stock[cat.id] && stock[cat.id][s] || 0) === 0; });
      if (zeroSizes.length > 0) {
        const r = await closeSizesBySku(cat.skuPrefix, zeroSizes, products);
        results.push.apply(results, r);
      }
    }
    if (results.length === 0) results.push('No hay talles en 0 - todo en orden');
    addLog({ tipo: 'sync_manual', mensaje: 'Sync manual', resultados: results });
    res.json({ ok: true, results: results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/webhook', async function(req, res) {
  if (WH_SECRET && req.headers['x-linkedstore-token'] !== WH_SECRET) return res.status(401).json({ error: 'Token invalido' });
  const event = req.body.event;
  const id = req.body.id;
  res.json({ ok: true });
  if (event !== 'order/paid') return;
  try {
    const orderRes = await fetch(
      'https://api.tiendanube.com/v1/' + TN_STORE_ID + '/orders/' + id,
      { headers: { 'Authentication': 'bearer ' + TN_TOKEN, 'Content-Type': 'application/json' } }
    );
    const order = await orderRes.json();
    const stock = getStock();
    const cats = getCategorias();
    const products = await getTNProducts();
    const changed = {};
    const orderProducts = order.products || [];
    for (let i = 0; i < orderProducts.length; i++) {
      const item = orderProducts[i];
      const sku = ((item.variant && item.variant.sku) || '').toUpperCase();
      if (!sku) continue;
      const catId = getCatFromSku(sku);
      const size = getSizeFromSku(sku);
      if (!catId || !size || !SIZES.includes(size)) continue;
      if (!stock[catId]) stock[catId] = {};
      stock[catId][size] = Math.max(0, (stock[catId][size] || 0) - (item.quantity || 1));
      if (!changed[catId]) changed[catId] = [];
      if (changed[catId].indexOf(size) === -1) changed[catId].push(size);
    }
    saveStock(stock);
    for (let i = 0; i < cats.length; i++) {
      const cat = cats[i];
      if (!changed[cat.id]) continue;
      const zeroSizes = changed[cat.id].filter(function(s) { return stock[cat.id][s] === 0; });
      if (zeroSizes.length > 0) {
        const r = await closeSizesBySku(cat.skuPrefix, zeroSizes, products);
        addLog({ tipo: 'webhook_pedido', mensaje: 'Pedido #' + id + ' - ' + cat.nombre + ' cerrados: [' + zeroSizes.join(', ') + ']', resultados: r });
      } else {
        addLog({ tipo: 'webhook_pedido', mensaje: 'Pedido #' + id + ' - ' + cat.nombre + ' descontados: [' + changed[cat.id].join(', ') + ']' });
      }
    }
  } catch(e) { addLog({ tipo: 'error', mensaje: 'Error pedido #' + id + ': ' + e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log('DTF Stock Manager en puerto ' + PORT); });
