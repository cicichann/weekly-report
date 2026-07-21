'use strict';

const fs = require('fs');
const path = require('path');
const { ensureDir, replaceFileAtomic } = require('./utils/files');
const { formatDisplayDate } = require('./utils/dates');
const { OutputError } = require('./errors');

const DEFAULT_STATUS_COLOR_MAP = {
  '已完成': '#00b14d',
  '处理中': '#04b0f1',
  '待处理': '#4472c6',
  '已拒绝': '#fcc102'
};

const DEFAULT_TYPE_COLOR_MAP = {
  '需求': '#92d04f',
  '定制化': '#fcc102',
  '漏洞': '#c10002',
  '安全漏洞': '#c10002',
  '低版本补丁': '#c10002',
  '咨询': '#0071c1',
  '部署': '#04b0f1'
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function groupItems(items) {
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.group)) groups.set(item.group, []);
    groups.get(item.group).push(item);
  }
  return groups;
}

function formatMonthDay(dateString) {
  const match = String(dateString || '').match(/^\d{4}-(\d{2})-(\d{2})$/);
  return match ? `${Number(match[1])}-${match[2]}` : '';
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, '').trim();
}

function toChineseNumber(value) {
  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  if (value <= 10) return value === 10 ? '十' : digits[value];
  if (value < 20) return `十${digits[value % 10]}`;
  if (value < 100) return `${digits[Math.floor(value / 10)]}十${value % 10 ? digits[value % 10] : ''}`;
  return String(value);
}

function getColorMaps(config = {}) {
  return {
    status: { ...DEFAULT_STATUS_COLOR_MAP, ...(config.statusColorMap || {}) },
    type: { ...DEFAULT_TYPE_COLOR_MAP, ...(config.typeColorMap || {}) }
  };
}

function getTypeColor(type, colorMaps) {
  const colors = colorMaps.type;
  return colors[type] || '#595959';
}

function getStatusColor(status, colorMaps) {
  const colors = colorMaps.status;
  return colors[status] || '#333333';
}

function renderCopyStatus(item, colorMaps) {
  const status = String(item.status || '').trim();
  const detail = String(item.detail || '').trim();
  const remark = String(item.remark || '').trim();
  const parts = [];
  if (status) {
    parts.push(`<span style="color:${getStatusColor(status, colorMaps)};">${escapeHtml(status)}</span>`);
  }
  if (detail && normalizeText(detail) !== normalizeText(item.title)) {
    parts.push(escapeHtml(detail));
  }
  if (remark) parts.push(escapeHtml(remark));
  return parts.length ? ` （${parts.join('。')}）` : '';
}

function renderJira(item) {
  const jira = String(item.jira || '').trim();
  if (!jira) return '';
  return item.jiraUrl
    ? `<a href="${escapeHtml(item.jiraUrl)}" target="_blank">${escapeHtml(jira)}</a>`
    : escapeHtml(jira);
}

function renderCopyItem(item, colorMaps) {
  const date = formatMonthDay(item.date);
  const project = item.projectName || item.product || '';
  const issueType = String(item.issueType || '').trim();
  const dateHtml = date ? `【${escapeHtml(date)}】` : '';
  const projectHtml = project ? `【${escapeHtml(project)}】` : '';
  const typeHtml = issueType
    ? `<span style="color:${getTypeColor(issueType, colorMaps)};">【${escapeHtml(issueType)}】</span>`
    : '';
  const jiraHtml = renderJira(item);
  const ownerHtml = item.owner ? `（${escapeHtml(item.owner)}）` : '';
  return `<li>${dateHtml}${projectHtml}${typeHtml ? ` ${typeHtml}` : ''} ${jiraHtml ? `${jiraHtml} ` : ''}${escapeHtml(item.title)}${ownerHtml}${renderCopyStatus(item, colorMaps)}</li>`;
}

function renderCopyContent(groups, hasItems, colorMaps = getColorMaps()) {
  if (!hasItems) return '<h2>本周工作总结</h2><p>无</p>';
  const sections = [...groups.entries()].map(([group, items], index) => `
    <h3>${toChineseNumber(index + 1)}、${escapeHtml(group)}</h3>
    <ol>
      ${items.map(item => renderCopyItem(item, colorMaps)).join('\n      ')}
    </ol>
    <br>`).join('\n');
  return `<h2>本周工作总结</h2>\n${sections}`;
}

