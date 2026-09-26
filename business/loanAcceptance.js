// 借还验收业务 —— 验收
// 职责：
//  1. 归还按「妆面、机关、配件」逐项验收，一项不过整单不算归还；
//  2. 不合格：偶头/配件转待修补或报遗失，继续被借单占着（挡住再借）；
//     同时开修补记录/缺损追踪；
//  3. 修复完成/补齐后复验：复验合格才解除占用，全部清完借单才结清。
//     每次验收都新开一张验收单，旧单一律留档。

const db = require('../lib/db');
const records = require('./loanRecords');

const HEAD_OK = '可演出';
const HEAD_OUT = '出借中';
const HEAD_REPAIR = '待修补';
const ACC_OK = '在库';
const ACC_OUT = '出借中';
const ACC_REPAIR = '待修补';
const ACC_LOST = '遗失';
const REPAIR_DONE = '已完成';
const LOSS_SETTLED = '已补齐';
const LOSS_CONFIRMED = '确认为遗失';

function badRequest(message, extra = {}) {
  const error = new Error(message);
  error.status = 400;
  Object.assign(error, extra);
  return error;
}

function asResult(value) {
  return value === true || value === '合格' || value === 'pass' ? '合格' : '不合格';
}

function headLineKey(line) {
  return line.headId || line.id;
}

function accessoryLineKey(line) {
  return line.accessoryId || line.id;
}

