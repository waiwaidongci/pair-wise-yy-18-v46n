const express = require('express');
const service = require('./borrowService');
const store = require('./borrowStore');

// 外团借还验收的入口：只负责 HTTP 映射与错误码，规则都在 borrowService。

const router = express.Router();

function handle(fn, status) {
  return (req, res) => {
    try {
      const result = fn(req);
      res.status(status || 200).json(result);
    } catch (error) {
      const body = { error: error.message };
      if (error.details) body.details = error.details;
      res.status(error.status || 500).json(body);
    }
  };
}

// 借单列表与详情
router.get('/orders', handle((req) => {
  const filter = {};
  if (req.query.status) filter.statuses = [req.query.status];
  if (req.query.troupe) filter.troupe = req.query.troupe;
  return store.listOrders(filter);
}));

router.get('/orders/:id', handle((req) => {
  const order = service.getOrder(req.params.id);
  return { ...order, checks: store.listChecks(order.id) };
}));

router.get('/orders/:id/timeline', handle((req) => {
  const order = service.getOrder(req.params.id);
  return { record: order, events: store.listEvents(order.id) };
}));

// 开单登记：剧团、偶头、随附配件、预计归还日；未结借单占用会被拦截并指向原单
router.post('/orders', handle((req) => service.openBorrowOrder(req.body), 201));

// 归还验收：妆面/机关/配件逐项判定，不合格转待修补并继续占用
router.post('/orders/:id/return', handle((req) => service.acceptReturn({ ...req.body, orderId: req.params.id })));

// 修复完成：修补记录全部「已完成」后才恢复可出借
router.post('/orders/:id/repair-done', handle((req) => service.completeRepair({ ...req.body, orderId: req.params.id })));

// 改预计归还日：自动重查后续档期
router.patch('/orders/:id/expected-return', handle((req) => service.changeExpectedReturn({ ...req.body, orderId: req.params.id })));

// 验收单留档查询（含已归档旧单）
router.get('/checks', handle((req) => {
  let checks = store.listChecks(req.query.orderId);
  if (req.query.status) checks = checks.filter((check) => check.status === req.query.status);
  return checks;
}));

module.exports = router;
