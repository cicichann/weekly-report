#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const { exec } = require('child_process')
const ExcelJS = require('exceljs')

const config = require('./config')

const {
  jira,
  projectGroupMap,
  noTypeProjectIds,
  statusColorMap,
  typeColorMap,
  groupOrder,
  output,
  enableSectionTitle
} = config

const JIRA_BASE_URL = jira.baseUrl

const excelConfig = {
  file: './周报.xlsx',
  sheetName: '当周数据维护',
  startRow: 2,
  endRow: 100,
  ...config.excel
}

const outputConfig = {
  dir: output.dir,
  htmlFile: output.htmlFile,
  mdFile: output.mdFile,
  normalizedJsonFile: output.normalizedJsonFile,
  gitJsonFile: 'weekly-report.git-commits.json',
  validationFile: 'weekly-report.validation.json',
  ...output
}

main().catch((error) => {
  console.error('执行失败：')
  console.error(error)
  process.exit(1)
})

async function main() {
  const gitItems = readGitItems()
  const excelItems = await readExcelItems()
  const finalItems = mergeItems(gitItems, excelItems)

  const validationErrors = validateItems(finalItems)

  generateReport(finalItems, {
    gitCount: gitItems.length,
    excelCount: excelItems.length,
    validationErrors
  })
}

function resolveProjectFile(filePath) {
  return path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath)
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function getOutputDir() {
  const outputDir = resolveProjectFile(outputConfig.dir || './weekly-output')
  ensureDir(outputDir)
  return outputDir
}

function getOutputPath(fileName) {
  return path.join(getOutputDir(), fileName)
}