// 归还验收
function returnLoan(loanId, body, actor) {
  const loan = records.requireLoan(loanId);
  if (loan.status === '已归还') throw badRequest('借单已归还结清，如需复查请查验收单留档');

  const headLines = Array.isArray(body.headLines) ? body.headLines : [];
  const accessoryLines = Array.isArray(body.accessoryLines) ? body.accessoryLines : [];

  const expectedHeads = records.occupiedHeadIds(loan);
  const expectedAccessories = records.occupiedAccessoryIds(loan);

  if (!expectedHeads.length && !expectedAccessories.length) {
    throw badRequest('该借单已无待验收占用物，可直接复验结清');
  }

  const headMap = new Map(headLines.map((line) => [headLineKey(line), line]));
  const accMap = new Map(accessoryLines.map((line) => [accessoryLineKey(line), line]));

  const missingHeads = expectedHeads.filter((id) => !headMap.has(id));
  const missingAccs = expectedAccessories.filter((id) => !accMap.has(id));
  if (missingHeads.length || missingAccs.length) {
    throw badRequest('验收必须逐项覆盖当前占用物，缺少验收行', {
      missingHeadIds: missingHeads,
      missingAccessoryIds: missingAccs
    });
  }

  const nowAt = db.now();
  const summary = { repairedHeads: [], repairedAccessories: [], lostAccessories: [], released: [] };
  const openIssues = [...(loan.openIssues || [])];
  const heldHeadIds = [];
  const heldAccessoryIds = [];

  // ---- 偶头：妆面 / 机关 / 随附配件 三项逐项判定 ----
  for (const id of expectedHeads) {
    const line = headMap.get(id);
    const head = records.getHead(id);
    const paint = asResult(line.paintResult ?? line.paint);
    const mechanism = asResult(line.mechanismResult ?? line.mechanism);
    const kit = asResult(line.accessoryResult ?? line.accessories ?? line.kit);
    const passed = paint === '合格' && mechanism === '合格' && kit === '合格';

    if (passed) {
      records.setHeadStatus(head, HEAD_OK, '验收合格入库', actor,
        '借单 ' + loan.loanNo + ' 归还，妆面/机关/配件均合格', { activeLoanId: null });
      summary.released.push({ itemType: 'puppetHead', id });
    } else {
      const defects = [];
      if (paint === '不合格') defects.push('妆面：' + (line.paintNote || '有损伤'));
      if (mechanism === '不合格') defects.push('机关：' + (line.mechanismNote || '有损伤'));
      if (kit === '不合格') defects.push('随附配件：' + (line.accessoryNote || '不齐/损伤'));
      const problem = defects.join('；');

      const repairType =
        mechanism === '不合格'
          ? '修机关中'
          : paint === '不合格'
            ? '补漆中'
            : '换配件';
      records.setHeadStatus(head, HEAD_REPAIR, '验收不合格转待修补', actor,
        '借单 ' + loan.loanNo + ' 归还验收不合格：' + problem,
        { activeLoanId: loan.id, currentUsable: false });

      const repair = records.createRepairRecord(
        {
          puppetHeadId: id,
          repairType,
          handler: body.repairHandler || '待分派',
          problem,
          source: '借还验收',
          loanId: loan.id,
          foundAt: nowAt
        },
        actor
      );
      openIssues.push({
        itemType: 'puppetHead',
        itemId: id,
        kind: 'repair',
        repairRecordId: repair.id,
        problem,
        openedAt: nowAt
      });
      heldHeadIds.push(id);
      summary.repairedHeads.push({ id, problem, repairRecordId: repair.id });
    }
  }

  // ---- 随附配件：逐项核对在否、完好否 ----
  for (const id of expectedAccessories) {
    const line = accMap.get(id);
    const accessory = records.getAccessory(id);
    const present = line.present !== false && line.returned !== false;
    const condition = asResult(line.conditionResult ?? line.condition);

    if (!present) {
      records.setAccessoryStatus(accessory, ACC_LOST, '验收报遗失', actor,
        '借单 ' + loan.loanNo + ' 归还时缺少：' + (line.note || '未交回'),
        { activeLoanId: loan.id });
      const loss = records.createLossReport(
        {
          itemType: 'accessory',
          itemId: id,
          itemName: accessory.name,
          problem: '外团归还缺失：' + (line.note || '未交回'),
          source: '借还验收',
          loanId: loan.id,
          foundAt: nowAt
        },
        actor
      );
      openIssues.push({
        itemType: 'accessory',
        itemId: id,
        kind: 'loss',
        lossReportId: loss.id,
        openedAt: nowAt
      });
      heldAccessoryIds.push(id);
      summary.lostAccessories.push({ id, lossReportId: loss.id });
    } else if (condition === '不合格') {
      const problem = line.conditionNote || '配件损伤';
      records.setAccessoryStatus(accessory, ACC_REPAIR, '验收不合格转待修补', actor,
        '借单 ' + loan.loanNo + ' 归还验收不合格：' + problem,
        { activeLoanId: loan.id });
      const loss = records.createLossReport(
        {
          itemType: 'accessory',
          itemId: id,
          itemName: accessory.name,
          problem: '外团归还损伤：' + problem,
          source: '借还验收',
          loanId: loan.id,
          foundAt: nowAt
        },
        actor
      );
      openIssues.push({
        itemType: 'accessory',
        itemId: id,
        kind: 'repair',
        lossReportId: loss.id,
        problem,
        openedAt: nowAt
      });
      heldAccessoryIds.push(id);
      summary.repairedAccessories.push({ id, problem, lossReportId: loss.id });
    } else {
      records.setAccessoryStatus(accessory, ACC_OK, '验收合格入库', actor,
        '借单 ' + loan.loanNo + ' 归还，配件完好齐全', { activeLoanId: null });
      summary.released.push({ itemType: 'accessory', id });
    }
  }

  // 本次验收不合格件继续占用；此前仍挂起的问题件保持占用
  const heldHeadSet = new Set(heldHeadIds);
  const heldAccSet = new Set(heldAccessoryIds);
  for (const issue of openIssues) {
    if (issue.resolvedAt) continue;
    if (issue.itemType === 'puppetHead') heldHeadSet.add(issue.itemId);
    if (issue.itemType === 'accessory') heldAccSet.add(issue.itemId);
  }
  const occupiedHeadIds = [...heldHeadSet];
  const occupiedAccessoryIds = [...heldAccSet];

  const overallPass = occupiedHeadIds.length === 0 && occupiedAccessoryIds.length === 0;
  const acceptance = records.appendAcceptance(
    loan,
    {
      inspector: body.inspector,
      headLines: expectedHeads.map((id) => normalizeHeadLine(headMap.get(id), id)),
      accessoryLines: expectedAccessories.map((id) => normalizeAccessoryLine(accMap.get(id), id)),
      note: body.note
    },
    overallPass ? '合格' : '不合格',
    actor
  );

  let changes;
  if (overallPass) {
    changes = {
      occupiedHeadIds: [],
      occupiedAccessoryIds: [],
      openIssues,
      returnedAt: nowAt,
      status: '已归还',
      closeNote: '首次归还验收全部合格'
    };
  } else {
    changes = {
      occupiedHeadIds,
      occupiedAccessoryIds,
      openIssues,
      status: '待修补'
    };
  }
  const updated = records.updateLoan(loan, changes, {
    action: overallPass ? '归还验收合格结清' : '归还验收不合格转待修补',
    actor: actor || body.inspector || '',
    note: overallPass
      ? '妆面/机关/配件逐项验收合格，借单结清'
      : '不合格件继续占用，待修复/补齐后复验（验收单 ' + acceptance.id + '）',
    data: { acceptanceId: acceptance.id, summary }
  });

  return { loan: updated, acceptance, summary };
}

