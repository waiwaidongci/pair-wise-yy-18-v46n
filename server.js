const express = require('express');
const config = require('./project.config');
const db = require('./db');
const borrowService = require('./borrowService');
const borrowRoutes = require('./borrowRoutes');

const app = express();
const PORT = process.env.PORT || config.port;

app.use(express.json({ limit: '2mb' }));

function initDb() {
  db.runSql(`
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  collection TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_collection ON records(collection);
CREATE INDEX IF NOT EXISTS idx_records_status ON records(status);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT,
  actor TEXT,
  note TEXT,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_record ON events(record_id);
`);

  const count = db.select('SELECT COUNT(*) AS count FROM records;')[0].count;
  if (count > 0) return false;

  for (const seed of config.seed || []) {
    const collectionConfig = db.findCollection(seed.collection);
    const status = seed.status || collectionConfig.defaultStatus || '';
    const data = { ...seed.data, status };
    const id = db.insertRecord({
      collection: seed.collection,
      id: seed.id,
      status,
      title: db.titleFor(collectionConfig, data),
      data,
      createdAt: seed.createdAt
    });
    db.insertEvent({
      recordId: id,
      collection: seed.collection,
      action: seed.eventAction || '创建',
      status,
      actor: seed.actor || 'system',
      note: seed.note || '',
      data
    });
  }
  return true;
}

// 演示用未结借单：便于验证“再借拦截并指向原单”
function seedBorrowDemo() {
  if (!db.loadRecord('puppetHeads', 'head-seed-2')) return;
  const expectedReturnDate = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  borrowService.openBorrowOrder({
    troupe: '邻县木偶剧团',
    headIds: ['head-seed-2'],
    accessoryIds: ['accessory-seed-1'],
    expectedReturnDate,
    actor: 'system',
    note: '演示用未结借单'
  });
}

function applyQuery(records, query) {
  return records.filter((record) => {
    if (query.status && record.status !== query.status) return false;
    if (query.search) {
      const haystack = JSON.stringify(record).toLowerCase();
      if (!haystack.includes(String(query.search).toLowerCase())) return false;
    }
    for (const [key, value] of Object.entries(query)) {
      if (['status', 'search', 'limit'].includes(key)) continue;
      if (record[key] === undefined) return false;
      if (!String(record[key]).toLowerCase().includes(String(value).toLowerCase())) return false;
    }
    return true;
  });
}

app.get('/health', (req, res) => {
  res.json({ ok: true, service: config.title, port: PORT });
});

app.get('/api/meta', (req, res) => {
  res.json({
    title: config.title,
    description: config.description,
    collections: config.collections,
    borrow: {
      list: 'GET /api/borrow/orders',
      open: 'POST /api/borrow/orders',
      accept: 'POST /api/borrow/orders/:id/return',
      repairDone: 'POST /api/borrow/orders/:id/repair-done',
      reschedule: 'PATCH /api/borrow/orders/:id/expected-return',
      checks: 'GET /api/borrow/checks?orderId='
    },
    examples: config.examples || []
  });
});

// 外团借还验收：入口独立挂载在通用 CRUD 之前，写操作不被通用接口绕过
app.use('/api/borrow', borrowRoutes);

app.get('/api/:collection', (req, res, next) => {
  try {
    db.findCollection(req.params.collection);
    const rows = db.listRecords(req.params.collection);
    const filtered = applyQuery(rows, req.query);
    const limit = Number(req.query.limit || 0);
    res.json(limit > 0 ? filtered.slice(0, limit) : filtered);
  } catch (error) {
    next(error);
  }
});

app.post('/api/:collection', (req, res, next) => {
  try {
    const collectionConfig = db.findCollection(req.params.collection);
    const data = { ...collectionConfig.defaults, ...req.body };
    const status = data.status || collectionConfig.defaultStatus || '';
    data.status = status;
    db.validate(collectionConfig, data);
    const id = db.insertRecord({
      collection: req.params.collection,
      status,
      title: db.titleFor(collectionConfig, data),
      data
    });
    db.insertEvent({
      recordId: id,
      collection: req.params.collection,
      action: req.body.action || '创建',
      status,
      actor: req.body.actor || '',
      note: req.body.note || '',
      data
    });
    res.status(201).json(db.loadRecord(req.params.collection, id));
  } catch (error) {
    next(error);
  }
});

app.get('/api/:collection/:id', (req, res, next) => {
  try {
    db.findCollection(req.params.collection);
    const record = db.loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    res.json(record);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/:collection/:id', (req, res, next) => {
  try {
    db.findCollection(req.params.collection);
    const record = db.loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const nextData = { ...record, ...req.body };
    delete nextData.id;
    delete nextData.collection;
    delete nextData.createdAt;
    delete nextData.updatedAt;
    const status = nextData.status || record.status;
    nextData.status = status;
    db.saveRecord(req.params.collection, req.params.id, nextData, status);
    db.insertEvent({
      recordId: req.params.id,
      collection: req.params.collection,
      action: req.body.action || '更新',
      status,
      actor: req.body.actor || '',
      note: req.body.note || '',
      data: req.body
    });
    res.json(db.loadRecord(req.params.collection, req.params.id));
  } catch (error) {
    next(error);
  }
});

app.post('/api/:collection/:id/events', (req, res, next) => {
  try {
    const collectionConfig = db.findCollection(req.params.collection);
    const record = db.loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const status = req.body.status || record.status;
    if (collectionConfig.statuses && !collectionConfig.statuses.includes(status)) {
      return res.status(400).json({ error: 'invalid status: ' + status });
    }
    const nextData = { ...record, ...(req.body.fields || {}), status };
    delete nextData.id;
    delete nextData.collection;
    delete nextData.createdAt;
    delete nextData.updatedAt;
    db.saveRecord(req.params.collection, req.params.id, nextData, status);
    db.insertEvent({
      recordId: req.params.id,
      collection: req.params.collection,
      action: req.body.action || status || '记录',
      status,
      actor: req.body.actor || '',
      note: req.body.note || '',
      data: req.body
    });
    res.json(db.loadRecord(req.params.collection, req.params.id));
  } catch (error) {
    next(error);
  }
});

app.get('/api/:collection/:id/timeline', (req, res, next) => {
  try {
    db.findCollection(req.params.collection);
    const record = db.loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    res.json({ record, events: db.listEvents(req.params.id) });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/:collection/:id', (req, res, next) => {
  try {
    db.findCollection(req.params.collection);
    db.runSql('DELETE FROM records WHERE collection = ' + db.sqlValue(req.params.collection) + ' AND id = ' + db.sqlValue(req.params.id) + ';');
    db.runSql('DELETE FROM events WHERE record_id = ' + db.sqlValue(req.params.id) + ';');
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  res.status(error.status || 500).json({ error: error.message || 'server error' });
});

db.init().then(() => {
  if (initDb()) seedBorrowDemo();
  app.listen(PORT, () => {
    console.log(config.title + ' API running at http://localhost:' + PORT);
  });
}).catch((error) => {
  console.error('failed to init database:', error);
  process.exit(1);
});
