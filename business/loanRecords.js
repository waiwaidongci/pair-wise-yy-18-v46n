// 借还验收业务 —— 记录保存
// 职责：借单/验收单的建档与状态流转、占用查询、后续档期查询、旧验收单留档。
// 不做开单/验收的业务判定（那些在 loanEntry / loanAcceptance）。

const { randomUUID } = require('crypto');
const db = require('../lib/db');

const LOANS = 'loans';
const ACCEPTANCES = 'loanAcceptances';
const HEADS = 'puppetHeads';
const ACCESSORIES = 'accessories';

// 借单未结状态：其中的偶头/配件继续占用，不得再借
const OPEN_STATUSES = ['出借中', '已逾期', '待修补', '待复验'];

function headName(head) {
  return [head.role, head.play].filter(Boolean).join('/') + '(' + head.id + ')';
}

function accessoryName(accessory) {
  return [accessory.name, accessory.role].filter(Boolean).join('/') + '(' + accessory.id + ')';
}

function listLoans() {
  return db.listRecords(LOANS);
}

function listOpenLoans() {
  return listLoans().filter((loan) => OPEN_STATUSES.includes(loan.status));
}

function getLoan(id) {
  return db.loadRecord(LOANS, id);
}

function requireLoan(id) {
  const loan = getLoan(id);
  if (!loan) {
    const error = new Error('借单不存在: ' + id);
    error.status = 404;
    throw error;
  }
  return loan;
}

function isOpen(loan) {
  return OPEN_STATUSES.includes(loan.status);
}

function getHead(id) {
  return db.loadRecord(HEADS, id);
}

function getAccessory(id) {
  return db.loadRecord(ACCESSORIES, id);
}

// 反查某件东西当前被哪张未结借单占着
// 借单全程保留 headIds/accessoryIds 清单；占用以 occupied* 列表为准，
// 某件验收合格或修复完成后即从占用列表摘除（借单本身可能仍未结）。
function occupiedHeadIds(loan) {
  return loan.occupiedHeadIds || loan.headIds || [];
}

function occupiedAccessoryIds(loan) {
  return loan.occupiedAccessoryIds || loan.accessoryIds || [];
}

function findHoldingLoan(itemType, itemId) {
  for (const loan of listOpenLoans()) {
    const ids = itemType === 'accessory' ? occupiedAccessoryIds(loan) : occupiedHeadIds(loan);
    if (ids.includes(itemId)) return loan;
  }
  return null;
}

// 同一批偶头/配件在 [startDate, endDate] 区间内的后续档期占用
// 与未结借单区间重叠即冲突；借出日缺失视为档期起点不设防
function findScheduleConflicts(item, startDate, endDate, excludeLoanId) {
  return listOpenLoans()
    .filter((loan) => {
      if (loan.id === excludeLoanId) return false;
      const otherStart = loan.loanDate || '0000-00-00';
      const otherEnd = loan.expectedReturnDate || '9999-12-31';
      return otherStart <= endDate && otherEnd >= startDate;
    })
    .filter((loan) => {
      const heads = occupiedHeadIds(loan);
      const accessories = occupiedAccessoryIds(loan);
      const hit =
        item.type === 'head'
          ? heads.includes(item.id)
          : accessories.includes(item.id);
      return hit;
    })
    .map((loan) => ({
      loanId: loan.id,
      loanNo: loan.loanNo,
      troupeName: loan.troupeName,
      loanDate: loan.loanDate,
      expectedReturnDate: loan.expectedReturnDate,
      status: loan.status
    }));
}

function createLoan(data, actor, options = {}) {
  const id = randomUUID();
  const loanNo = data.loanNo || ('JD' + db.now().replace(/[-:T.Z]/g, '').slice(0, 14) + '-' + id.slice(0, 4));
  const status = options.initialStatus || '出借中';
  const record = db.insertRecord(
    LOANS,
    {
      loanNo,
      troupeName: data.troupeName,
      contact: data.contact || '',
      phone: data.phone || '',
      headIds: data.headIds,
      accessoryIds: data.accessoryIds || [],
      // 开单时快照随附配件明细，归还逐项核对，避免事后扯皮
      accessorySnapshot: data.accessorySnapshot || [],
      play: data.play || '',
      loanDate: data.loanDate || db.today(),
      expectedReturnDate: data.expectedReturnDate,
      // 占用清单：初始为全部借出物，验收合格/修复后逐件摘除
      occupiedHeadIds: [...data.headIds],
      occupiedAccessoryIds: [...(data.accessoryIds || [])],
      note: data.note || '',
      returnedAt: null
    },
    {
      id,
      status,
      action: '开单登记',
      actor: actor || '',
      note: '外团借用开单：' + data.troupeName
    }
  );
  return record;
}

