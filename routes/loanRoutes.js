// 借还验收 HTTP 入口：只做参数透传，业务规则在 business/ 三个文件里。
const express = require('express');
const db = require('../lib/db');
const entry = require('../business/loanEntry');
const acceptance = require('../business/loanAcceptance');
const records = require('../business/loanRecords');

const router = express.Router();

function wrap(handler) {
  return (req, res, next) => {
    try {
      res.json(handler(req));
    } catch (error) {
      next(error);
    }
  };
}

// 未结借单（占用查询）
router.get('/open', (req, res) => {
  res.json(records.listOpenLoans());
});

// 借用前预检：偶头/配件能不能借、被哪张单子占着
router.post('/check', (req, res) => {
  const headIds = req.body.headIds || [];
  const accessoryIds = req.body.accessoryIds || [];
  res.json(entry.checkAvailability({ headIds, accessoryIds }));
});

// 开单登记
router.post('/', (req, res, next) => {
  try {
    res.status(201).json(entry.createLoan(req.body, req.body.actor));
  } catch (error) {
    next(error);
  }
});

// 借单详情
router.get('/:id', wrap((req) => records.requireLoan(req.params.id)));

// 某借单的验收单（旧单全部留档，按时间正序）
router.get('/:id/acceptances', wrap((req) => ({
  loan: records.requireLoan(req.params.id),
  acceptances: records.listAcceptances(req.params.id)
})));

// 改预计归还日：重查后续档期
router.patch('/:id/expected-return', (req, res, next) => {
  try {
    res.json(entry.rescheduleLoan(req.params.id, req.body, req.body.actor));
  } catch (error) {
    next(error);
  }
});

// 归还：妆面/机关/配件逐项验收
router.post('/:id/return', (req, res, next) => {
  try {
    res.json(acceptance.returnLoan(req.params.id, req.body, req.body.actor));
  } catch (error) {
    next(error);
  }
});

// 修复/补齐后人工复验
router.post('/:id/recheck', (req, res, next) => {
  try {
    res.json(acceptance.recheckLoan(req.params.id, req.body, req.body.actor));
  } catch (error) {
    next(error);
  }
});

// 修补完成（偶头恢复可出借，借单复验后结清）
router.post('/repairs/:repairId/complete', (req, res, next) => {
  try {
    res.json(acceptance.completeRepair(req.params.repairId, req.body, req.body.actor));
  } catch (error) {
    next(error);
  }
});

// 缺损补齐 / 确认遗失
router.post('/losses/:lossId/resolve', (req, res, next) => {
  try {
    res.json(acceptance.resolveLoss(req.params.lossId, req.body, req.body.actor));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
