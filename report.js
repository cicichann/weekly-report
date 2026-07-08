#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const { exec } = require('child_process')
const readline = require('readline/promises')
const { stdin: input, stdout: outputStream } = require('process')

const config = require('./config')

const {
  gitlab,
  jira,
  projectGroupMap,
  noTypeProjectIds,
  statusColorMap,
  typeColorMap,
  groupOrder,
  output,
  filters,
  enableSectionTitle
} = config

const GITLAB_BASE_URL = gitlab.baseUrl
const GITLAB_USER_ID = gitlab.userId
const GITLAB_TOKEN = gitlab.token
const JIRA_BASE_URL = jira.baseUrl

if (!GITLAB_TOKEN) {
  console.error('错误：缺少 GITLAB_TOKEN 环境变量')
  console.error('示例：GITLAB_TOKEN="你的token" node weekly-report.js')
  process.exit(1)
}

const args = parseArgs(process.argv.slice(2))

const after = args.after || getDefaultAfter()
const before = args.before || getDefaultBefore()

main().catch((error) => {
  console.error('执行失败：')
  console.error(error)
  process.exit(1)
})

function shouldSkipType(item) {
  return (noTypeProjectIds || []).includes(Number(item.project_id))
}

async function confirmItemTypes(items) {
  if (!items.length) return items

  const rl = readline.createInterface({
    input,
    output: outputStream
  })

  const typeKeys = Object.keys(typeColorMap)

  try {
    console.log('')
    console.log('开始逐条确认问题类型：')
    console.log('')

    for (let i = 0; i < items.length; i++) {
      const item = items[i]

      if (shouldSkipType(item)) {
        item.typeLabel = ''
        item.typeColor = ''
        continue
      }

      console.log(`第 ${i + 1}/${items.length} 条：`)
      console.log(
        `${item.date ? `【${item.date}】` : ''}${
          item.project ? `【${item.project}】` : ''
        }${item.jira ? `${item.jira} ` : ''}${item.description}`
      )
      console.log('')

      typeKeys.forEach((type, index) => {
        console.log(`${index + 1}) ${type}`)
      })

      console.log('')

      let selectedType = ''

      while (!selectedType) {
        const answer = await rl.question(
          '请选择问题类型编号，直接回车默认“其他”：'
        )

        if (!answer.trim()) {
          selectedType = typeKeys.includes('其他') ? '其他' : typeKeys[0]
          break
        }

        const index = Number(answer)

        if (Number.isInteger(index) && index >= 1 && index <= typeKeys.length) {
          selectedType = typeKeys[index - 1]
          break
        }

        console.log(`无效输入，请输入 1-${typeKeys.length} 的编号`)
      }

      item.typeLabel = selectedType
      item.typeColor = typeColorMap[selectedType] || '#8c8c8c'

      console.log(`已选择：${selectedType}`)
      console.log('')
    }
  } finally {
    rl.close()
  }

  return items
}

async function main() {
  console.log(`开始获取 GitLab 事件：${after} ~ ${before}`)

  const events = await fetchAllGitlabEvents({
    userId: GITLAB_USER_ID,
    after,
    before
  })

  console.log(`获取到 GitLab events：${events.length} 条`)

  const pushEvents = filterPushEvents(events)

  console.log(`筛选后 pushed to events：${pushEvents.length} 条`)

  const commits = await fetchCommitsByPushEvents(pushEvents)

  console.log(`获取到真实 commits：${commits.length} 条`)

  const weeklyItems = normalizeCommits(commits)

  console.log(`生成周报条目：${weeklyItems.length} 条`)

  await confirmItemTypes(weeklyItems)

  generateReport(weeklyItems)
}

function parseArgs(argv) {
  const result = {}

  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, '').split('=')
    result[key] = value
  }

  return result
}

function getDefaultAfter() {
  const now = new Date()
  const day = now.getDay() || 7

  const monday = new Date(now)
  monday.setDate(now.getDate() - day + 1)

  const beforeMonday = new Date(monday)
  beforeMonday.setDate(monday.getDate() - 1)

  return formatDateOnly(beforeMonday)
}

function getDefaultBefore() {
  const now = new Date()

  const tomorrow = new Date(now)
  tomorrow.setDate(now.getDate() + 1)

  return formatDateOnly(tomorrow)
}

function formatDateOnly(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')

  return `${year}-${month}-${day}`
}

async function gitlabGet(apiPath, query = {}) {
  const url = new URL(`${GITLAB_BASE_URL}${apiPath}`)

  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, value)
    }
  })

  const response = await fetch(url, {
    headers: {
      'PRIVATE-TOKEN': GITLAB_TOKEN
    }
  })

  if (!response.ok) {
    throw new Error(
      `GitLab 请求失败：${response.status} ${response.statusText} ${url}`
    )
  }

  const data = await response.json()

  return {
    data,
    headers: response.headers
  }
}

