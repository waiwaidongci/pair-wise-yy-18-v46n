# 传统木偶戏班偶头与巡演装箱API

维护偶头、服装配件、修补流转、巡演装箱、外团借还验收和返场缺损追踪。

## 启动

```bash
npm install
npm start
```

默认地址：http://localhost:3914

SQLite数据库文件会在首次启动时创建到`data/app.db`。

## 外团借还验收流程

### 1. 开单登记（入口）

`POST /api/loans`，登记剧团、偶头、随附配件、预计归还日：

```json
{
  "troupeName": "泉州南外布袋戏班",
  "contact": "陈班主",
  "phone": "13800000000",
  "headIds": ["head-seed-2"],
  "accessoryIds": ["accessory-seed-2"],
  "accessories": [{ "id": "accessory-seed-2", "name": "凤冠", "condition": "随单完好" }],
  "loanDate": "2026-09-26",
  "expectedReturnDate": "2026-10-10"
}
```

- 未结借单中（出借中/已逾期/待修补/待复验）的偶头或配件再借，一律 **409 挡住**，
  返回 `code: ITEMS_BLOCKED`，每件都带 `holdingLoan` 指向原借单（借单号、剧团、预计归还日）。
- 偶头非「可演出」、配件非「在库」同样挡住。
- 开单成功后偶头/配件置「出借中」，借单保存占用清单和配件开单快照。
- `POST /api/loans/check` 可只做可借预检；`GET /api/loans/open` 查未结借单。
- 补登记的历史借单（预计归还日已过）直接以「已逾期」开单，仍占用。

### 2. 改预计归还日（重查后续档期）

`PATCH /api/loans/:id/expected-return`：

- 自动重查同一批偶头/配件的后续档期：其他未结借单 + 本团未闭环的巡演装箱计划
  （归还日晚于装箱/演出日即撞档）。
- 有冲突返回 **409** `SCHEDULE_CONFLICT` 并列出撞单；核对确认后加
  `"forceSchedule": true` 可强制改期。每次改期都在借单 `scheduleRechecks` 留痕。

### 3. 归还逐项验收（验收）

`POST /api/loans/:id/return`，按 **妆面、机关、随附配件** 逐项验收：

```json
{
  "inspector": "验收员乙",
  "headLines": [{
    "headId": "head-seed-2",
    "paint": "合格",
    "mechanism": "不合格",
    "mechanismNote": "转眼机关卡死",
    "accessories": "合格"
  }],
  "accessoryLines": [{
    "accessoryId": "accessory-seed-2",
    "present": false,
    "note": "凤冠未见交回"
  }]
}
```

- 必须逐项覆盖当前仍占用的偶头和配件，缺验收行返回 400。
- 一项不合格即整单不结清：借单转「待修补」，问题偶头转「待修补」、缺件转「遗失」、
  损件转「待修补」，**继续被借单占用**（再借仍被挡并指向原单）；
  自动生成修补记录（repairRecords）和缺损追踪（lossReports）。
- 修复完成：`POST /api/loans/repairs/:repairId/complete`，偶头恢复「可演出」；
  缺件补齐/确认遗失：`POST /api/loans/losses/:lossId/resolve`。
- 全部问题了结后自动复验合格、解除全部占用，借单才转「已归还」；
  也可 `POST /api/loans/:id/recheck` 人工复验。

### 4. 旧验收单留档（记录保存）

- 每次验收/复验都新开一张验收单（loanAcceptances），**只追加，不改写、不删除**
  （通用 PATCH/DELETE 对借单和验收单返回 405）。
- `GET /api/loans/:id/acceptances` 按时间正序查全部留档；
  `GET /api/loans/:id/timeline` 查借单完整事件链。

代码按职责拆三块：`business/loanEntry.js`（入口/开单/改期）、
`business/loanAcceptance.js`（验收/修复复验）、`business/loanRecords.js`（建档/占用/留档）。

## 其他常用接口

- `GET /api/puppetHeads?play=火焰山&status=可演出`
- `POST /api/repairRecords`
- `POST /api/tourBoxes`（可带 `loadDate`，供借单改期查撞档）
- `POST /api/lossReports`
- `GET /api/:collection/:id/timeline`