function normalizeText(text = '') {
  return String(text)
    .replace(/\s+/g, '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .trim()
}

function cleanText(value = '') {
  return String(value || '').trim()
}

function extractCommitMarker(text) {
  const match = String(text || '').match(/\[commit:([a-f0-9]{7,40})\]/i)
  return match ? match[1] : ''
}

function cleanRemark(text) {
  return String(text || '')
    .replace(/\[commit:[a-f0-9]{7,40}\]/gi, '')
    .trim()
}

function formatDateOnly(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')

  return `${year}-${month}-${day}`
}

function formatMonthDay(dateStr) {
  const date = new Date(dateStr)

  if (Number.isNaN(date.getTime())) {
    return ''
  }

  return `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, '0')}`
}

function readCellText(row, col) {
  const value = row.getCell(col).value

  if (value === null || value === undefined) return ''
  if (value instanceof Date) return formatDateOnly(value)

  if (typeof value === 'object') {
    if (value.text) return String(value.text).trim()
    if (value.result !== undefined && value.result !== null) {
      return String(value.result).trim()
    }
    if (Array.isArray(value.richText)) {
      return value.richText
        .map((item) => item.text)
        .join('')
        .trim()
    }
    if (value.hyperlink && value.text) return String(value.text).trim()
  }

  return String(value).trim()
}

function readGitItems() {
  const jsonPath = getOutputPath(outputConfig.gitJsonFile)

  if (!fs.existsSync(jsonPath)) {
    console.warn(`未找到 Git commit JSON，仅使用 Excel 数据：${jsonPath}`)
    return []
  }

  const content = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
  const records = Array.isArray(content) ? content : content.records || []

  return records.map(normalizeGitItem).filter(hasReportContent)
}

function normalizeGitItem(item, index) {
  const jiraNo = cleanText(item.jira)
  const resolveDate = cleanText(item.resolveDate)
  const typeLabel = cleanText(item.typeLabel)

  return {
    source: 'json',
    sortIndex: 100000 + index,
    commit_id: cleanText(item.commit_id || item.commitId),
    short_id: cleanText(item.short_id || item.shortId),
    project_id: item.project_id,
    group: cleanText(item.group),
    resolveDate,
    date:
      cleanText(item.date) ||
      (resolveDate ? formatMonthDay(`${resolveDate}T00:00:00+08:00`) : ''),
    project: cleanText(item.project),
    jira: jiraNo,
    jiraUrl: jiraNo ? `${JIRA_BASE_URL}${jiraNo}` : '',
    description: cleanText(item.description),
    taskDescription: cleanText(item.taskDescription || item.description),
    detail: cleanText(item.detail),
    owner: cleanText(item.owner),
    status: cleanText(item.status || '已完成'),
    remark: cleanRemark(item.remark),
    screenshot: cleanText(item.screenshot),
    typeLabel,
    typeColor: typeLabel ? typeColorMap[typeLabel] || '#8c8c8c' : '',
    type: item.type || 'thisWeek'
  }
}

async function readExcelItems() {
  const excelPath = resolveProjectFile(excelConfig.file)

  if (!fs.existsSync(excelPath)) {
    console.warn(`未找到 Excel 文件，仅使用 JSON 数据：${excelPath}`)
    return []
  }

  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(excelPath)

  const ws = workbook.getWorksheet(excelConfig.sheetName)

  if (!ws) {
    throw new Error(`未找到工作表：${excelConfig.sheetName}`)
  }

  const startRow = excelConfig.startRow || 2
  const endRow = excelConfig.endRow || 100
  const rows = []

  for (let rowNumber = startRow; rowNumber <= endRow; rowNumber++) {
    const row = ws.getRow(rowNumber)
    const item = normalizeExcelRow(row, rowNumber)

    if (hasReportContent(item)) {
      rows.push(item)
    }
  }

  return rows
}

function normalizeExcelRow(row, rowNumber) {
  const group = readCellText(row, 2)
  const resolveDate = readCellText(row, 3)
  const project = readCellText(row, 4)
  const typeLabel = readCellText(row, 5)
  const jiraNo = readCellText(row, 6)
  const taskDescription = readCellText(row, 7)
  const owner = readCellText(row, 8)
  const status = readCellText(row, 9)
  const detail = readCellText(row, 10)
  const rawRemark = readCellText(row, 11)
  const screenshot = readCellText(row, 12)
  const description = taskDescription || detail

  return {
    source: 'excel',
    rowNumber,
    sortIndex: rowNumber,
    commitMarker: extractCommitMarker(rawRemark),
    group,
    resolveDate,
    date: resolveDate ? formatMonthDay(`${resolveDate}T00:00:00+08:00`) : '',
    project,
    jira: jiraNo,
    jiraUrl: jiraNo ? `${JIRA_BASE_URL}${jiraNo}` : '',
    description,
    taskDescription,
    detail,
    owner,
    status,
    remark: cleanRemark(rawRemark),
    screenshot,
    typeLabel,
    typeColor: typeLabel ? typeColorMap[typeLabel] || '#8c8c8c' : '',
    type: 'thisWeek'
  }
}

function hasReportContent(item) {
  return Boolean(
    item.group ||
      item.resolveDate ||
      item.project ||
      item.jira ||
      item.description ||
      item.taskDescription ||
      item.detail ||
      item.status ||
      item.remark
  )
}

function getItemKeys(item) {
  const keys = []
  const description = item.taskDescription || item.description || ''

  if (item.commitMarker) keys.push(`commit:${item.commitMarker}`)
  if (item.short_id) keys.push(`commit:${item.short_id}`)
  if (item.commit_id) keys.push(`commit:${String(item.commit_id).slice(0, 8)}`)
  if (item.jira) keys.push(`jira:${item.jira}`)
  if (item.group || item.project || description) {
    keys.push(
      `item:${item.group || ''}_${item.project || ''}_${normalizeText(
        description
      )}`
    )
  }
  if (item.resolveDate || item.description) {
    keys.push(
      `dateItem:${item.resolveDate || ''}_${normalizeText(
        item.description || ''
      )}`
    )
  }

  return keys.filter(Boolean)
}

function getPrimaryKey(item, index) {
  return (
    getItemKeys(item)[0] ||
    `manual:${index}:${item.group || ''}:${item.description || ''}`
  )
}

function overlayPreferRight(base, patch) {
  const result = { ...base }

  Object.entries(patch).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      result[key] = value
    }
  })

  return result
}

function mergeItems(gitItems, excelItems) {
  const map = new Map()
  const aliasToPrimary = new Map()

  function findExistingPrimary(item) {
    for (const key of getItemKeys(item)) {
      if (aliasToPrimary.has(key)) {
        return aliasToPrimary.get(key)
      }
    }

    return ''
  }

  function addItem(item, index, preferCurrent) {
    const existingPrimary = findExistingPrimary(item)
    const primary = existingPrimary || getPrimaryKey(item, index)
    const existing = map.get(primary)

    if (existing) {
      map.set(
        primary,
        preferCurrent
          ? overlayPreferRight(existing, item)
          : overlayPreferRight(item, existing)
      )
    } else {
      map.set(primary, item)
    }

    getItemKeys(item).forEach((key) => aliasToPrimary.set(key, primary))
  }

  gitItems.forEach((item, index) => addItem(item, index, false))
  excelItems.forEach((item, index) => addItem(item, index, true))

  return Array.from(map.values()).sort(compareReportItem)
}

function compareReportItem(a, b) {
  const ai = groupOrder.indexOf(a.group)
  const bi = groupOrder.indexOf(b.group)

  if (ai !== bi) {
    if (ai === -1) return 1
    if (bi === -1) return -1
    return ai - bi
  }

  if (a.group !== b.group) {
    return String(a.group || '').localeCompare(String(b.group || ''), 'zh-CN')
  }

  if (a.resolveDate !== b.resolveDate) {
    return String(a.resolveDate || '').localeCompare(
      String(b.resolveDate || ''),
      'zh-CN'
    )
  }

  return String(a.project || '').localeCompare(String(b.project || ''), 'zh-CN')
}

