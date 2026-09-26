const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const initSqlJs = require('sql.js');
const config = require('./project.config');

const DATA_DIR = path.join(__dirname, 'data');
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
}

function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, Buffer.from(db.export()));
}

function sqlValue(value) {
  if (value === null || value === undefined) return 'NULL';
  return "'" + String(value).replaceAll("'", "''") + "'";
}

function runSql(sql) {
  db.exec(sql);
  persist();
}

function select(sql) {
  const stmt = db.prepare(sql);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function now() {
  return new Date().toISOString();
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
  const missing = (collectionConfig.required || []).filter((field) => data[field] === undefined || data[field] === '');
  if (missing.length) {
    const error = new Error('missing required fields: ' + missing.join(', '));
    error.status = 400;
    throw error;
  }
}

function insertEvent({ recordId, collection, action, status, actor, note, data }) {
  runSql(
    'INSERT INTO events (id, record_id, collection, action, status, actor, note, data, created_at) VALUES (' +
    [
      sqlValue(randomUUID()),
      sqlValue(recordId),
      sqlValue(collection),
      sqlValue(action || '记录'),
      sqlValue(status || ''),
      sqlValue(actor || ''),
      sqlValue(note || ''),
      sqlValue(JSON.stringify(data || {})),
      sqlValue(now())
    ].join(', ') +
    ');'
  );
}

function insertRecord({ collection, id, status, title, data, createdAt }) {
  const recordId = id || randomUUID();
  const ts = createdAt || now();
  runSql(
    'INSERT INTO records (id, collection, status, title, data, created_at, updated_at) VALUES (' +
    [
      sqlValue(recordId),
      sqlValue(collection),
      sqlValue(status),
      sqlValue(title || ''),
      sqlValue(JSON.stringify(data)),
      sqlValue(ts),
      sqlValue(ts)
    ].join(', ') +
    ');'
  );
  return recordId;
}

function updateRecord(collection, id, { status, title, data }) {
  runSql(
    'UPDATE records SET status = ' + sqlValue(status) +
    ', title = ' + sqlValue(title || '') +
    ', data = ' + sqlValue(JSON.stringify(data)) +
    ', updated_at = ' + sqlValue(now()) +
    ' WHERE collection = ' + sqlValue(collection) + ' AND id = ' + sqlValue(id) + ';'
  );
}

function loadRecord(collection, id) {
  const rows = select(
    'SELECT * FROM records WHERE collection = ' + sqlValue(collection) + ' AND id = ' + sqlValue(id) + ' LIMIT 1;'
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

function listRecords(collection) {
  return select(
    'SELECT * FROM records WHERE collection = ' + sqlValue(collection) + ' ORDER BY updated_at DESC;'
  ).map(toRecord);
}

function saveRecord(collection, id, data, status) {
  const collectionConfig = findCollection(collection);
  updateRecord(collection, id, { status, title: titleFor(collectionConfig, data), data });
}

function listEvents(recordId) {
  return select(
    'SELECT * FROM events WHERE record_id = ' + sqlValue(recordId) + ' ORDER BY created_at ASC;'
  ).map((event) => ({
    id: event.id,
    action: event.action,
    status: event.status,
    actor: event.actor,
    note: event.note,
    data: JSON.parse(event.data || '{}'),
    createdAt: event.created_at
  }));
}

module.exports = {
  DATA_DIR,
  DB_FILE,
  init,
  sqlValue,
  runSql,
  select,
  now,
  toRecord,
  findCollection,
  titleFor,
  validate,
  insertEvent,
  insertRecord,
  updateRecord,
  loadRecord,
  listRecords,
  saveRecord,
  listEvents
};
