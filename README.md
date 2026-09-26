# 传统木偶戏班偶头与巡演装箱API

维护偶头、服装配件、修补流转、巡演装箱、返场缺损追踪和外团借还验收。

## 启动

```bash
npm install
npm start
```

默认地址：http://localhost:3914

## 常用接口

- `GET /api/puppetHeads?play=火焰山&status=可演出`
- `POST /api/repairRecords`
- `POST /api/tourBoxes`
- `POST /api/lossReports`
- `GET /api/:collection/:id/timeline`

SQLite数据库文件会在首次启动时创建到`data/app.db`。

## 外团借还验收

借还单与验收单不走通用CRUD，写操作统一走下面的专用接口：

- `POST /api/borrow/orders` 开单登记：`{ troupe, headIds, accessoryIds, expectedReturnDate }`。
  未结借单占用的偶头/配件再借时返回409并指向原单；非「可演出/在库」状态的物品同样拦截。
- `POST /api/borrow/orders/:id/return` 归还验收：`{ checker, items: [...] }`。
  偶头逐项判定 `paint`（妆面）与 `mechanism`（机关），配件判定 `condition`（合格/不合格/缺失）。
  不合格的偶头转「待修补」并自动生成修补记录，物品继续占用、借单不结案；缺失配件记「遗失」。
- `POST /api/borrow/orders/:id/repair-done` 修复完成：关联修补记录全部「已完成」后才恢复可出借，
  全部物品放行后借单「已结案」。
- `PATCH /api/borrow/orders/:id/expected-return` 改预计归还日：自动重查后续巡演装箱档期，冲突返回409。
- `GET /api/borrow/orders` / `GET /api/borrow/orders/:id` / `GET /api/borrow/orders/:id/timeline`
  / `GET /api/borrow/checks?orderId=` 查询借单、时间线与验收单留档（旧验收单置「已归档」但保留可查）。

业务拆分：入口 `borrowRoutes.js`，验收规则 `borrowService.js`，记录保存 `borrowStore.js`。