function validateItems(items) {
  const errors = []

  items.forEach((item, index) => {
    const rowText =
      item.source === 'excel' && item.rowNumber
        ? `Excel第${item.rowNumber}行`
        : `第${index + 1}条`

    if (!item.group) errors.push(`${rowText}：缺少产品`)
    if (!item.resolveDate && !item.date) errors.push(`${rowText}：缺少解决日期`)
    if (!item.project) errors.push(`${rowText}：缺少项目`)
    if (!item.description) errors.push(`${rowText}：缺少任务描述/处理详情`)
    if (!item.status) errors.push(`${rowText}：缺少解决状态`)
  })

  return errors
}

function generateReport(data, meta = {}) {
  const outputDir = getOutputDir()

  const thisWeekList = data.filter((item) => item.type !== 'nextWeek')
  const nextWeekList = data.filter((item) => item.type === 'nextWeek')

  const bodyHtml = `
  ${renderSectionHtml('本周工作总结', thisWeekList)}
  ${nextWeekList.length ? renderSectionHtml('下周工作计划', nextWeekList) : ''}
    `

  const fullHtml = `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <title>周报</title>
    <style>
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
        font-size: 14.5px;
        line-height: 1.8;
        color: #333333;
        padding: 24px;
      }

      h2 {
        font-size: 20px;
        margin: 20px 0 12px;
      }

      h3 {
        font-size: 18.5px;
        margin: 16px 0 8px;
      }

      ol {
        margin: 0 0 20px 24px;
        padding: 0;
      }

      li {
        margin: 4px 0;
      }

      a {
        color: #1677ff;
        text-decoration: none;
      }

      .toolbar {
        position: sticky;
        top: 0;
        background: #fff;
        padding: 8px 0 16px;
        margin-bottom: 8px;
        z-index: 10;
      }

      #copyBtn {
        border: 1px solid #1677ff;
        background: #1677ff;
        color: #fff;
        border-radius: 4px;
        padding: 6px 12px;
        cursor: pointer;
        font-size: 14px;
      }

      #copyBtn:hover {
        opacity: 0.9;
      }

      #copyTip {
        margin-left: 12px;
        color: #00a854;
        font-size: 13px;
      }
    </style>
  </head>
  <body>
    <div class="toolbar">
      <button id="copyBtn">复制周报内容</button>
      <span id="copyTip"></span>
    </div>

    <div id="reportContent">
  ${bodyHtml}
    </div>

    <script>
      document.getElementById('copyBtn').addEventListener('click', async function () {
        const content = document.getElementById('reportContent')
        const tip = document.getElementById('copyTip')

        try {
          const html = content.innerHTML
          const text = content.innerText

          if (navigator.clipboard && window.ClipboardItem) {
            const clipboardItem = new ClipboardItem({
              'text/html': new Blob([html], { type: 'text/html' }),
              'text/plain': new Blob([text], { type: 'text/plain' })
            })

            await navigator.clipboard.write([clipboardItem])
          } else {
            const range = document.createRange()
            range.selectNodeContents(content)

            const selection = window.getSelection()
            selection.removeAllRanges()
            selection.addRange(range)

            document.execCommand('copy')
            selection.removeAllRanges()
          }

          tip.textContent = '已复制，可直接粘贴到钉钉'
        } catch (error) {
          tip.textContent = '复制失败，请手动选择正文复制'
          console.error(error)
        }
      })
    </script>
  </body>
  </html>
  `

  const htmlPath = path.join(outputDir, outputConfig.htmlFile)
  const mdPath = path.join(outputDir, outputConfig.mdFile)
  const jsonPath = path.join(outputDir, outputConfig.normalizedJsonFile)
  const validationPath = path.join(outputDir, outputConfig.validationFile)

  fs.writeFileSync(htmlPath, fullHtml, 'utf8')
  fs.writeFileSync(mdPath, bodyHtml, 'utf8')
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        meta: {
          generatedAt: new Date().toISOString(),
          gitCount: meta.gitCount || 0,
          excelCount: meta.excelCount || 0,
          finalCount: data.length
        },
        data
      },
      null,
      2
    ),
    'utf8'
  )
  fs.writeFileSync(
    validationPath,
    JSON.stringify(meta.validationErrors || [], null, 2),
    'utf8'
  )

  console.log('')
  console.log('生成完成：')
  console.log(htmlPath)
  console.log(mdPath)
  console.log(jsonPath)

  if (meta.validationErrors && meta.validationErrors.length) {
    console.warn(`存在数据校验提示：${validationPath}`)
  }

  openFile(htmlPath)
}

