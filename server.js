const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const SIZES = ['S', 'M', 'L', 'XL', 'XXL'];
const TN_TOKEN = process.env.TN_TOKEN;
const TN_STORE_ID = process.env.TN_STORE_ID;
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'dtf2024';
const WH_SECRET = process.env.WEBHOOK_SECRET || '';
const MONGO_URL = process.env.MONGO_URL;

const SKU_MAP = {
  'RN': 'remera-negra',
  'RB': 'remera-blanca',
  'BN': 'buzo-negro',
  'BV': 'buzo-verde',
  'BB': 'buzo-boxy-azul',
};

const DEFAULT_CATS = [
  { id: 'remera-negra', nombre: 'Remeras Negras', emoji: '👕', skuPrefix: 'RN' },
  { id: 'remera-blanca', nombre: 'Remeras Blancas', emoji: '👕', skuPrefix: 'RB' },
  { id: 'buzo-negro', nombre: 'Buzos Negros', emoji: '🧥', skuPrefix: 'BN' },
  { id: 'buzo-verde', nombre: 'Buzos Verdes', emoji: '🧥', skuPrefix: 'BV' },
  { id: 'buzo-boxy-azul', nombre: 'Buzos Boxy Azules', emoji: '🧥', skuPrefix: 'BB' },
];

// ─── MongoDB ──────────────────────────────────────────────────────────────────
let db = null;

async function connectDB() {
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(MONGO_URL);
  await client.connect();
  db = client.db('dtfstock');
  console.log('MongoDB conectado');
  
  // Inicializar categorías si no existen
  const cats = await db.collection('categorias').find().toArray();
  if (cats.length === 0) {
    await db.collection('categorias').insertMany(DEFAULT_CATS);
  }
  
  // Inicializar stock si no existe
  const stockDoc = await db.collection('stock').findOne({_id: 'main'});
  if (!stockDoc) {
    const initStock = {_id: 'main'};
    DEFAULT_CATS.forEach(function(c) {
      initStock[c.id] = {};
      SIZES.forEach(function(s) { initStock[c.id][s] = 0; });
    });
    await db.collection('stock').insertOne(initStock);
  }
}

async function getCategorias() {
  const cats = await db.collection('categorias').find({}, {projection: {_id: 0}}).toArray();
  cats.forEach(function(c) { if (c.skuPrefix) SKU_MAP[c.skuPrefix.toUpperCase()] = c.id; });
  return cats;
}

async function getStock() {
  const cats = await getCategorias();
  let stockDoc = await db.collection('stock').findOne({_id: 'main'});
  if (!stockDoc) stockDoc = {_id: 'main'};
  cats.forEach(function(c) {
    if (!stockDoc[c.id]) stockDoc[c.id] = {};
    SIZES.forEach(function(s) { if (stockDoc[c.id][s] === undefined) stockDoc[c.id][s] = 0; });
  });
  const stock = {};
  cats.forEach(function(c) { stock[c.id] = stockDoc[c.id]; });
  return stock;
}

async function saveStockField(categoriaId, size, qty) {
  const field = categoriaId + '.' + size;
  const update = {};
  update[field] = qty;
  await db.collection('stock').updateOne({_id: 'main'}, {$set: update}, {upsert: true});
}