async function fetchAllPages(apiPath, query = {}) {
  let page = 1
  const perPage = 100
  const result = []

  while (true) {
    const { data, headers } = await gitlabGet(apiPath, {
      ...query,
      page,
      per_page: perPage
    })

    result.push(...data)

    const nextPage = headers.get('x-next-page')

    if (!nextPage) {
      break
    }

    page = Number(nextPage)
  }

  return result
}

async function fetchAllGitlabEvents({ userId, after, before }) {
  return fetchAllPages(`/api/v4/users/${userId}/events`, {
    after,
    before,
    target_type: '',
    action: ''
  })
}

const excludedEvents = []

function excludeEvent(event, reason) {
  const pushData = event.push_data || {}

  excludedEvents.push({
    reason,
    id: event.id,
    project_id: event.project_id,
    action_name: event.action_name,
    created_at: event.created_at,
    ref: pushData.ref,
    ref_type: pushData.ref_type,
    action: pushData.action,
    commit_count: pushData.commit_count,
    commit_from: pushData.commit_from,
    commit_to: pushData.commit_to,
    commit_title: pushData.commit_title
  })
}

function filterPushEvents(events) {
  return events.filter((event) => {
    const pushData = event.push_data || {}

    if (event.action_name !== 'pushed to') {
      excludeEvent(event, '非 pushed to 事件')
      return false
    }

    if (pushData.action !== 'pushed') {
      excludeEvent(event, '非 pushed action')
      return false
    }

    if (pushData.ref_type !== 'branch') {
      excludeEvent(event, '非 branch 推送')
      return false
    }

    if (!pushData.commit_from) {
      excludeEvent(event, '缺少 commit_from')
      return false
    }

    if (!pushData.commit_to) {
      excludeEvent(event, '缺少 commit_to')
      return false
    }

    if (!pushData.commit_count || pushData.commit_count <= 0) {
      excludeEvent(event, 'commit_count 为空或小于等于 0')
      return false
    }

    if (
      filters.maxCommitCountPerPush &&
      pushData.commit_count > filters.maxCommitCountPerPush
    ) {
      excludeEvent(
        event,
        `超过单次 push 数量阈值：${filters.maxCommitCountPerPush}`
      )
      return false
    }

    return true
  })
}

const compareLogs = []

async function fetchCommitsByPushEvents(events) {
  const commitMap = new Map()

  for (const event of events) {
    const pushData = event.push_data

    console.log(`Compare project=${event.project_id}, ref=${pushData.ref}`)

    const commits = await fetchCompareCommits({
      projectId: event.project_id,
      from: pushData.commit_from,
      to: pushData.commit_to
    })

    compareLogs.push({
      project_id: event.project_id,
      ref: pushData.ref,
      commit_count_from_event: pushData.commit_count,
      commit_from: pushData.commit_from,
      commit_to: pushData.commit_to,
      compare_commit_count: commits.length,
      event_created_at: event.created_at,
      commit_title: pushData.commit_title
    })

    for (const commit of commits) {
      if (!commit.id) continue

      commitMap.set(commit.id, {
        ...commit,
        project_id: event.project_id,
        ref: pushData.ref,
        event_created_at: event.created_at,
        event_commit_count: pushData.commit_count
      })
    }
  }

  return Array.from(commitMap.values())
}

async function fetchCompareCommits({ projectId, from, to }) {
  try {
    const { data } = await gitlabGet(
      `/api/v4/projects/${encodeURIComponent(projectId)}/repository/compare`,
      {
        from,
        to
      }
    )

    return Array.isArray(data.commits) ? data.commits : []
  } catch (error) {
    console.warn(
      `警告：compare 失败，已跳过 project=${projectId}, from=${from}, to=${to}`
    )
    console.warn(error.message)
    return []
  }
}

function isMyCommit(commit) {
  const names = gitlab.authorNames || []
  const emails = gitlab.authorEmails || []

  return (
    names.includes(commit.author_name) ||
    names.includes(commit.committer_name) ||
    emails.includes(commit.author_email) ||
    emails.includes(commit.committer_email)
  )
}

const excludedCommits = []

function excludeCommit(commit, reason) {
  excludedCommits.push({
    reason,
    title: commit.title || commit.message || '',
    project_id: commit.project_id,
    ref: commit.ref,
    author_name: commit.author_name,
    author_email: commit.author_email,
    committer_name: commit.committer_name,
    committer_email: commit.committer_email,
    committed_date: commit.committed_date,
    event_created_at: commit.event_created_at
  })
}
function buildWeeklyUniqueKey(commit, parsed) {
  const group = projectGroupMap[commit.project_id] || '其他'
  const jira = parsed.jira || ''
  const project = parsed.project || ''
  const description = normalizeText(parsed.description || '')

  if (jira) {
    return `${group}_${jira}_${description}`
  }

  return `${group}_${project}_${description}`
}

