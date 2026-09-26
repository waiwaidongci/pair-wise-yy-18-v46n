const db = require('./db');

// 外团借还验收的记录保存层：借还单、验收单、物品状态与事件日志的读写都收口在这里。
// borrowOrders / returnChecks 不注册进 config.collections，写操作只能走本模块，避免通用 CRUD 绕过验收规则。

const ORDER_COLLECTION = 'borrowOrders';
const CHECK_COLLECTION = 'returnChecks';
const OPEN_ORDER_STATUSES = ['借出中', '部分归还', '待修补'];
const ACTIVE_BOX_STATUSES = ['草稿', '已装箱', '巡演中'];

function orderTitle(data) {
  return [data.troupe, data.expectedReturnDate].filter(Boolean).join(' / ') || '外团借还单';
}

function checkTitle(data) {
  return [data.troupe || data.borrowOrderId, data.checker, data.result].filter(Boolean).join(' / ');
}

function stripMeta(record) {
  const { id, collection, createdAt, updatedAt, ...data } = record;
  return data;
}

function insertOrder(data, status, event = {}) {
  const id = db.insertRecord({
    collection: ORDER_COLLECTION,
    status,
    title: orderTitle(data),
    data: { ...data, status }
  });
  db.insertEvent({
    recordId: id,
    collection: ORDER_COLLECTION,
    action: event.action || '开单',
    status,
    actor: event.actor || '',
    note: event.note || '',
    data: event.data || data
  });
  return id;
}

function updateOrder(id, data, status, event = {}) {
  db.updateRecord(ORDER_COLLECTION, id, { status, title: orderTitle(data), data: { ...data, status } });
  db.insertEvent({
    recordId: id,
    collection: ORDER_COLLECTION,
    action: event.action || '更新',
    status,
    actor: event.actor || '',
    note: event.note || '',
    data: event.data || {}
  });
}

function getOrder(id) {
  return db.loadRecord(ORDER_COLLECTION, id);
}

function listOrders(filter = {}) {
  let rows = db.listRecords(ORDER_COLLECTION);
  if (filter.statuses && filter.statuses.length) rows = rows.filter((row) => filter.statuses.includes(row.status));
  if (filter.troupe) rows = rows.filter((row) => row.troupe === filter.troupe);
  return rows;
}

function listOpenOrders() {
  return listOrders({ statuses: OPEN_ORDER_STATUSES });
}

function insertCheck(data, status, event = {}) {
  const id = db.insertRecord({
    collection: CHECK_COLLECTION,
    status,
    title: checkTitle(data),
    data: { ...data, status }
  });
  db.insertEvent({
    recordId: id,
    collection: CHECK_COLLECTION,
    action: event.action || '归还验收',
    status,
    actor: event.actor || '',
    note: event.note || '',
    data: event.data || data
  });
  return id;
}

function getCheck(id) {
  return db.loadRecord(CHECK_COLLECTION, id);
}

function listChecks(orderId) {
  const rows = db.listRecords(CHECK_COLLECTION);
  return orderId ? rows.filter((row) => row.borrowOrderId === orderId) : rows;
}

// 旧验收单留档：状态置为「已归档」但记录保留可查
function archiveCheck(check, event = {}) {
  const data = { ...stripMeta(check), status: '已归档' };
  db.updateRecord(CHECK_COLLECTION, check.id, { status: '已归档', title: checkTitle(data), data });
  db.insertEvent({
    recordId: check.id,
    collection: CHECK_COLLECTION,
    action: '留档',
    status: '已归档',
    actor: event.actor || '',
    note: event.note || '被新验收单替代，留档备查',
    data: {}
  });
}

function getHead(id) {
  return db.loadRecord('puppetHeads', id);
}

function getAccessory(id) {
  return db.loadRecord('accessories', id);
}

function saveHead(head, status, extra, event = {}) {
  const data = { ...stripMeta(head), ...extra, status };
  db.saveRecord('puppetHeads', head.id, data, status);
  db.insertEvent({
    recordId: head.id,
    collection: 'puppetHeads',
    action: event.action || status,
    status,
    actor: event.actor || '',
    note: event.note || '',
    data: event.data || {}
  });
}

function saveAccessory(accessory, status, extra, event = {}) {
  const data = { ...stripMeta(accessory), ...extra, status };
  db.saveRecord('accessories', accessory.id, data, status);
  db.insertEvent({
    recordId: accessory.id,
    collection: 'accessories',
    action: event.action || status,
    status,
    actor: event.actor || '',
    note: event.note || '',
    data: event.data || {}
  });
}

function listActiveTourBoxes() {
  return db.listRecords('tourBoxes').filter((box) => ACTIVE_BOX_STATUSES.includes(box.status));
}

function insertRepairRecord(data, status, event = {}) {
  const id = db.insertRecord({
    collection: 'repairRecords',
    status,
    title: db.titleFor(db.findCollection('repairRecords'), data),
    data: { ...data, status }
  });
  db.insertEvent({
    recordId: id,
    collection: 'repairRecords',
    action: event.action || '登记',
    status,
    actor: event.actor || '',
    note: event.note || '',
    data
  });
  return id;
}

function listRepairsForOrderHead(orderId, headId) {
  return db
    .listRecords('repairRecords')
    .filter((record) => record.borrowOrderId === orderId && record.puppetHeadId === headId);
}

function listEvents(recordId) {
  return db.listEvents(recordId);
}

module.exports = {
  ORDER_COLLECTION,
  CHECK_COLLECTION,
  OPEN_ORDER_STATUSES,
  insertOrder,
  updateOrder,
  getOrder,
  listOrders,
  listOpenOrders,
  insertCheck,
  getCheck,
  listChecks,
  archiveCheck,
  getHead,
  getAccessory,
  saveHead,
  saveAccessory,
  listActiveTourBoxes,
  insertRepairRecord,
  listRepairsForOrderHead,
  listEvents
};
