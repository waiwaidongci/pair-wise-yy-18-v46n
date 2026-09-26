const express = require('express');
const config = require('./project.config');
const db = require('./lib/db');
const loanRoutes = require('./routes/loanRoutes');

const app = express();
const PORT = process.env.PORT || config.port;

app.use(express.json({ limit: '2mb' }));

app.get('/health', (req, res) => {
  res.json({ ok: true, service: config.title, port: PORT });
});

app.get('/api/meta', (req, res) => {
  res.json({
    title: config.title,
    description: config.description,
    collections: config.collections,
    examples: config.examples || []
  });
});

// 借还专项路由必须在通用 /:collection 之前注册
app.use('/api/loans', loanRoutes);

app.get('/api/:collection', (req, res, next) => {
  try {
    db.findCollection(req.params.collection);
    let rows = db.listRecords(req.params.collection);
    if (req.params.collection === 'loans') rows = refreshOverdue(rows);
    const filtered = applyQuery(rows, req.query);
    const limit = Number(req.query.limit || 0);
    res.json(limit > 0 ? filtered.slice(0, limit) : filtered);
  } catch (error) {
    next(error);
  }
});

// 读取时刷新逾期：出借中且过了预计归还日 -> 已逾期（仍然占用）
function refreshOverdue(loans) {
  const todayStr = db.today();
  return loans.map((loan) => {
    if (loan.status === '出借中' && loan.expectedReturnDate && loan.expectedReturnDate < todayStr) {
      return { ...loan, status: '已逾期' };
    }
    return loan;
  });
}

// 借还业务集合只能走专项端点，通用写入口（甚至删除）一律挡住，
// 保证占用拦截、逐项验收、旧单留档等规则不被绕过
const LOAN_COLLECTIONS = ['loans', 'loanAcceptances'];

app.post('/api/:collection', (req, res, next) => {
  try {
    if (LOAN_COLLECTIONS.includes(req.params.collection)) {
      return res.status(405).json({
        error: '借还记录请走专项端点：POST /api/loans（开单）、/api/loans/:id/return（验收）等'
      });
    }
    const collectionConfig = db.findCollection(req.params.collection);
    const data = { ...collectionConfig.defaults, ...req.body };
    const status = data.status || collectionConfig.defaultStatus || '';
    const record = db.insertRecord(req.params.collection, data, {
      status,
      action: req.body.action || '创建',
      actor: req.body.actor || '',
      note: req.body.note || ''
    });
    res.status(201).json(record);
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
    if (LOAN_COLLECTIONS.includes(req.params.collection)) {
      return res.status(405).json({
        error: req.params.collection === 'loans'
          ? '借单变更请走 /api/loans/:id/expected-return（改期）、/return（验收）等专项端点'
          : '验收单只追加不改写，请通过归还/复验端点新开验收单（旧单留档）'
      });
    }
    db.findCollection(req.params.collection);
    const record = db.loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const nextData = { ...record, ...req.body };
    delete nextData.id;
    delete nextData.collection;
    delete nextData.createdAt;
    delete nextData.updatedAt;
    const status = nextData.status || record.status;
    const updated = db.saveRecord(req.params.collection, req.params.id, nextData, status, {
      action: req.body.action || '更新',
      actor: req.body.actor || '',
      note: req.body.note || '',
      data: req.body
    });
    res.json(updated);
  } catch (error) {
    next(error);
  }
});

app.post('/api/:collection/:id/events', (req, res, next) => {
  try {
    if (LOAN_COLLECTIONS.includes(req.params.collection)) {
      return res.status(405).json({ error: '借还状态流转请走借还专项端点' });
    }
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
    const updated = db.saveRecord(req.params.collection, req.params.id, nextData, status, {
      action: req.body.action || status || '记录',
      actor: req.body.actor || '',
      note: req.body.note || '',
      data: req.body
    });
    res.json(updated);
  } catch (error) {
    next(error);
  }
});

app.get('/api/:collection/:id/timeline', (req, res, next) => {
  try {
    db.findCollection(req.params.collection);
    const record = db.loadRecord(req.params.collection, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    const events = db.select(
      'SELECT * FROM events WHERE record_id = ? ORDER BY created_at ASC;',
      [req.params.id]
    ).map((event) => ({
      id: event.id,
      action: event.action,
      status: event.status,
      actor: event.actor,
      note: event.note,
      data: JSON.parse(event.data || '{}'),
      createdAt: event.created_at
    }));
    res.json({ record, events });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/:collection/:id', (req, res, next) => {
  try {
    if (LOAN_COLLECTIONS.includes(req.params.collection)) {
      return res.status(405).json({ error: '借单与验收单须长期留档，不允许删除' });
    }
    db.findCollection(req.params.collection);
    db.run('DELETE FROM records WHERE collection = ? AND id = ?;', [
      req.params.collection,
      req.params.id
    ]);
    db.run('DELETE FROM events WHERE record_id = ?;', [req.params.id]);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

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

app.use((error, req, res, next) => {
  const body = { error: error.message || 'server error' };
  if (error.code) body.code = error.code;
  for (const key of ['blocked', 'conflicts', 'missingHeadIds', 'missingAccessoryIds']) {
    if (error[key]) body[key] = error[key];
  }
  res.status(error.status || 500).json(body);
});

db.init().then(() => {
  app.listen(PORT, () => {
    console.log(config.title + ' API running at http://localhost:' + PORT);
  });
}).catch((error) => {
  console.error('启动失败：', error);
  process.exit(1);
});