function normalizeHeadLine(line, id) {
  return {
    headId: id,
    paintResult: asResult(line.paintResult ?? line.paint),
    paintNote: line.paintNote || '',
    mechanismResult: asResult(line.mechanismResult ?? line.mechanism),
    mechanismNote: line.mechanismNote || '',
    accessoryResult: asResult(line.accessoryResult ?? line.accessories ?? line.kit),
    accessoryNote: line.accessoryNote || '',
    note: line.note || ''
  };
}

function normalizeAccessoryLine(line, id) {
  return {
    accessoryId: id,
    present: line.present !== false && line.returned !== false,
    conditionResult: asResult(line.conditionResult ?? line.condition),
    conditionNote: line.conditionNote || '',
    note: line.note || ''
  };
}

// 修复完成：修补记录闭环，偶头/配件恢复可出借，但借单要复验后才结清
function completeRepair(repairRecordId, body = {}, actor) {
  const repair = db.loadRecord('repairRecords', repairRecordId);
  if (!repair) {
    const error = new Error('修补记录不存在: ' + repairRecordId);
    error.status = 404;
    throw error;
  }
  if (repair.status === REPAIR_DONE) throw badRequest('该修补记录已完成');
  const loanId = body.loanId || repair.loanId;
  if (!loanId) throw badRequest('缺少关联借单 loanId');
  const loan = records.requireLoan(loanId);

  db.saveRecord(
    'repairRecords',
    repair.id,
    { ...repair, status: REPAIR_DONE, completedAt: db.now(), repairNote: body.note || repair.problem || '' },
    REPAIR_DONE,
    { action: '修复完成', actor: actor || '', note: body.note || '修复完成，待复验', data: { loanId } }
  );

  const nowAt = db.now();
  const openIssues = loan.openIssues || [];
  let releasedItem = null;

  if (repair.puppetHeadId) {
    const head = records.getHead(repair.puppetHeadId);
    records.setHeadStatus(head, HEAD_OK, '修复完成恢复可出借', actor,
      '借单 ' + loan.loanNo + ' 关联修复完成，待复验', { activeLoanId: null, currentUsable: true });
    releasedItem = { itemType: 'puppetHead', itemId: repair.puppetHeadId };
  }

  for (const issue of openIssues) {
    if (issue.repairRecordId === repairRecordId && !issue.resolvedAt) {
      issue.resolvedAt = nowAt;
      issue.resolution = 'repaired';
    }
  }

  const result = settleAfterIssue(loan, openIssues, '修复完成待复验', actor, body.note);
  return { loan: result.loan, acceptance: result.acceptance, released: releasedItem };
}

// 缺损处理：配件补齐(已补齐)或确认遗失；确认遗失后该件不再占用
function resolveLoss(lossReportId, body = {}, actor) {
  const loss = db.loadRecord('lossReports', lossReportId);
  if (!loss) {
    const error = new Error('缺损追踪记录不存在: ' + lossReportId);
    error.status = 404;
    throw error;
  }
  const resolution = body.resolution === 'lost' ? LOSS_CONFIRMED : LOSS_SETTLED;
  const loanId = body.loanId || loss.loanId;
  if (!loanId) throw badRequest('缺少关联借单 loanId');
  const loan = records.requireLoan(loanId);

  db.saveRecord(
    'lossReports',
    loss.id,
    { ...loss, status: resolution, resolvedAt: db.now() },
    resolution,
    {
      action: resolution === LOSS_SETTLED ? '配件补齐' : '确认遗失',
      actor: actor || '',
      note: body.note || '',
      data: { loanId }
    }
  );

  const itemType = loss.itemType === 'puppetHead' ? 'puppetHead' : 'accessory';
  const itemId = loss.itemId;
  if (itemId) {
    if (itemType === 'accessory') {
      const accessory = records.getAccessory(itemId);
      if (accessory) {
        const nextStatus = resolution === LOSS_CONFIRMED ? ACC_LOST : ACC_OK;
        records.setAccessoryStatus(
          accessory,
          nextStatus,
          resolution === LOSS_CONFIRMED ? '确认为遗失' : '补齐回库',
          actor,
          body.note || (resolution === LOSS_CONFIRMED ? '借单 ' + loan.loanNo + ' 缺件确认遗失' : '借单 ' + loan.loanNo + ' 缺件补齐'),
          { activeLoanId: null }
        );
      }
    }
  }

  const nowAt = db.now();
  const openIssues = loan.openIssues || [];
  for (const issue of openIssues) {
    if (issue.lossReportId === lossReportId && !issue.resolvedAt) {
      issue.resolvedAt = nowAt;
      issue.resolution = resolution === LOSS_CONFIRMED ? 'lost' : 'replenished';
    }
  }

  const actionLabel = resolution === LOSS_CONFIRMED ? '确认遗失待复验' : '配件补齐待复验';
  const result = settleAfterIssue(loan, openIssues, actionLabel, actor, body.note);
  return { loan: result.loan, acceptance: result.acceptance };
}

