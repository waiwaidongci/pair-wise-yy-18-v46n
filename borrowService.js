const store = require('./borrowStore');

// 外团借还验收的业务规则：开单占用校验、归还逐项验收、修复恢复、改期重查档期。

const LIST_KEYS = [
  'headIds',
  'accessoryIds',
  'pendingHeadIds',
  'pendingAccessoryIds',
  'releasedHeadIds',
  'releasedAccessoryIds',
  'failedHeadIds',
  'failedAccessoryIds'
];

function fail(status, message, details) {
  const error = new Error(message);
  error.status = status;
  error.details = details;
  throw error;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function isDateString(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

function unique(list) {
  return [...new Set((list || []).filter(Boolean))];
}

function getOrder(orderId) {
  const order = store.getOrder(orderId);
  if (!order) fail(404, '借单不存在: ' + orderId);
  return order;
}

function orderData(order) {
  const { id, collection, createdAt, updatedAt, ...data } = order;
  for (const key of LIST_KEYS) data[key] = data[key] || [];
  return data;
}

// 未结借单状态：有待修复物品 → 待修补；全部放行 → 已结案；还了一部分 → 部分归还
function statusOf(data) {
  const pending = data.pendingHeadIds.length + data.pendingAccessoryIds.length;
  if (pending === 0) return '已结案';
  const failed = data.failedHeadIds.length + data.failedAccessoryIds.length;
  if (failed > 0) return '待修补';
  const released = data.releasedHeadIds.length + data.releasedAccessoryIds.length;
  return released > 0 ? '部分归还' : '借出中';
}

function moveItem(data, fromKey, toKey, itemId) {
  data[fromKey] = data[fromKey].filter((id) => id !== itemId);
  if (!data[toKey].includes(itemId)) data[toKey].push(itemId);
}

// 占用判定：物品仍挂在某张未结借单的待归还清单里
function findHolder(openOrders, listKey, fallbackKey, itemId) {
  return openOrders.find((order) => (order[listKey] || order[fallbackKey] || []).includes(itemId));
}

function openBorrowOrder(input = {}) {
  const troupe = String(input.troupe || '').trim();
  if (!troupe) fail(400, '开单需登记剧团名称');
  const headIds = unique(input.headIds);
  const accessoryIds = unique(input.accessoryIds);
  if (!headIds.length) fail(400, '开单至少登记一个偶头');
  if (!isDateString(input.expectedReturnDate)) fail(400, '预计归还日需为 YYYY-MM-DD 格式');
  if (input.expectedReturnDate < today()) fail(400, '预计归还日不能早于今天');

  const openOrders = store.listOpenOrders();
  const conflicts = [];

  const heads = headIds.map((headId) => {
    const head = store.getHead(headId);
    if (!head) fail(404, '偶头不存在: ' + headId);
    const holder = findHolder(openOrders, 'pendingHeadIds', 'headIds', headId);
    if (holder) {
      conflicts.push({
        itemType: '偶头',
        itemId: headId,
        itemName: head.role + '（' + head.play + '）',
        reason: '仍在未结借单中',
        orderId: holder.id,
        troupe: holder.troupe,
        expectedReturnDate: holder.expectedReturnDate
      });
    } else if (head.status !== '可演出' || head.currentUsable === false) {
      conflicts.push({
        itemType: '偶头',
        itemId: headId,
        itemName: head.role + '（' + head.play + '）',
        reason: '当前状态「' + head.status + '」不可出借'
      });
    }
    return head;
  });

  const accessories = accessoryIds.map((accessoryId) => {
    const accessory = store.getAccessory(accessoryId);
    if (!accessory) fail(404, '配件不存在: ' + accessoryId);
    const holder = findHolder(openOrders, 'pendingAccessoryIds', 'accessoryIds', accessoryId);
    if (holder) {
      conflicts.push({
        itemType: '配件',
        itemId: accessoryId,
        itemName: accessory.name,
        reason: '仍在未结借单中',
        orderId: holder.id,
        troupe: holder.troupe,
        expectedReturnDate: holder.expectedReturnDate
      });
    } else if (accessory.status !== '在库') {
      conflicts.push({
        itemType: '配件',
        itemId: accessoryId,
        itemName: accessory.name,
        reason: '当前状态「' + accessory.status + '」不可出借'
      });
    }
    return accessory;
  });

  if (conflicts.length) fail(409, '借用被拦截：请先了结原借单或更换物品', conflicts);

  const data = {
    troupe,
    headIds,
    accessoryIds,
    expectedReturnDate: input.expectedReturnDate,
    borrowDate: today(),
    pendingHeadIds: [...headIds],
    pendingAccessoryIds: [...accessoryIds],
    releasedHeadIds: [],
    releasedAccessoryIds: [],
    failedHeadIds: [],
    failedAccessoryIds: [],
    note: input.note || ''
  };
  const orderId = store.insertOrder(data, '借出中', { action: '开单登记', actor: input.actor, note: input.note });

  for (const head of heads) {
    store.saveHead(head, '已借出', { borrowedBy: troupe, borrowOrderId: orderId }, {
      action: '借出',
      actor: input.actor,
      note: '借单 ' + orderId
    });
  }
  for (const accessory of accessories) {
    store.saveAccessory(accessory, '已借出', { borrowedBy: troupe, borrowOrderId: orderId }, {
      action: '借出',
      actor: input.actor,
      note: '借单 ' + orderId
    });
  }
  return store.getOrder(orderId);
}

function acceptReturn(input = {}) {
  const order = getOrder(input.orderId);
  if (order.status === '已结案') fail(400, '借单已结案，验收记录已封存');
  const checker = String(input.checker || '').trim();
  if (!checker) fail(400, '归还验收需登记验收人');
  if (!Array.isArray(input.items) || !input.items.length) fail(400, '归还需逐项验收，不能只签总件数');

  const data = orderData(order);
  const seen = new Set();
  const results = input.items.map((item) => {
    const key = item.itemType + ':' + item.itemId;
    if (seen.has(key)) fail(400, '重复验收: ' + key);
    seen.add(key);
    if (item.itemType === '偶头') {
      if (!data.pendingHeadIds.includes(item.itemId)) fail(400, '偶头不在待归还清单: ' + item.itemId);
      if (data.failedHeadIds.includes(item.itemId)) fail(400, '偶头已转待修补，请走修复完成流程: ' + item.itemId);
      for (const aspect of ['paint', 'mechanism']) {
        if (!['合格', '不合格'].includes(item[aspect])) {
          fail(400, '偶头 ' + item.itemId + ' 需逐项判定妆面(paint)与机关(mechanism)为 合格/不合格');
        }
      }
      return {
        itemType: '偶头',
        itemId: item.itemId,
        paint: item.paint,
        mechanism: item.mechanism,
        note: item.note || '',
        pass: item.paint === '合格' && item.mechanism === '合格'
      };
    }
    if (item.itemType === '配件') {
      if (!data.pendingAccessoryIds.includes(item.itemId)) fail(400, '配件不在待归还清单: ' + item.itemId);
      if (data.failedAccessoryIds.includes(item.itemId)) fail(400, '配件已转待修补，请走修复完成流程: ' + item.itemId);
      if (!['合格', '不合格', '缺失'].includes(item.condition)) {
        fail(400, '配件 ' + item.itemId + ' 需判定 condition 为 合格/不合格/缺失');
      }
      return {
        itemType: '配件',
        itemId: item.itemId,
        condition: item.condition,
        note: item.note || '',
        pass: item.condition === '合格'
      };
    }
    fail(400, '未知验收类型: ' + item.itemType);
  });

  const allPass = results.every((result) => result.pass);

  // 旧验收单留档：新单生效后，同一张借单的旧单置为「已归档」但保留可查
  const previousChecks = store.listChecks(order.id).filter((check) => check.status !== '已归档');
  const checkId = store.insertCheck(
    {
      borrowOrderId: order.id,
      troupe: data.troupe,
      checker,
      items: results,
      result: allPass ? '合格' : '不合格',
      checkedAt: new Date().toISOString()
    },
    allPass ? '合格' : '待修补',
    { action: '归还验收', actor: checker, note: input.note }
  );
  for (const old of previousChecks) store.archiveCheck(old, { actor: checker });

  const repairRecordIds = [];
  for (const result of results) {
    if (result.itemType === '偶头') {
      const head = store.getHead(result.itemId);
      if (!head) fail(404, '偶头档案不存在: ' + result.itemId);
      if (result.pass) {
        moveItem(data, 'pendingHeadIds', 'releasedHeadIds', result.itemId);
        store.saveHead(head, '可演出', { currentUsable: true, borrowedBy: '', borrowOrderId: '' }, {
          action: '验收合格',
          actor: checker,
          note: '借单 ' + order.id
        });
      } else {
        // 不合格：转待修补并继续占着（留在 pending 清单，借单不结案）
        data.failedHeadIds.push(result.itemId);
        const extra = { currentUsable: false };
        if (result.paint === '不合格') extra.paintStatus = result.note || '归还验收妆面不合格';
        if (result.mechanism === '不合格') extra.mechanism = result.note || '归还验收机关不合格';
        store.saveHead(head, '待修补', extra, {
          action: '验收不合格转待修补',
          actor: checker,
          note: '借单 ' + order.id
        });
        const repairType = [
          result.paint === '不合格' ? '补漆' : '',
          result.mechanism === '不合格' ? '修机关' : ''
        ].filter(Boolean).join('、');
        const repairId = store.insertRepairRecord(
          {
            puppetHeadId: result.itemId,
            repairType,
            handler: checker,
            source: '外团归还验收',
            borrowOrderId: order.id,
            checkId,
            note: result.note || ''
          },
          '待处理',
          { action: '验收转修补', actor: checker }
        );
        repairRecordIds.push(repairId);
      }
    } else {
      const accessory = store.getAccessory(result.itemId);
      if (!accessory) fail(404, '配件档案不存在: ' + result.itemId);
      if (result.pass) {
        moveItem(data, 'pendingAccessoryIds', 'releasedAccessoryIds', result.itemId);
        store.saveAccessory(accessory, '在库', { borrowedBy: '', borrowOrderId: '' }, {
          action: '验收合格',
          actor: checker,
          note: '借单 ' + order.id
        });
      } else if (result.condition === '缺失') {
        moveItem(data, 'pendingAccessoryIds', 'releasedAccessoryIds', result.itemId);
        store.saveAccessory(accessory, '遗失', { borrowedBy: '', borrowOrderId: '' }, {
          action: '验收缺失',
          actor: checker,
          note: '借单 ' + order.id + ' 归还时缺失'
        });
      } else {
        data.failedAccessoryIds.push(result.itemId);
        store.saveAccessory(accessory, '缺损', {}, {
          action: '验收不合格转待修补',
          actor: checker,
          note: '借单 ' + order.id
        });
      }
    }
  }

  const status = statusOf(data);
  if (status === '已结案') data.closedAt = new Date().toISOString();
  store.updateOrder(order.id, data, status, {
    action: '归还验收',
    actor: checker,
    note: '验收单 ' + checkId + (allPass ? '，全部合格' : '，有不合格项转待修补')
  });
  return { order: store.getOrder(order.id), check: store.getCheck(checkId), repairRecordIds };
}

function completeRepair(input = {}) {
  const order = getOrder(input.orderId);
  const data = orderData(order);
  if (!data.failedHeadIds.length && !data.failedAccessoryIds.length) fail(400, '借单没有待修复的物品');

  const targets = Array.isArray(input.items) && input.items.length
    ? input.items
    : [
        ...data.failedHeadIds.map((itemId) => ({ itemType: '偶头', itemId })),
        ...data.failedAccessoryIds.map((itemId) => ({ itemType: '配件', itemId }))
      ];

  const restored = [];
  for (const target of targets) {
    if (target.itemType === '偶头') {
      if (!data.failedHeadIds.includes(target.itemId)) fail(400, '偶头不在待修复清单: ' + target.itemId);
      // 修复完成后才恢复可出借：验收转出的修补记录必须全部「已完成」
      const openRepairs = store
        .listRepairsForOrderHead(order.id, target.itemId)
        .filter((record) => record.status !== '已完成');
      if (openRepairs.length) {
        fail(409, '修补记录未完成，修复完成后才能恢复出借', {
          itemId: target.itemId,
          repairRecordIds: openRepairs.map((record) => record.id)
        });
      }
      const head = store.getHead(target.itemId);
      if (!head) fail(404, '偶头档案不存在: ' + target.itemId);
      store.saveHead(head, '可演出', { currentUsable: true }, {
        action: '修复完成恢复出借',
        actor: input.actor,
        note: input.note || '借单 ' + order.id
      });
      data.failedHeadIds = data.failedHeadIds.filter((id) => id !== target.itemId);
      moveItem(data, 'pendingHeadIds', 'releasedHeadIds', target.itemId);
      restored.push(target);
    } else if (target.itemType === '配件') {
      if (!data.failedAccessoryIds.includes(target.itemId)) fail(400, '配件不在待修复清单: ' + target.itemId);
      const accessory = store.getAccessory(target.itemId);
      if (!accessory) fail(404, '配件档案不存在: ' + target.itemId);
      store.saveAccessory(accessory, '在库', {}, {
        action: '修复完成恢复出借',
        actor: input.actor,
        note: input.note || '借单 ' + order.id
      });
      data.failedAccessoryIds = data.failedAccessoryIds.filter((id) => id !== target.itemId);
      moveItem(data, 'pendingAccessoryIds', 'releasedAccessoryIds', target.itemId);
      restored.push(target);
    } else {
      fail(400, '未知类型: ' + target.itemType);
    }
  }

  const status = statusOf(data);
  if (status === '已结案') data.closedAt = new Date().toISOString();
  store.updateOrder(order.id, data, status, {
    action: '修复恢复',
    actor: input.actor,
    note: '恢复出借 ' + restored.length + ' 件'
  });
  return store.getOrder(order.id);
}

// 改预计归还日：重查后续档期（在用巡演装箱单），冲突则拒绝
function changeExpectedReturn(input = {}) {
  const order = getOrder(input.orderId);
  if (order.status === '已结案') fail(400, '借单已结案，无需改期');
  if (!isDateString(input.expectedReturnDate)) fail(400, '预计归还日需为 YYYY-MM-DD 格式');
  const data = orderData(order);
  if (input.expectedReturnDate === data.expectedReturnDate) fail(400, '新预计归还日与原来相同');
  if (input.expectedReturnDate < data.borrowDate) fail(400, '预计归还日不能早于借出日 ' + data.borrowDate);

  const conflicts = findScheduleConflicts(data, input.expectedReturnDate);
  if (conflicts.length) fail(409, '改期与后续档期冲突，请先协调装箱单', conflicts);

  const from = data.expectedReturnDate;
  data.expectedReturnDate = input.expectedReturnDate;
  store.updateOrder(order.id, data, order.status, {
    action: '改期',
    actor: input.actor,
    note: '预计归还日 ' + from + ' → ' + input.expectedReturnDate + (input.reason ? '（' + input.reason + '）' : ''),
    data: { from, to: input.expectedReturnDate, reason: input.reason || '' }
  });
  return store.getOrder(order.id);
}

function findScheduleConflicts(data, newReturnDate) {
  const conflicts = [];
  for (const box of store.listActiveTourBoxes()) {
    const boxDate = box.showDate || box.tourDate || box.date;
    if (!boxDate || boxDate >= newReturnDate || boxDate < data.borrowDate) continue;
    const headIds = (box.headIds || []).filter((id) => data.pendingHeadIds.includes(id));
    const accessoryIds = (box.accessoryIds || []).filter((id) => data.pendingAccessoryIds.includes(id));
    if (headIds.length || accessoryIds.length) {
      conflicts.push({
        tourBoxId: box.id,
        showName: box.showName,
        venue: box.venue,
        showDate: boxDate,
        headIds,
        accessoryIds
      });
    }
  }
  return conflicts;
}

module.exports = {
  getOrder,
  openBorrowOrder,
  acceptReturn,
  completeRepair,
  changeExpectedReturn
};
