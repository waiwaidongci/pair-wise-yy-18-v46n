const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { randomUUID } = require('crypto');
const config = require('../project.config');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'app.db');

let db = null;

async function init() {
  const SQL = await initSqlJs();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    db = new SQL.Database(fs.readFileSync(DB_FILE));
  } else {
    db = new SQL.Database();
  }
  initSchema();
  seedIfEmpty();
}

function getDb() {
  if (!db) throw new Error('数据库尚未初始化');
  return db;
}

function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, Buffer.from(getDb().export()));
}

function run(sql, params = []) {
  getDb().run(sql, params);
  persist();
}

function select(sql, params = []) {
  const result = getDb().exec(sql, params);
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map((row) => {
    const record = {};
    columns.forEach((column, index) => {
      record[column] = row[index];
    });
    return record;
  });
}

function one(sql, params = []) {
  return select(sql, params)[0] || null;
}

function withTransaction(work) {
  run('BEGIN;');
  try {
    const result = work();
    run('COMMIT;');
    return result;
  } catch (error) {
    run('ROLLBACK;');
    throw error;
  }
}

function now() {
  return new Date().toISOString();
}

function today() {
  return now().slice(0, 10);
}

function isDateString(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function toRecord(row) {
  const data = JSON.parse(row.data || '{}');
  return {
    id: row.id,
    collection: row.collection,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...data
  };
}

function findCollection(name) {
  const collection = config.collections[name];
  if (!collection) {
    const error = new Error('unknown collection: ' + name);
    error.status = 404;
    throw error;
  }
  return collection;
}

function titleFor(collectionConfig, data) {
  return (collectionConfig.titleFields || [])
    .map((field) => data[field])
    .filter(Boolean)
    .join(' / ') || data.name || data.title || data.code || '';
}

function validate(collectionConfig, data) {
  const missing = (collectionConfig.required || []).filter(
    (field) => data[field] === undefined || data[field] === null || data[field] === ''
  );
  if (missing.length) {
    const error = new Error('missing required fields: ' + missing.join(', '));
    error.status = 400;
    throw error;
  }
}

function insertEvent({ recordId, collection, action, status, actor, note, data }) {
  run(
    `INSERT INTO events (id, record_id, collection, action, status, actor, note, data, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      randomUUID(),
      recordId,
      collection,
      action || '记录',
      status || '',
      actor || '',
      note || '',
      JSON.stringify(data || {}),
      now()
    ]
  );
}

function insertRecord(collection, input = {}, options = {}) {
  const collectionConfig = findCollection(collection);
  const data = { ...input };
  const status = options.status || data.status || collectionConfig.defaultStatus || '';
  data.status = status;
  validate(collectionConfig, data);
  const id = options.id || randomUUID();
  const createdAt = options.createdAt || now();
  run(
    `INSERT INTO records (id, collection, status, title, data, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?);`,
    [
      id,
      collection,
      status,
      titleFor(collectionConfig, data),
      JSON.stringify(data),
      createdAt,
      options.updatedAt || createdAt
    ]
  );
  insertEvent({
    recordId: id,
    collection,
    action: options.action || '创建',
    status,
    actor: options.actor || '',
    note: options.note || '',
    data
  });
  return loadRecord(collection, id);
}

function loadRecord(collection, id) {
  const row = one(
    'SELECT * FROM records WHERE collection = ? AND id = ? LIMIT 1;',
    [collection, id]
  );
  return row ? toRecord(row) : null;
}

function listRecords(collection) {
  return select(
    'SELECT * FROM records WHERE collection = ? ORDER BY updated_at DESC;',
    [collection]
  ).map(toRecord);
}

function saveRecord(collection, id, data, status, event) {
  const collectionConfig = findCollection(collection);
  const nextStatus = status || data.status || collectionConfig.defaultStatus || '';
  data.status = nextStatus;
  run(
    `UPDATE records
       SET status = ?, title = ?, data = ?, updated_at = ?
     WHERE collection = ? AND id = ?;`,
    [
      nextStatus,
      titleFor(collectionConfig, data),
      JSON.stringify(data),
      now(),
      collection,
      id
    ]
  );
  if (event) {
    insertEvent({
      recordId: id,
      collection,
      action: event.action || '更新',
      status: nextStatus,
      actor: event.actor || '',
      note: event.note || '',
      data: event.data || data
    });
  }
  return loadRecord(collection, id);
}

function runMany(statements) {
  for (const statement of statements) {
    const trimmed = statement.trim();
    if (trimmed) getDb().run(trimmed);
  }
  persist();
}

function initSchema() {
  runMany([
    `CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  collection TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`,
    'CREATE INDEX IF NOT EXISTS idx_records_collection ON records(collection);',
    'CREATE INDEX IF NOT EXISTS idx_records_status ON records(status);',
    `CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT,
  actor TEXT,
  note TEXT,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);`,
    'CREATE INDEX IF NOT EXISTS idx_events_record ON events(record_id);'
  ]);
}

function seedIfEmpty() {
  const count = one('SELECT COUNT(*) AS count FROM records;').count;
  if (count > 0) return;

  for (const seed of config.seed || []) {
    const collectionConfig = findCollection(seed.collection);
    const createdAt = seed.createdAt || now();
    const status = seed.status || collectionConfig.defaultStatus || '';
    insertRecord(
      seed.collection,
      { ...seed.data, status },
      {
        id: seed.id,
        status,
        createdAt,
        updatedAt: seed.updatedAt || createdAt,
        action: seed.eventAction || '创建',
        actor: seed.actor || 'system',
        note: seed.note || ''
      }
    );
  }
}

module.exports = {
  DB_FILE,
  init,
  run,
  select,
  one,
  withTransaction,
  now,
  today,
  isDateString,
  toRecord,
  findCollection,
  titleFor,
  validate,
  insertEvent,
  insertRecord,
  loadRecord,
  listRecords,
  saveRecord
};