// 问题件处理后重算借单：
// 仍有未结问题 -> 待复验/待修补；全部了结 -> 新开一张复验合格验收单并结清
function settleAfterIssue(loan, openIssues, action, actor, note) {
  const pending = openIssues.filter((issue) => !issue.resolvedAt);

  const allClear = pending.length === 0;
  let acceptance = null;
  const changes = {
    openIssues,
    occupiedHeadIds: pending
      .filter((issue) => issue.itemType === 'puppetHead')
      .map((issue) => issue.itemId),
    occupiedAccessoryIds: allClear
      ? []
      : pending.filter((issue) => issue.itemType === 'accessory').map((issue) => issue.itemId)
  };

  if (allClear) {
    const lostHeadIds = new Set(
      openIssues.filter((issue) => issue.itemType === 'puppetHead' && issue.resolution === 'lost')
        .map((issue) => issue.itemId)
    );
    const lostAccIds = new Set(
      openIssues.filter((issue) => issue.itemType === 'accessory' && issue.resolution === 'lost')
        .map((issue) => issue.itemId)
    );
    // 复验合格：新开验收单，旧单全部留档（确认遗失件按实际勾"不在"）
    acceptance = records.appendAcceptance(
      loan,
      {
        inspector: actor || '复验',
        headLines: (loan.headIds || []).map((id) => ({
          headId: id,
          paintResult: lostHeadIds.has(id) ? '不合格' : '合格',
          paintNote: lostHeadIds.has(id) ? '确认遗失' : '',
          mechanismResult: lostHeadIds.has(id) ? '不合格' : '合格',
          mechanismNote: lostHeadIds.has(id) ? '确认遗失' : '',
          accessoryResult: '合格',
          accessoryNote: '',
          note: '修复/补齐后复验'
        })),
        accessoryLines: (loan.accessoryIds || []).map((id) => ({
          accessoryId: id,
          present: !lostAccIds.has(id),
          conditionResult: lostAccIds.has(id) ? '不合格' : '合格',
          conditionNote: lostAccIds.has(id) ? '确认遗失，不再占用' : '',
          note: '修复/补齐后复验'
        })),
        note: note || '问题件全部了结，复验合格'
      },
      '合格',
      actor
    );
    changes.status = '已归还';
    changes.returnedAt = db.now();
    changes.closeNote = action + '后复验合格结清';
    changes.occupiedHeadIds = [];
  } else {
    changes.status = '待复验';
  }

  const updated = records.updateLoan(loan, changes, {
    action,
    actor: actor || '',
    note: allClear
      ? '问题件全部了结，复验合格，借单结清（复验单 ' + acceptance.id + '）'
      : '仍有 ' + pending.length + ' 件问题未结，借单继续占用',
    data: { acceptanceId: acceptance ? acceptance.id : null }
  });

  return { loan: updated, acceptance };
}

// 人工复验：对仍挂起的借单再开一张逐项验收单
function recheckLoan(loanId, body, actor) {
  const loan = records.requireLoan(loanId);
  if (loan.status === '已归还') throw badRequest('借单已结清');
  return returnLoan(loanId, body, actor);
}

module.exports = {
  returnLoan,
  completeRepair,
  resolveLoss,
  recheckLoan
};
