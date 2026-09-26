// 借还验收业务 —— 入口
// 职责：
//  1. 借用开单：登记剧团、偶头、随附配件、预计归还日；
//  2. 占用拦截：未结借单中的偶头/配件、或档案本身非可出借状态，再借一律挡住并指向原单；
//  3. 改期：修改预计归还日后重查后续档期，冲突要指出撞单，确认后可强制改期。

const db = require('../lib/db');
const records = require('./loanRecords');

const HEAD_LENDABLE = '可演出';
const ACCESSORY_LENDABLE = '在库';
const HEAD_OUT = '出借中';
const ACCESSORY_OUT = '出借中';

function badRequest(message, extra = {}) {
  const error = new Error(message);
  error.status = 400;
  Object.assign(error, extra);
  return error;
}

function conflict(message, extra = {}) {
  const error = new Error(message);
  error.status = 409;
  Object.assign(error, extra);
  return error;
}

function normalizeIds(value) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((item) => (typeof item === 'object' ? item.id : item)).filter(Boolean);
}

function buildAccessorySnapshot(accessoryIds, listed) {
  return accessoryIds.map((id) => {
    const item = listed.find((entry) => entry.id === id);
    const accessory = records.getAccessory(id);
    return {
      id,
      name: item?.name || accessory?.name || '',
      condition: item?.condition || '随单完好',
      noted: Boolean(item)
    };
  });
}

// 借用前预检：返回每件物品的可借状态；被占用时指向原借单
function checkAvailability({ headIds = [], accessoryIds = [] }) {
  const headResults = headIds.map((id) => {
    const head = records.getHead(id);
    if (!head) return { itemType: 'puppetHead', id, available: false, reason: '偶头档案不存在' };
    if (head.status !== HEAD_LENDABLE) {
      const holdingLoan = records.findHoldingLoan('head', id);
      return {
        itemType: 'puppetHead',
        id,
        name: records.headName(head),
        available: false,
        reason: '偶头当前状态为「' + head.status + '」，不可出借',
        currentStatus: head.status,
        holdingLoan: holdingLoan ? loanRef(holdingLoan) : null
      };
    }
    const holdingLoan = records.findHoldingLoan('head', id);
    if (holdingLoan) {
      return {
        itemType: 'puppetHead',
        id,
        name: records.headName(head),
        available: false,
        reason: '在未结借单 ' + holdingLoan.loanNo + ' 中，尚未归还',
        currentStatus: head.status,
        holdingLoan: loanRef(holdingLoan)
      };
    }
    return {
      itemType: 'puppetHead',
      id,
      name: records.headName(head),
      available: true,
      currentStatus: head.status
    };
  });

  const accessoryResults = accessoryIds.map((id) => {
    const accessory = records.getAccessory(id);
    if (!accessory) return { itemType: 'accessory', id, available: false, reason: '配件档案不存在' };
    if (accessory.status !== ACCESSORY_LENDABLE) {
      const holdingLoan = records.findHoldingLoan('accessory', id);
      return {
        itemType: 'accessory',
        id,
        name: records.accessoryName(accessory),
        available: false,
        reason: '配件当前状态为「' + accessory.status + '」，不可出借',
        currentStatus: accessory.status,
        holdingLoan: holdingLoan ? loanRef(holdingLoan) : null
      };
    }
    const holdingLoan = records.findHoldingLoan('accessory', id);
    if (holdingLoan) {
      return {
        itemType: 'accessory',
        id,
        name: records.accessoryName(accessory),
        available: false,
        reason: '在未结借单 ' + holdingLoan.loanNo + ' 中，尚未归还',
        currentStatus: accessory.status,
        holdingLoan: loanRef(holdingLoan)
      };
    }
    return {
      itemType: 'accessory',
      id,
      name: records.accessoryName(accessory),
      available: true,
      currentStatus: accessory.status
    };
  });

  return {
    available: [...headResults, ...accessoryResults].every((item) => item.available),
    heads: headResults,
    accessories: accessoryResults
  };
}

function loanRef(loan) {
  return {
    loanId: loan.id,
    loanNo: loan.loanNo,
    troupeName: loan.troupeName,
    expectedReturnDate: loan.expectedReturnDate,
    status: loan.status
  };
}

