const BASE = 'http://localhost:3914';
let passed = 0;
let failed = 0;

async function api(method, path, body, expectedStatus = 200) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (res.status !== expectedStatus) {
    const error = new Error(method + ' ' + path + ' 期望 ' + expectedStatus + ' 实际 ' + res.status + '：' + text);
    error.actualStatus = res.status;
    error.body = json;
    throw error;
  }
  return json;
}

// 断言请求必然以 400 失败（fetch 不会因 4xx 抛异常，需显式判断）
async function expect400(description, method, path, body) {
  try {
    await api(method, path, body, 400);
    return true;
  } catch (error) {
    if (error.actualStatus === 400) return true;
    console.error('    [' + description + '] 非预期异常: ' + error.message);
    return false;
  }
}

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log('  ✓ ' + name);
  } else {
    failed++;
    console.error('  ✗ ' + name + (detail ? ' -> ' + detail : ''));
  }
}

async function main() {
  console.log('1. 开单登记（花旦 + 凤冠，借给外团）');
  const loan = await api('POST', '/api/loans', {
    troupeName: '泉州南外布袋戏班',
    contact: '陈班主',
    phone: '13800000000',
    headIds: ['head-seed-2'],
    accessoryIds: ['accessory-seed-2'],
    accessories: [{ id: 'accessory-seed-2', name: '凤冠', condition: '随单完好' }],
    expectedReturnDate: '2026-10-10',
    actor: '保管员甲'
  }, 201);
  check('借单状态为出借中', loan.status === '出借中', loan.status);
  check('占用列表包含偶头和配件',
    loan.occupiedHeadIds.includes('head-seed-2') && loan.occupiedAccessoryIds.includes('accessory-seed-2'));

  const headAfterLoan = await api('GET', '/api/puppetHeads/head-seed-2');
  check('偶头状态变出借中', headAfterLoan.status === '出借中', headAfterLoan.status);
  const accAfterLoan = await api('GET', '/api/accessories/accessory-seed-2');
  check('配件状态变出借中', accAfterLoan.status === '出借中', accAfterLoan.status);

  console.log('2. 未结借单中的偶头/配件再借 -> 409 挡住并指向原单');
  const block = await api('POST', '/api/loans', {
    troupeName: '漳州过路班',
    headIds: ['head-seed-2'],
    accessoryIds: ['accessory-seed-2'],
    expectedReturnDate: '2026-10-05'
  }, 409);
  check('返回 ITEMS_BLOCKED', block.code === 'ITEMS_BLOCKED', block.code);
  check('挡住2件', block.blocked.length === 2, String(block.blocked.length));
  check('指向原借单号', block.blocked[0].holdingLoan && block.blocked[0].holdingLoan.loanNo === loan.loanNo,
    JSON.stringify(block.blocked[0].holdingLoan));

  console.log('3. 非可出借状态（待修补的武生）再借 -> 409');
  const block2 = await api('POST', '/api/loans', {
    troupeName: '漳州过路班',
    headIds: ['head-seed-1'],
    expectedReturnDate: '2026-10-05'
  }, 409);
  check('武生被挡', !block2.blocked[0].available && block2.blocked[0].currentStatus === '待修补',
    JSON.stringify(block2.blocked[0]));

  console.log('4. 借用前预检接口');
  const avail = await api('POST', '/api/loans/check', {
    headIds: ['head-seed-2', 'head-seed-1']
  });
  check('预检返回2项一占一不可借', avail.heads.length === 2 && !avail.available);

  console.log('5. 缺必填/日期非法 -> 400');
  check('日期格式非法被拒', await expect400('日期非法', 'POST', '/api/loans',
    { troupeName: 'x', headIds: ['head-seed-1'], expectedReturnDate: '10/10' }));
  check('缺剧团名被拒', await expect400('缺剧团', 'POST', '/api/loans',
    { headIds: ['head-seed-1'], expectedReturnDate: '2026-10-01' }));
  check('缺偶头被拒', await expect400('缺偶头', 'POST', '/api/loans',
    { troupeName: 'x', headIds: [], expectedReturnDate: '2026-10-01' }));
  check('归还日早于出借日被拒', await expect400('日期倒置', 'POST', '/api/loans',
    { troupeName: 'x', headIds: ['head-seed-1'], loanDate: '2026-10-05', expectedReturnDate: '2026-10-01' }));

  console.log('6. 改预计归还日：重查后续档期');
  // 本团已有 10-08 装箱的巡演计划，会用到花旦
  await api('POST', '/api/tourBoxes', {
    showName: '金秋闽南巡演',
    venue: '厦门艺术剧场',
    play: '火焰山',
    headIds: ['head-seed-2'],
    accessoryIds: [],
    loadDate: '2026-10-08',
    actor: '剧务'
  }, 201);

  // 改早不冲突
  const resched1 = await api('PATCH', '/api/loans/' + loan.id + '/expected-return', {
    expectedReturnDate: '2026-09-30',
    actor: '保管员甲'
  });
  check('改早无冲突成功', resched1.loan.expectedReturnDate === '2026-09-30');
  check('留了改期重查记录', resched1.loan.scheduleRechecks.length === 1);

  // 改到 10-12 晚于装箱日 10-08 -> 409 撞档
  const conflictRes = await api('PATCH', '/api/loans/' + loan.id + '/expected-return', {
    expectedReturnDate: '2026-10-12'
  }, 409);
  check('撞巡演档期返回 SCHEDULE_CONFLICT', conflictRes.code === 'SCHEDULE_CONFLICT', conflictRes.code);
  check('冲突指向巡演装箱单',
    conflictRes.conflicts[0] && conflictRes.conflicts[0].tourBoxId && conflictRes.conflicts[0].useDate === '2026-10-08',
    JSON.stringify(conflictRes.conflicts));

  // 确认撞单后强制改期
  const resched2 = await api('PATCH', '/api/loans/' + loan.id + '/expected-return', {
    expectedReturnDate: '2026-10-12',
    forceSchedule: true,
    actor: '保管员甲'
  });
  check('强制改期成功并标记forced', resched2.loan.scheduleRechecks[1].forced === true);
  check('强制改期记录撞档数1', resched2.loan.scheduleRechecks[1].conflictCount === 1);

  console.log('7. 归还验收：缺验收行 -> 400');
  check('逐项覆盖校验生效', await expect400('缺验收行', 'POST', '/api/loans/' + loan.id + '/return',
    { headLines: [], accessoryLines: [] }));

  console.log('8. 归还验收：机关损伤 + 配件缺失 -> 不合格转待修补继续占用');
  const ret = await api('POST', '/api/loans/' + loan.id + '/return', {
    inspector: '验收员乙',
    headLines: [{
      headId: 'head-seed-2',
      paint: '合格',
      mechanism: '不合格',
      mechanismNote: '转眼机关卡死',
      accessories: '合格'
    }],
    accessoryLines: [{
      accessoryId: 'accessory-seed-2',
      present: false,
      note: '凤冠未见交回'
    }],
    note: '验收不合格',
    actor: '验收员乙'
  });
  check('借单转待修补', ret.loan.status === '待修补', ret.loan.status);
  check('偶头转待修补', (await api('GET', '/api/puppetHeads/head-seed-2')).status === '待修补');
  check('配件转遗失', (await api('GET', '/api/accessories/accessory-seed-2')).status === '遗失');
  check('偶头继续占用', ret.loan.occupiedHeadIds.includes('head-seed-2'));
  check('配件继续占用', ret.loan.occupiedAccessoryIds.includes('accessory-seed-2'));
  check('生成修补记录', ret.summary.repairedHeads.length === 1, JSON.stringify(ret.summary));
  check('生成缺损追踪', ret.summary.lostAccessories.length === 1);
  check('挂起问题2件', ret.loan.openIssues.filter((i) => !i.resolvedAt).length === 2);

  const repairId = ret.summary.repairedHeads[0].repairRecordId;
  const lossId = ret.summary.lostAccessories[0].lossReportId;

  console.log('9. 待修补期间再借仍被挡住（指向原单）');
  const block3 = await api('POST', '/api/loans/check', { headIds: ['head-seed-2'] });
  check('待修补偶头不可借', block3.heads[0].available === false);
  check('指向原借单', block3.heads[0].holdingLoan && block3.heads[0].holdingLoan.loanId === loan.id);

  console.log('10. 修复完成：偶头恢复可出借；借单待复验（配件还缺）');
  const repaired = await api('POST', '/api/loans/repairs/' + repairId + '/complete', {
    loanId: loan.id,
    note: '换线修复转眼机关',
    actor: '木匠师傅'
  });
  check('修复后借单待复验', repaired.loan.status === '待复验', repaired.loan.status);
  check('偶头恢复可演出', (await api('GET', '/api/puppetHeads/head-seed-2')).status === '可演出');
  check('偶头已摘除占用', !repaired.loan.occupiedHeadIds.includes('head-seed-2'));
  check('配件仍占用', repaired.loan.occupiedAccessoryIds.includes('accessory-seed-2'));
  check('未自动生成结清验收单', repaired.acceptance === null);

  console.log('11. 配件补齐');
  const resolved = await api('POST', '/api/loans/losses/' + lossId + '/resolve', {
    loanId: loan.id,
    resolution: 'replenished',
    note: '新做凤冠一顶补齐',
    actor: '保管员甲'
  });
  check('全部了结后借单已归还', resolved.loan.status === '已归还', resolved.loan.status);
  check('占用全清空', resolved.loan.occupiedHeadIds.length === 0 && resolved.loan.occupiedAccessoryIds.length === 0);
  check('配件回库', (await api('GET', '/api/accessories/accessory-seed-2')).status === '在库');
  check('自动开复验合格验收单', resolved.acceptance && resolved.acceptance.result === '合格');

  console.log('12. 旧验收单留档（不合格单+复验单都在）');
  const archive = await api('GET', '/api/loans/' + loan.id + '/acceptances');
  check('共2张验收单', archive.acceptances.length === 2, String(archive.acceptances.length));
  check('首张不合格、复验合格',
    archive.acceptances[0].result === '不合格' && archive.acceptances[1].result === '合格');

  console.log('13. 结清后同一批可再借');
  const loan2 = await api('POST', '/api/loans', {
    troupeName: '厦门同乐班',
    headIds: ['head-seed-2'],
    accessoryIds: ['accessory-seed-2'],
    expectedReturnDate: '2026-11-01',
    actor: '保管员甲'
  }, 201);
  check('再借成功', loan2.status === '出借中');

  console.log('14. 全合格归还当场结清');
  const ret2 = await api('POST', '/api/loans/' + loan2.id + '/return', {
    inspector: '验收员乙',
    headLines: [{ headId: 'head-seed-2', paint: '合格', mechanism: '合格', accessories: '合格' }],
    accessoryLines: [{ accessoryId: 'accessory-seed-2', present: true, condition: '合格' }]
  });
  check('当场已归还', ret2.loan.status === '已归还',
    ret2.loan.status + ' occ=' + JSON.stringify(ret2.loan.occupiedHeadIds) + '/' + JSON.stringify(ret2.loan.occupiedAccessoryIds) + ' summary=' + JSON.stringify(ret2.summary));
  check('验收单合格', ret2.acceptance.result === '合格');

  console.log('15. 时间线留痕（借单事件链）');
  const timeline = await api('GET', '/api/loans/' + loan.id + '/timeline');
  const actions = timeline.events.map((e) => e.action);
  check('含开单/改期/验收/复验等事件',
    actions.includes('开单登记') && actions.includes('归还验收不合格转待修补') && actions.includes('配件补齐待复验'),
    actions.join(' | '));

  console.log('\n结果：' + passed + ' 通过，' + failed + ' 失败');
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error('测试中断：', error);
  process.exit(1);
});
