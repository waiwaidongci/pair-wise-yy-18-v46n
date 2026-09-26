module.exports = {
  port: 3914,
  title: '传统木偶戏班偶头与巡演装箱API',
  description: '维护偶头、服装配件、修补流转、巡演装箱、外团借还验收和返场缺损追踪。',
  collections: {
    puppetHeads: {
      label: '偶头档案',
      defaultStatus: '可演出',
      statuses: ['可演出', '出借中', '待修补', '修补中', '试演中', '不可演出', '已装箱'],
      required: ['role', 'play', 'paintStatus', 'mechanism', 'boxNo'],
      titleFields: ['role', 'play'],
      defaults: { currentUsable: true }
    },
    accessories: {
      label: '服装配件',
      defaultStatus: '在库',
      statuses: ['在库', '出借中', '已装箱', '缺损', '待修补', '遗失'],
      required: ['name', 'role', 'play', 'boxNo'],
      titleFields: ['name', 'role']
    },
    repairRecords: {
      label: '修补记录',
      defaultStatus: '待处理',
      statuses: ['待处理', '补漆中', '换线中', '修机关中', '换眼珠中', '试演中', '已完成'],
      required: ['puppetHeadId', 'repairType', 'handler'],
      titleFields: ['repairType', 'handler']
    },
    tourBoxes: {
      label: '巡演装箱单',
      defaultStatus: '草稿',
      statuses: ['草稿', '已装箱', '巡演中', '返场清点中', '已闭环'],
      required: ['showName', 'venue', 'play', 'headIds', 'accessoryIds'],
      titleFields: ['showName', 'play']
    },
    lossReports: {
      label: '缺损追踪',
      defaultStatus: '待处理',
      statuses: ['待处理', '修复中', '已补齐', '确认为遗失'],
      required: ['itemType', 'itemName', 'problem'],
      titleFields: ['itemName', 'problem']
    },
    loans: {
      label: '外团借用借单',
      defaultStatus: '出借中',
      statuses: ['出借中', '已逾期', '待修补', '待复验', '已归还'],
      required: ['troupeName', 'headIds', 'expectedReturnDate'],
      titleFields: ['loanNo', 'troupeName'],
      defaults: { accessoryIds: [] }
    },
    loanAcceptances: {
      label: '借还验收单',
      defaultStatus: '不合格',
      statuses: ['合格', '不合格'],
      required: ['loanId', 'headLines', 'accessoryLines'],
      titleFields: ['loanId', 'inspector']
    }
  },
  seed: [
    {
      collection: 'puppetHeads',
      id: 'head-seed-1',
      status: '待修补',
      data: {
        role: '武生',
        play: '火焰山',
        paintStatus: '左颊掉彩',
        mechanism: '开口机关偏紧',
        accessories: ['红缨冠', '短靠'],
        boxNo: '木箱乙-04',
        currentUsable: false
      },
      note: '返场发现掉彩'
    },
    {
      collection: 'puppetHeads',
      id: 'head-seed-2',
      status: '可演出',
      data: {
        role: '花旦',
        play: '火焰山',
        paintStatus: '妆面完好',
        mechanism: '转眼机关顺畅',
        accessories: ['凤冠'],
        boxNo: '木箱甲-01',
        currentUsable: true
      },
      note: '可出借'
    },
    {
      collection: 'accessories',
      id: 'accessory-seed-1',
      status: '在库',
      data: {
        name: '红缨冠',
        role: '武生',
        play: '火焰山',
        boxNo: '配件箱-02'
      }
    },
    {
      collection: 'accessories',
      id: 'accessory-seed-2',
      status: '在库',
      data: {
        name: '凤冠',
        role: '花旦',
        play: '火焰山',
        boxNo: '配件箱-02'
      }
    }
  ],
  examples: [
    'GET /api/puppetHeads?play=火焰山&status=可演出 查询某剧目可用偶头',
    'POST /api/tourBoxes 创建巡演装箱单',
    'POST /api/loans 外团借用开单登记（自动挡住未结借单中的偶头/配件）',
    'POST /api/loans/:id/return 归还按妆面/机关/配件逐项验收',
    'POST /api/lossReports 登记返场缺损或遗失'
  ]
};
