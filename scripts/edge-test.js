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
    throw error;
  }
  return json;
}

function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + (detail ? ' -> ' + detail : '')); }
}

async function main() {
  console.log('A. 补登记历史借单（归还日已过）直接已逾期');
  const overdue = await api('POST', '/api/loans', {
    troupeName: '补登记班',
    headIds: ['head-seed-2'],
    expectedReturnDate: '2026-09-01',
    loanDate: '2026-08-20'
  }, 201);
  check('开单即已逾期', overdue.status === '已逾期', overdue.status);
  check('逾期仍占用', overdue.occupiedHeadIds.includes('head-seed-2'));
  const blocked = await api('POST', '/api/loans/check', { headIds: ['head-seed-2'] });
  check('逾期借单中的偶头再借被挡', blocked.heads[0].available === false);

  console.log('B. 配件损伤（非缺失）走修补，再补齐');
  // 先归还逾期单（合格释放偶头）
  await api('POST', '/api/loans/' + overdue.id + '/return', {
    headLines: [{ headId: 'head-seed-2', paint: '合格', mechanism: '合格', accessories: '合格' }],
    accessoryLines: []
  });

  const loan = await api('POST', '/api/loans', {
    troupeName:'损伤测试班',
    headIds: ['head-seed-2'],
    accessoryIds: ['accessory-seed-2'],
    expectedReturnDate: '2026-12-01'
  }, 201);

  const ret = await api('POST', '/api/loans/' + loan.id + '/return', {
    headLines: [{ headId: 'head-seed-2', paint: '合格', mechanism: '合格', accessories: '合格' }],
    accessoryLines: [{ accessoryId: 'accessory-seed-2', present: true, condition: '不合格', conditionNote: '绒球压扁' }]
  });
  check('借单待修补', ret.loan.status === '待修补', ret.loan.status);
  const acc = await api('GET', '/api/accessories/accessory-seed-2');
  check('配件转待修补（不是遗失）', acc.status === '待修补', acc.status);
  check('生成缺损追踪且为损伤', ret.summary.repairedAccessories.length === 1);
  const lossId = ret.summary.repairedAccessories[0].lossReportId;

  const resolved = await api('POST', '/api/loans/losses/' + lossId + '/resolve', {
    loanId: loan.id, resolution: 'replenished', note: '修整复原'
  });
  check('补齐后借单结清', resolved.loan.status === '已归还');
  check('配件回库', (await api('GET', '/api/accessories/accessory-seed-2')).status === '在库');

  console.log('C. 确认遗失分支');
  const loan2 = await api('POST', '/api/loans', {
    troupeName: '遗失测试班',
    headIds: ['head-seed-2'],
    accessoryIds: ['accessory-seed-2'],
    expectedReturnDate: '2026-12-05'
  }, 201);
  const ret2 = await api('POST', '/api/loans/' + loan2.id + '/return', {
    headLines: [{ headId: 'head-seed-2', paint: '合格', mechanism: '合格', accessories: '合格' }],
    accessoryLines: [{ accessoryId: 'accessory-seed-2', present: false, note: '外团承认弄丢' }]
  });
  const loss2 = ret2.summary.lostAccessories[0].lossReportId;
  const confirmed = await api('POST', '/api/loans/losses/' + loss2 + '/resolve', {
    loanId: loan2.id, resolution: 'lost'
  });
  check('确认遗失后借单仍可结清（不再等配件）', confirmed.loan.status === '已归还', confirmed.loan.status);
  check('配件保持遗失态', (await api('GET', '/api/accessories/accessory-seed-2')).status === '遗失');
  check('占用清空', confirmed.loan.occupiedAccessoryIds.length === 0);

  console.log('D. 重复归还/重复完成被拒');
  let status = null;
  try {
    await api('POST', '/api/loans/' + loan2.id + '/return', {
      headLines: [], accessoryLines: []
    });
  } catch (e) { status = e.actualStatus; }
  check('已结清借单再验收 400', status === 400, String(status));

  console.log('E. 通用集合接口仍兼容（修补记录/缺损/装箱单/timeline）');
  const repairs = await api('GET', '/api/repairRecords');
  check('修补记录可查', Array.isArray(repairs) && repairs.length >= 1);
  const losses = await api('GET', '/api/lossReports');
  check('缺损追踪可查', Array.isArray(losses) && losses.length >= 2);
  const meta = await api('GET', '/api/meta');
  check('meta 含 loans/loanAcceptances',
    Boolean(meta.collections.loans && meta.collections.loanAcceptances));

  console.log('\n边界测试：' + passed + ' 通过，' + failed + ' 失败');
  process.exit(failed ? 1 : 0);
}

main().catch((error) => { console.error('测试中断：', error); process.exit(1); });