async function addLog(entry) {
  entry.ts = new Date().toISOString();
  await db.collection('logs').insertOne(entry);
  // Mantener solo los últimos 100 logs
  const count = await db.collection('logs').countDocuments();
  if (count > 100) {
    const oldest = await db.collection('logs').find().sort({ts: 1}).limit(count - 100).toArray();
    const ids = oldest.map(function(d) { return d._id; });
    await db.collection('logs').deleteMany({_id: {$in: ids}});
  }
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
function auth(req, res, next) {
  if (req.headers['x-admin-password'] !== ADMIN_PASS) return res.status(401).json({ error: 'No autorizado' });
  next();
}

// ─── API Categorías ───────────────────────────────────────────────────────────
app.get('/api/categorias', auth, async function(req, res) {
  try { res.json(await getCategorias()); } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/categorias', auth, async function(req, res) {
  try {
    const nombre = req.body.nombre;
    const emoji = req.body.emoji;
    const skuPrefix = req.body.skuPrefix;
    if (!nombre || !skuPrefix) return res.status(400).json({ error: 'Faltan datos' });
    const id = nombre.toLowerCase().split(' ').join('-');
    const prefix = skuPrefix.toUpperCase();
    const existing = await db.collection('categorias').findOne({id: id});
    if (existing) return res.status(400).json({ error: 'Ya existe esa categoria' });
    const existingPrefix = await db.collection('categorias').findOne({skuPrefix: prefix});
    if (existingPrefix) return res.status(400).json({ error: 'Ese prefijo SKU ya esta en uso' });
    await db.collection('categorias').insertOne({ id: id, nombre: nombre, emoji: emoji || '📦', skuPrefix: prefix });
    await addLog({ tipo: 'config', mensaje: 'Nueva categoria: ' + nombre });
    res.json({ ok: true, categorias: await getCategorias() });
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.delete('/api/categorias/:id', auth, async function(req, res) {
  try {
    await db.collection('categorias').deleteOne({id: req.params.id});
    await addLog({ tipo: 'config', mensaje: 'Categoria eliminada: ' + req.params.id });
    res.json({ ok: true, categorias: await getCategorias() });
  } catch(e) { res.status(500).json({error: e.message}); }
});

// ─── API Stock ────────────────────────────────────────────────────────────────
app.get('/api/stock', auth, async function(req, res) {
  try { res.json({ stock: await getStock(), categorias: await getCategorias() }); }
  catch(e) { res.status(500).json({error: e.message}); }
});

app.put('/api/stock', auth, async function(req, res) {
  try {
    const categoriaId = req.body.categoriaId;
    const size = req.body.size;
    const quantity = req.body.quantity;
    if (!SIZES.includes(size) || typeof quantity !== 'number') return res.status(400).json({ error: 'Datos invalidos' });
    const qty = Math.max(0, Math.round(quantity));
    await saveStockField(categoriaId, size, qty);
    if (TN_TOKEN && TN_STORE_ID) {
      try {
        const cats = await getCategorias();
        const cat = cats.find(function(c) { return c.id === categoriaId; });
        if (cat) {
          const products = await getTNProducts();
          await updateTNVariantsBySku(cat.skuPrefix, size, qty, products);
        }
      } catch(e) { await addLog({ tipo: 'error', mensaje: 'Error sync TN: ' + e.message }); }
    }
    await addLog({ tipo: 'manual', mensaje: 'Stock ' + categoriaId + ' talle ' + size + ' actualizado a ' + qty });
    res.json({ ok: true, stock: await getStock(), categorias: await getCategorias() });
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.get('/api/logs', auth, async function(req, res) {
  try {
    const logs = await db.collection('logs').find({}, {projection: {_id: 0}}).sort({ts: -1}).limit(100).toArray();
    res.json(logs);
  } catch(e) { res.json([]); }
});

// ─── Tiendanube ───────────────────────────────────────────────────────────────
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

async function updateTNVariantsBySku(skuPrefix, size, stockQty, products) {
  for (let i = 0; i < products.length; i++) {
    const product = products[i];
    const variants = product.variants || [];
    for (let j = 0; j < variants.length; j++) {
      const variant = variants[j];
      const sku = (variant.sku || '').toUpperCase();
      if (sku !== skuPrefix + '-' + size) continue;
      await fetch(
        'https://api.tiendanube.com/v1/' + TN_STORE_ID + '/products/' + product.id + '/variants/' + variant.id,
        { method: 'PUT', headers: { 'Authentication': 'bearer ' + TN_TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ stock: stockQty }) }
      );
    }
  }
}

app.post('/api/sync', auth, async function(req, res) {
  if (!TN_TOKEN || !TN_STORE_ID) return res.status(400).json({ error: 'Falta TN_TOKEN o TN_STORE_ID' });
  try {
    const stock = await getStock();
    const cats = await getCategorias();
    const products = await getTNProducts();
    const results = [];
    for (let i = 0; i < cats.length; i++) {
      const cat = cats[i];
      for (let j = 0; j < SIZES.length; j++) {
        const size = SIZES[j];
        const qty = (stock[cat.id] && stock[cat.id][size]) || 0;
        await updateTNVariantsBySku(cat.skuPrefix, size, qty, products);
        results.push('OK ' + cat.nombre + ' ' + size + ': ' + qty);
      }
    }
    await addLog({ tipo: 'sync_manual', mensaje: 'Sync manual completo' });
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
    const cats = await getCategorias();
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
      const stockDoc = await db.collection('stock').findOne({_id: 'main'});
      const currentQty = (stockDoc && stockDoc[catId] && stockDoc[catId][size]) || 0;
      const newQty = Math.max(0, currentQty - (item.quantity || 1));
      await saveStockField(catId, size, newQty);
      await updateTNVariantsBySku(catId.replace('remera-negra','RN').replace('remera-blanca','RB').replace('buzo-negro','BN').replace('buzo-verde','BV').replace('buzo-boxy-azul','BB'), size, newQty, products);
      if (!changed[catId]) changed[catId] = [];
      if (changed[catId].indexOf(size) === -1) changed[catId].push(size);
    }
    // Usar el skuPrefix correcto desde cats
    for (let i = 0; i < cats.length; i++) {
      const cat = cats[i];
      if (!changed[cat.id]) continue;
      const stockDoc = await db.collection('stock').findOne({_id: 'main'});
      for (let j = 0; j < changed[cat.id].length; j++) {
        const size = changed[cat.id][j];
        const qty = (stockDoc && stockDoc[cat.id] && stockDoc[cat.id][size]) || 0;
        await updateTNVariantsBySku(cat.skuPrefix, size, qty, products);
      }
      await addLog({ tipo: 'webhook_pedido', mensaje: 'Pedido #' + id + ' - ' + cat.nombre + ': [' + changed[cat.id].join(', ') + ']' });
    }
  } catch(e) { await addLog({ tipo: 'error', mensaje: 'Error pedido #' + id + ': ' + e.message }); }
});

const PORT = process.env.PORT || 3000;

connectDB().then(function() {
  app.listen(PORT, function() { console.log('DTF Stock Manager en puerto ' + PORT); });
}).catch(function(e) {
  console.error('Error conectando MongoDB:', e);
  process.exit(1);
});
