// config.js

module.exports = {
  gitlab: {
    baseUrl: 'http://gitlab.devdemo.trs.net.cn',
    userId: 140,
    token: process.env.GITLAB_TOKEN,
    authorNames: ['陈曦', 'chen.xi', 'Chen Xi'],
    authorEmails: ['chen.xi@trs.com.cn', 'chen.xi@devdemo.trs.net.cn']
  },

  jira: {
    baseUrl: 'http://jira.devdemo.trs.net.cn/browse/'
  },

  projectGroupMap: {
    21: '海云',
    37: '问政互动',
    99: '资源库',
    104: '监测云',
    147: 'WCM_USE内嵌前端（uirb-tran-app）',
    246: '海星',
    289: '海星问卷',
    341: '智能检索',
    353: '智能检索web端',
    665: '问政互动个人中心',
    689: '贵州APP-运营管理平台',
    691: '贵州APP-服务号管理平台',
    692: '组件库',
    836: '政策审核平台',
    838: '网脉',
    845: '云哨APP',
    879: '数据审核平台',
    1020: '图表绘制（chart-app）',
    1022: '图表绘制中间件（mcp-server-chart）',
    1094: '动态本体'
  },

  noTypeProjectIds: [
    1094 // 动态本体
  ],

  statusColorMap: {
    已完成: '#00b14d',
    处理中: '#04b0f1',
    待处理: '#4472c6',
    已拒绝: '#fcc102'
  },

  typeColorMap: {
    需求: '#92d04f',
    定制化: '#fcc102',
    漏洞: '#c10002',
    安全漏洞: '#c10002',
    低版本补丁: '#c10002',
    咨询: '#0071c1',
    部署: '#04b0f1'
  },

  groupOrder: [
    '海云',
    '动态本体',
    '问政互动',
    '海星',
    '智能检索',
    '监测云',
    '资源库',
    '网脉'
  ],

  output: {
    dir: './weekly-output',
    htmlFile: 'weekly-report.html',
    mdFile: 'weekly-report.md',
    normalizedJsonFile: 'weekly-report.normalized.json'
  },

  filters: {
    ignoreMergeCommit: true,
    ignorePushedNew: true,
    maxCommitCountPerPush: 20
  },

  enableSectionTitle: false
}