function normalizeText(text = '') {
  return String(text)
    .replace(/\s+/g, '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .trim()
}

function isCommitInRange(commit, after, before) {
  const dateStr = commit.committed_date || commit.created_at

  if (!dateStr) return false

  const commitTime = new Date(dateStr)
  const afterTime = new Date(`${after}T00:00:00+08:00`)
  const beforeTime = new Date(`${before}T00:00:00+08:00`)

  return commitTime > afterTime && commitTime < beforeTime
}

function normalizeCommits(commits) {
  const result = []
  const seen = new Set()

  for (const commit of commits) {
    const title = commit.title || commit.message || ''

    if (!title) {
      excludeCommit(commit, '标题为空')
      continue
    }

    if (!isMyCommit(commit)) {
      excludeCommit(commit, '作者不匹配')
      continue
    }

    if (!isCommitInRange(commit, after, before)) {
      excludeCommit(commit, '提交时间不在周报周期内')
      continue
    }

    if (filters.ignoreMergeCommit && /^Merge branch/i.test(title)) {
      excludeCommit(commit, 'Merge commit')
      continue
    }

    const parsed = parseCommitTitle(title)

    if (!parsed.description) {
      excludeCommit(commit, '解析后描述为空')
      continue
    }

    const uniqueKey = buildWeeklyUniqueKey(commit, parsed)

    if (seen.has(uniqueKey)) {
      excludeCommit(commit, `重复周报事项：${uniqueKey}`)
      continue
    }

    seen.add(uniqueKey)

    result.push({
      project_id: commit.project_id,
      group: projectGroupMap[commit.project_id] || '其他',
      date: formatMonthDay(
        commit.committed_date || commit.created_at || commit.event_created_at
      ),
      project: parsed.project || '',
      jira: parsed.jira,
      jiraUrl: parsed.jira ? `${JIRA_BASE_URL}${parsed.jira}` : '',
      description: parsed.description,
      owner: '',
      status: '已完成',
      remark: '',
      type: 'thisWeek'
    })
  }

  return result.sort((a, b) => {
    if (a.group !== b.group) {
      return a.group.localeCompare(b.group, 'zh-CN')
    }

    return a.date.localeCompare(b.date, 'zh-CN')
  })
}

function parseCommitTitle(title = '') {
  const jiraMatch = title.match(/([A-Z][A-Z0-9]+-\d+)/)
  const projectMatch = title.match(/【([^】]+)】/)

  const jira = jiraMatch ? jiraMatch[1] : ''
  const project = projectMatch ? projectMatch[1] : ''

  let description = title
    .replace(jira, '')
    .replace(/【[^】]+】/, '')
    .replace(
      /^(feat|fix|docs|style|refactor|test|chore|perf|build|ci):\s*/i,
      ''
    )
    .trim()

  return {
    jira,
    project,
    description
  }
}

function formatMonthDay(dateStr) {
  const date = new Date(dateStr)

  if (Number.isNaN(date.getTime())) {
    return ''
  }

  return `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, '0')}`
}

function generateReport(data) {
  const outputDir = './weekly-output'
  fs.mkdirSync(outputDir, { recursive: true })

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

  const htmlPath = path.join(outputDir, output.htmlFile)
  const mdPath = path.join(outputDir, output.mdFile)
  const jsonPath = path.join(outputDir, output.normalizedJsonFile)

  fs.writeFileSync(htmlPath, fullHtml, 'utf8')
  fs.writeFileSync(mdPath, bodyHtml, 'utf8')
  fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf8')
  fs.writeFileSync(
    path.join(outputDir, 'weekly-report.excluded.json'),
    JSON.stringify(excludedCommits, null, 2),
    'utf8'
  )
  fs.writeFileSync(
    path.join(outputDir, 'weekly-report.compare-logs.json'),
    JSON.stringify(compareLogs, null, 2),
    'utf8'
  )

  console.log('')
  console.log('生成完成：')
  console.log(htmlPath)
  console.log(mdPath)
  console.log(jsonPath)

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

function renderGroupHtml(groupName, list, indexText) {
  const itemsHtml = list.map(renderItemHtml).join('\n')

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
  const statusText = escapeHtml(getStatusText(item))
  const color = statusColorMap[item.status] || '#333'

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
  const statusHtml = statusText
    ? ` （<span style="color:${color};">${statusText}</span>。）`
    : ''

  return `<li>${dateHtml}${projectHtml}${typeHtml} ${
    jiraHtml ? `${jiraHtml} ` : ''
  }${description}${ownerHtml}${statusHtml}</li>`
}

function getStatusText(item) {
  const status = item.status || ''
  const remark = item.remark || ''

  if (!status && !remark) return ''

  if (status && remark) {
    return `${status}。${remark}`
  }

  return `${status || remark}`
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