function updateLoan(loan, changes, event) {
  return db.saveRecord(LOANS, loan.id, { ...loan, ...changes }, changes.status || loan.status, event);
}

// 追加一张新的验收单；旧验收单永不覆盖、不删除，只追加留档
function appendAcceptance(loan, payload, status, actor) {
  return db.insertRecord(
    ACCEPTANCES,
    {
      loanId: loan.id,
      loanNo: loan.loanNo,
      inspectedAt: db.now(),
      inspector: payload.inspector || actor || '',
      headLines: payload.headLines,
      accessoryLines: payload.accessoryLines,
      overallNote: payload.note || '',
      result: status
    },
    {
      status,
      action: '归还验收',
      actor: actor || payload.inspector || '',
      note: '借单 ' + loan.loanNo + ' 验收' + status
    }
  );
}

function listAcceptances(loanId) {
  return db.listRecords(ACCEPTANCES)
    .filter((record) => !loanId || record.loanId === loanId)
    .sort((a, b) => (a.inspectedAt < b.inspectedAt ? -1 : 1));
}

function setHeadStatus(head, status, action, actor, note, extra = {}) {
  return db.saveRecord(
    HEADS,
    head.id,
    { ...head, ...extra, status },
    status,
    { action, actor, note, data: { status, note, ...extra } }
  );
}

function setAccessoryStatus(accessory, status, action, actor, note, extra = {}) {
  return db.saveRecord(
    ACCESSORIES,
    accessory.id,
    { ...accessory, ...extra, status },
    status,
    { action, actor, note, data: { status, note, ...extra } }
  );
}

function listRepairRecords() {
  return db.listRecords('repairRecords');
}

function createRepairRecord(data, actor) {
  return db.insertRecord('repairRecords', data, {
    status: data.status || '待处理',
    action: '验收转修补',
    actor: actor || '',
    note: data.problem || ''
  });
}

function listLossReports() {
  return db.listRecords('lossReports');
}

// 后续档期：本团巡演装箱计划中需要用到该件、且装箱/演出日早于新归还日的单
function findTourBoxConflicts(item, returnDate) {
  return db.listRecords('tourBoxes')
    .filter((box) => box.status !== '已闭环')
    .filter((box) => {
      const useDate = box.loadDate || box.showDate || box.performanceDate;
      return useDate && db.isDateString(useDate) && returnDate > useDate;
    })
    .filter((box) => {
      const heads = box.headIds || [];
      const accessories = box.accessoryIds || [];
      return item.type === 'head' ? heads.includes(item.id) : accessories.includes(item.id);
    })
    .map((box) => ({
      tourBoxId: box.id,
      showName: box.showName,
      venue: box.venue,
      play: box.play,
      useDate: box.loadDate || box.showDate || box.performanceDate,
      status: box.status
    }));
}

function createLossReport(data, actor) {
  return db.insertRecord('lossReports', data, {
    status: '待处理',
    action: '验收报损',
    actor: actor || '',
    note: data.problem || ''
  });
}

module.exports = {
  OPEN_STATUSES,
  headName,
  accessoryName,
  listLoans,
  listOpenLoans,
  getLoan,
  requireLoan,
  isOpen,
  occupiedHeadIds,
  occupiedAccessoryIds,
  getHead,
  getAccessory,
  findHoldingLoan,
  findScheduleConflicts,
  createLoan,
  updateLoan,
  appendAcceptance,
  listAcceptances,
  setHeadStatus,
  setAccessoryStatus,
  listRepairRecords,
  createRepairRecord,
  listLossReports,
  createLossReport,
  findTourBoxConflicts
};