function renderRows(items, colorMaps) {
  return items.map(item => `
    <tr>
      <td class="number">${item.index}</td>
      <td class="date">${escapeHtml(formatDisplayDate(item.date))}</td>
      <td>${escapeHtml(item.product)}</td>
      <td>${escapeHtml(item.projectName)}</td>
      <td><span style="color:${getTypeColor(item.issueType, colorMaps)};font-weight:600;">${escapeHtml(item.issueType)}</span></td>
      <td>${renderJira(item)}</td>
      <td class="content">${escapeHtml(item.title)}</td>
      <td>${escapeHtml(item.owner)}</td>
      <td>${escapeHtml(item.feedbackPerson)}</td>
      <td><span class="status" style="color:${getStatusColor(item.status, colorMaps)};">${escapeHtml(item.status)}</span></td>
      <td>${escapeHtml(item.detail)}</td>
      <td>${escapeHtml(item.remark)}</td>
      <td><code>${escapeHtml(item.shortSha)}</code></td>
    </tr>`).join('');
}

function renderHtml(snapshot, config = {}) {
  const colorMaps = getColorMaps(config);
  const groups = groupItems(snapshot.items);
  const auditSections = [...groups.entries()].map(([group, items]) => `
    <section class="audit-section">
      <h2>${escapeHtml(group)} <small>${items.length} 项</small></h2>
      <div class="table-wrap"><table>
        <thead><tr><th>序号</th><th>日期</th><th>产品</th><th>项目</th><th>问题类型</th><th>JIRA编号</th><th>工作内容</th><th>负责人</th><th>反馈人</th><th>状态</th><th>处理详情</th><th>备注</th><th>Commit</th></tr></thead>
        <tbody>${renderRows(items, colorMaps)}</tbody>
      </table></div>
    </section>`).join('');

  const auditEmpty = snapshot.items.length ? '' : '<div class="empty">本周暂无符合条件的提交记录。</div>';
  const copyContent = renderCopyContent(groups, snapshot.items.length > 0, colorMaps);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="report-item-count" content="${snapshot.items.length}">
  <title>周报 ${escapeHtml(snapshot.period.reportStart)} 至 ${escapeHtml(snapshot.period.reportEnd)}</title>
  <style>
    :root { color-scheme: light; --blue:#2f5597; --line:#dfe5ef; --bg:#f5f7fb; --text:#1f2937; }
    * { box-sizing: border-box; }
    body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; color:var(--text); background:var(--bg); }
    main { max-width:1440px; margin:0 auto; padding:24px 24px 48px; }
    header { display:flex; justify-content:space-between; gap:20px; align-items:end; margin-bottom:24px; }
    h1 { margin:0 0 6px; font-size:28px; color:#17365d; }
    .period,.summary { color:#64748b; }
    .summary strong { font-size:24px; color:var(--blue); }
    .toolbar { position:sticky; top:0; z-index:10; display:flex; align-items:center; gap:8px; padding:12px; margin:0 0 20px; background:rgba(255,255,255,.96); border:1px solid #e2e8f0; border-radius:10px; box-shadow:0 4px 14px rgba(15,23,42,.08); }
    button { border:1px solid #cbd5e1; background:white; color:#334155; border-radius:6px; padding:7px 13px; cursor:pointer; font-size:14px; }
    button:hover { border-color:#4472c4; color:#2f5597; }
    button.active { background:#eaf1ff; border-color:#4472c4; color:#2f5597; font-weight:600; }
    #copyBtn { margin-left:auto; border-color:#1677ff; background:#1677ff; color:white; }
    #copyTip { color:#15803d; font-size:13px; min-width:170px; }
    [hidden] { display:none !important; }
    .audit-section,.copy-card { margin:20px 0; padding:20px; background:white; border:1px solid #e8edf5; border-radius:12px; box-shadow:0 4px 18px rgba(30,64,175,.06); }
    .audit-section h2 { margin:0 0 14px; font-size:19px; color:#244a7c; }
    .audit-section h2 small { font-size:13px; font-weight:500; color:#718096; }
    .table-wrap { overflow-x:auto; }
    table { width:100%; border-collapse:collapse; font-size:14px; }
    th { background:#4472c4; color:white; text-align:left; white-space:nowrap; }
    th,td { padding:10px 12px; border:1px solid var(--line); vertical-align:top; }
    tbody tr:nth-child(even) { background:#f8fafc; }
    .number,.date { white-space:nowrap; text-align:center; }
    .content { min-width:300px; }
    .status { display:inline-block; padding:2px 8px; border-radius:999px; background:#f1f5f9; white-space:nowrap; font-weight:600; }
    code { color:#334155; font-size:12px; }
    .empty { padding:40px; text-align:center; background:white; border-radius:12px; color:#64748b; }
    #copyContent { max-width:920px; font-size:14.5px; line-height:1.8; color:#333; }
    #copyContent h2 { font-size:20px; margin:0 0 12px; }
    #copyContent h3 { font-size:18px; margin:16px 0 8px; }
    #copyContent ol { margin:0 0 12px 24px; padding:0; }
    #copyContent li { margin:4px 0; }
    @media print { body { background:white; } main { max-width:none; padding:0; } .toolbar { display:none; } .audit-section,.copy-card { box-shadow:none; break-inside:avoid; } }
  </style>
</head>
<body><main>
  <div class="toolbar">
    <button type="button" class="view-btn active" data-view="audit">数据审核</button>
    <button type="button" class="view-btn" data-view="copy">钉钉预览</button>
    <button type="button" id="copyBtn">复制钉钉内容</button>
    <span id="copyTip"></span>
  </div>
  <header>
    <div><h1>工作周报</h1><div class="period">${formatDisplayDate(snapshot.period.reportStart)} ～ ${formatDisplayDate(snapshot.period.reportEnd)}</div></div>
    <div class="summary">共 <strong>${snapshot.items.length}</strong> 项</div>
  </header>
  <div id="auditView">${auditEmpty}${auditSections}</div>
  <div id="copyView" hidden>
    <section class="copy-card">
      <div id="copyContent"><div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;font-size:14.5px;line-height:1.8;color:#333333;">${copyContent}</div></div>
    </section>
  </div>
</main>
<script>
  const auditView = document.getElementById('auditView');
  const copyView = document.getElementById('copyView');
  const viewButtons = Array.from(document.querySelectorAll('.view-btn'));
  const copyButton = document.getElementById('copyBtn');
  const copyTip = document.getElementById('copyTip');

  function setView(view) {
    const showCopy = view === 'copy';
    auditView.hidden = showCopy;
    copyView.hidden = !showCopy;
    viewButtons.forEach(button => button.classList.toggle('active', button.dataset.view === view));
  }

  viewButtons.forEach(button => button.addEventListener('click', () => {
    setView(button.dataset.view);
    copyTip.textContent = '';
  }));

  copyButton.addEventListener('click', async () => {
    setView('copy');
    const content = document.getElementById('copyContent');
    const html = content.innerHTML;
    const plainText = content.innerText;
    let copied = false;

    if (navigator.clipboard && window.ClipboardItem) {
      try {
        await navigator.clipboard.write([new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([plainText], { type: 'text/plain' })
        })]);
        copied = true;
      } catch (_) {
        copied = false;
      }
    }

    if (!copied) {
      const range = document.createRange();
      range.selectNodeContents(content);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      copied = document.execCommand('copy');
      selection.removeAllRanges();
    }

    copyTip.textContent = copied ? '已复制，可直接粘贴到钉钉' : '复制失败，请手动选择预览内容';
  });
</script>
</body></html>`;
}

async function generateHtml(snapshot, config, targetFile) {
  await ensureDir(path.dirname(targetFile));
  const tempFile = `${targetFile}.${process.pid}.tmp`;
  try {
    await fs.promises.writeFile(tempFile, renderHtml(snapshot, config), 'utf8');
    await replaceFileAtomic(tempFile, targetFile);
  } catch (error) {
    throw new OutputError(`HTML 生成失败：${error.message}`, {
      code: 'HTML_GENERATION_FAILED', details: { targetFile }
    });
  }
  return { file: targetFile, rows: snapshot.items.length };
}

module.exports = {
  generateHtml,
  renderHtml,
  renderCopyContent,
  renderCopyItem,
  getColorMaps,
  escapeHtml
};