// 开单登记
function createLoan(body, actor) {
  const headIds = normalizeIds(body.headIds);
  const accessoryIds = normalizeIds(body.accessoryIds);
  const expectedReturnDate = body.expectedReturnDate;

  if (!body.troupeName) throw badRequest('缺少剧团名称 troupeName');
  if (!headIds.length) throw badRequest('借用偶头 headIds 不能为空');
  if (!expectedReturnDate || !db.isDateString(expectedReturnDate)) {
    throw badRequest('预计归还日 expectedReturnDate 格式应为 YYYY-MM-DD');
  }

  const loanDate = body.loanDate || db.today();
  if (!db.isDateString(loanDate)) throw badRequest('出借日 loanDate 格式应为 YYYY-MM-DD');
  if (expectedReturnDate < loanDate) throw badRequest('预计归还日不能早于出借日');

  const availability = checkAvailability({ headIds, accessoryIds });
  if (!availability.available) {
    throw conflict('存在不可出借的偶头或配件，已挡住并指向原借单', {
      code: 'ITEMS_BLOCKED',
      blocked: [...availability.heads, ...availability.accessories].filter((item) => !item.available)
    });
  }

  const listedAccessories = Array.isArray(body.accessories) ? body.accessories : [];
  const accessorySnapshot = buildAccessorySnapshot(accessoryIds, listedAccessories);

  // 补登记的历史借单若归还日已过，直接按已逾期开单（仍占用）
  const initialStatus = expectedReturnDate < db.today() ? '已逾期' : '出借中';

  const loan = records.createLoan(
    {
      troupeName: body.troupeName,
      contact: body.contact,
      phone: body.phone,
      headIds,
      accessoryIds,
      accessorySnapshot,
      play: body.play,
      loanDate,
      expectedReturnDate,
      note: body.note
    },
    actor,
    { initialStatus }
  );

  // 占用：偶头/配件置为出借中，并在各自时间线留痕
  for (const id of headIds) {
    const head = records.getHead(id);
    records.setHeadStatus(head, HEAD_OUT, '外团借出', actor,
      '随借单 ' + loan.loanNo + ' 借给 ' + loan.troupeName + '，预计 ' + loan.expectedReturnDate + ' 归还',
      { activeLoanId: loan.id });
  }
  for (const id of accessoryIds) {
    const accessory = records.getAccessory(id);
    records.setAccessoryStatus(accessory, ACCESSORY_OUT, '外团借出', actor,
      '随借单 ' + loan.loanNo + ' 借给 ' + loan.troupeName,
      { activeLoanId: loan.id });
  }

  return records.getLoan(loan.id);
}

// 改预计归还日：重查后续档期
function rescheduleLoan(loanId, body, actor) {
  const loan = records.requireLoan(loanId);
  if (loan.status === '已归还') throw badRequest('借单已归还结清，不能再改预计归还日');
  const nextDate = body.expectedReturnDate;
  if (!nextDate || !db.isDateString(nextDate)) {
    throw badRequest('新的预计归还日 expectedReturnDate 格式应为 YYYY-MM-DD');
  }
  if (nextDate < loan.loanDate) throw badRequest('预计归还日不能早于出借日');
  if (nextDate === loan.expectedReturnDate) {
    throw badRequest('新的预计归还日与原日期相同');
  }

  const windowStart = nextDate < loan.expectedReturnDate ? nextDate : loan.loanDate;
  const windowEnd = nextDate > loan.expectedReturnDate ? nextDate : loan.expectedReturnDate;

  const conflicts = [];
  for (const id of loan.headIds || []) {
    conflicts.push(
      ...records.findScheduleConflicts({ type: 'head', id }, windowStart, windowEnd, loan.id)
        .map((entry) => ({ ...entry, itemType: 'puppetHead', itemId: id }))
    );
  }
  for (const id of loan.accessoryIds || []) {
    conflicts.push(
      ...records.findScheduleConflicts({ type: 'accessory', id }, windowStart, windowEnd, loan.id)
        .map((entry) => ({ ...entry, itemType: 'accessory', itemId: id }))
    );
  }

  // 延期归还还要重查本团后续巡演档期：归还日晚于装箱/演出日即为撞档
  if (nextDate > loan.expectedReturnDate) {
    for (const id of loan.headIds || []) {
      conflicts.push(
        ...records.findTourBoxConflicts({ type: 'head', id }, nextDate)
          .map((entry) => ({ ...entry, itemType: 'puppetHead', itemId: id, conflictType: 'tourBox' }))
      );
    }
    for (const id of loan.accessoryIds || []) {
      conflicts.push(
        ...records.findTourBoxConflicts({ type: 'accessory', id }, nextDate)
          .map((entry) => ({ ...entry, itemType: 'accessory', itemId: id, conflictType: 'tourBox' }))
      );
    }
  }

  if (conflicts.length && !body.forceSchedule) {
    throw conflict('改期后与后续档期冲突，请确认撞单后携带 forceSchedule=true 再次提交', {
      code: 'SCHEDULE_CONFLICT',
      conflicts
    });
  }

  const updated = records.updateLoan(
    loan,
    {
      expectedReturnDate: nextDate,
      scheduleRechecks: [
        ...(loan.scheduleRechecks || []),
        {
          from: loan.expectedReturnDate,
          to: nextDate,
          at: db.now(),
          actor: actor || '',
          forced: Boolean(body.forceSchedule),
          conflictCount: conflicts.length
        }
      ]
    },
    {
      action: '改预计归还日',
      actor: actor || '',
      note: loan.expectedReturnDate + ' 改为 ' + nextDate +
        (conflicts.length ? '（强制改期，撞单 ' + conflicts.length + ' 笔）' : '（已重查后续档期，无冲突）'),
      data: { conflicts }
    }
  );

  return { loan: updated, conflicts };
}

module.exports = {
  checkAvailability,
  createLoan,
  rescheduleLoan
};