function groupBy(list, key) {
  return list.reduce((map, item) => {
    const value = item[key] || '其他'

    if (!map[value]) {
      map[value] = []
    }

    map[value].push(item)

    return map
  }, {})
}

function renderSectionHtml(title, list) {
  const grouped = groupBy(list, 'group')
  const groups = Object.keys(grouped).sort((a, b) => {
    const ai = groupOrder.indexOf(a)
    const bi = groupOrder.indexOf(b)

    if (ai === -1 && bi === -1) {
      return a.localeCompare(b, 'zh-CN')
    }

    if (ai === -1) return 1
    if (bi === -1) return -1

    return ai - bi
  })

  if (!groups.length) {
    return `
${enableSectionTitle ? `<h2>${escapeHtml(title)}</h2>` : ''}
<p>无</p>`
  }

  const html = groups
    .map((groupName, index) =>
      renderGroupHtml(groupName, grouped[groupName], toChineseNumber(index + 1))
    )
    .join('\n')

  return `
${enableSectionTitle ? `<h2>${escapeHtml(title)}</h2>` : ''}
${html}`
}

function getSortIndex(item) {
  const value = Number(item.sortIndex || item.rowNumber)

  if (Number.isFinite(value) && value > 0) {
    return value
  }

  return Number.MAX_SAFE_INTEGER
}

function getDateSortValue(item) {
  const date = String(item.date || '').trim()
  const match = date.match(/^(\d{1,2})-(\d{1,2})$/)

  if (!match) {
    return Number.MAX_SAFE_INTEGER
  }

  return Number(match[1]) * 100 + Number(match[2])
}

function sortGroupItems(list) {
  return [...list].sort((a, b) => {
    const ai = getSortIndex(a)
    const bi = getSortIndex(b)

    if (ai !== bi) {
      return ai - bi
    }

    return getDateSortValue(a) - getDateSortValue(b)
  })
}

function renderGroupHtml(groupName, list, indexText) {
  const itemsHtml = sortGroupItems(list).map(renderItemHtml).join('\n')

  return `
<h3>${indexText}、${escapeHtml(groupName)}</h3>
<ol>
${itemsHtml}
</ol>
<br>
<br>`
}

function renderItemHtml(item) {
  const date = escapeHtml(item.date || '')
  const project = escapeHtml(item.project || '')
  const jira = escapeHtml(item.jira || '')
  const jiraUrl = item.jiraUrl || ''
  const description = escapeHtml(item.description || '')
  const owner = escapeHtml(item.owner || '')
  const statusHtml = getStatusHtml(item)

  const jiraHtml =
    jiraUrl && jira
      ? `<a href="${escapeHtml(jiraUrl)}" target="_blank">${jira}</a>`
      : jira

  const dateHtml = date ? `【${date}】` : ''
  const projectHtml = project ? `【${project}】` : ''
  const typeLabel = escapeHtml(item.typeLabel || '')
  const typeColor = item.typeColor || '#8c8c8c'
  const typeHtml =
    !shouldSkipType(item) && typeLabel
      ? ` <span style="color:${typeColor};">【${typeLabel}】</span>`
      : ''
  const ownerHtml = owner ? `（${owner}）` : ''

  return `<li>${dateHtml}${projectHtml}${typeHtml} ${
    jiraHtml ? `${jiraHtml} ` : ''
  }${description}${ownerHtml}${statusHtml}</li>`
}

function shouldSkipType(item) {
  return (noTypeProjectIds || []).includes(Number(item.project_id))
}

function getStatusHtml(item) {
  const status = cleanText(item.status)
  const detail = cleanText(item.detail)
  const remark = cleanText(item.remark)
  const description = cleanText(item.description)
  const color = statusColorMap[item.status] || '#333'

  const parts = []

  if (status) {
    parts.push(
      `<span style="color:${escapeHtml(color)};">${escapeHtml(status)}</span>`
    )
  }

  if (detail && normalizeText(detail) !== normalizeText(description)) {
    parts.push(escapeHtml(detail))
  }

  if (remark) {
    parts.push(escapeHtml(remark))
  }

  if (!parts.length) return ''

  return ` （${parts.join('。')}）`
}

function toChineseNumber(num) {
  const map = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十']
  return map[num] || String(num)
}

function escapeHtml(str = '') {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function openFile(filePath) {
  const absolutePath = path.resolve(filePath)

  let command

  if (process.platform === 'darwin') {
    command = `open "${absolutePath}"`
  } else if (process.platform === 'win32') {
    command = `start "" "${absolutePath}"`
  } else {
    command = `xdg-open "${absolutePath}"`
  }

  exec(command, (error) => {
    if (error) {
      console.error(`打开文件失败：${absolutePath}`)
      console.error(error.message)
    }
  })
}
