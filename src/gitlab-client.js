'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { GitLabError } = require('./errors');

const RETRYABLE_CODES = new Set([429, 502, 503, 504]);

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class GitLabClient {
  constructor(options) {
    this.baseUrl = String(options.baseUrl).replace(/\/$/, '');
    this.token = options.token;
    this.timeoutMs = options.requestTimeoutMs || 15000;
    this.maxRetries = options.maxRetries ?? 3;
  }

  async request(apiPath, query = {}, attempt = 0) {
    const url = new URL(`${this.baseUrl}/api/v4${apiPath}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }

    try {
      const response = await this.doRequest(url);
      if (response.statusCode >= 200 && response.statusCode < 300) return response;

      if (RETRYABLE_CODES.has(response.statusCode) && attempt < this.maxRetries) {
        const retryAfter = Number(response.headers['retry-after']);
        const delay = Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000 * 2 ** attempt;
        await wait(delay);
        return this.request(apiPath, query, attempt + 1);
      }

      const authHint = [401, 403].includes(response.statusCode)
        ? '，请检查 Token 和 GitLab 权限'
        : '';
      throw new GitLabError(
        `GitLab 请求失败（HTTP ${response.statusCode}）${authHint}：${url.pathname}`,
        { code: `GITLAB_HTTP_${response.statusCode}`, details: response.body }
      );
    } catch (error) {
      if (error instanceof GitLabError) throw error;
      if (attempt < this.maxRetries) {
        await wait(1000 * 2 ** attempt);
        return this.request(apiPath, query, attempt + 1);
      }
      throw new GitLabError(`GitLab 网络请求失败：${error.message}`, {
        code: 'GITLAB_NETWORK_ERROR',
        details: { path: apiPath }
      });
    }
  }

  doRequest(url) {
    return new Promise((resolve, reject) => {
      const transport = url.protocol === 'http:' ? http : https;
      const request = transport.request(url, {
        method: 'GET',
        headers: {
          'PRIVATE-TOKEN': this.token,
          Accept: 'application/json',
          'User-Agent': 'weekly-report-pipeline/1.0'
        }
      }, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => {
          let parsed = null;
          try {
            parsed = body ? JSON.parse(body) : null;
          } catch (_) {
            parsed = body;
          }
          resolve({ statusCode: response.statusCode, headers: response.headers, body: parsed });
        });
      });
      request.setTimeout(this.timeoutMs, () => request.destroy(new Error(`请求超时（${this.timeoutMs}ms）`)));
      request.on('error', reject);
      request.end();
    });
  }

  async getAllPages(apiPath, query = {}) {
    const rows = [];
    let page = 1;
    while (page) {
      const response = await this.request(apiPath, { ...query, page, per_page: 100 });
      if (!Array.isArray(response.body)) {
        throw new GitLabError(`GitLab 分页接口未返回数组：${apiPath}`, {
          code: 'GITLAB_INVALID_RESPONSE'
        });
      }
      rows.push(...response.body);
      const nextPage = Number(response.headers['x-next-page']);
      page = Number.isFinite(nextPage) && nextPage > 0 ? nextPage : 0;
    }
    return rows;
  }

  getEvents(userId, period) {
    const normalizedUser = String(userId || '').trim().toLowerCase();
    const apiPath = ['me', 'self', 'current'].includes(normalizedUser)
      ? '/events'
      : `/users/${encodeURIComponent(userId)}/events`;
    return this.getAllPages(apiPath, {
      action: 'pushed',
      after: period.gitlabAfter,
      before: period.gitlabBefore,
      scope: normalizedUser === 'me' ? 'all' : undefined,
      sort: 'asc'
    });
  }

  async compareCommits(projectId, from, to) {
    const response = await this.request(
      `/projects/${encodeURIComponent(projectId)}/repository/compare`,
      { from, to, straight: true }
    );
    return Array.isArray(response.body && response.body.commits) ? response.body.commits : [];
  }

  getBranchCommits(projectId, branch, period) {
    return this.getAllPages(`/projects/${encodeURIComponent(projectId)}/repository/commits`, {
      ref_name: branch,
      since: `${period.reportStart}T00:00:00+00:00`,
      until: `${period.gitlabBefore}T00:00:00+00:00`,
      with_stats: false
    });
  }
}

function isZeroSha(value) {
  return !value || /^0+$/.test(value);
}

async function fetchGitData(config, period, logger) {
  const client = new GitLabClient(config.gitlab);
  logger.info(`开始获取 GitLab 事件：${period.gitlabAfter} ～ ${period.gitlabBefore}`);
  const events = await client.getEvents(config.gitlab.userId, period);
  const pushEvents = events.filter(event => event.action_name === 'pushed to' || event.push_data);
  logger.info(`获取到 Events：${events.length} 条，Push Events：${pushEvents.length} 条`);

  const commitMap = new Map();
  const failures = [];

  for (const event of pushEvents) {
    const projectId = event.project_id;
    const pushData = event.push_data || {};
    const from = pushData.commit_from;
    const to = pushData.commit_to;
    const branch = pushData.ref;
    if (!projectId || !to || isZeroSha(to)) continue;

    try {
      let commits;
      if (!isZeroSha(from) && from !== to) {
        commits = await client.compareCommits(projectId, from, to);
      } else {
        commits = await client.getBranchCommits(projectId, branch, period);
      }

      for (const commit of commits) {
        const key = `${projectId}:${commit.id}`;
        const current = commitMap.get(key);
        commitMap.set(key, {
          ...current,
          ...commit,
          project_id: projectId,
          branch: branch || (current && current.branch) || '',
          source_event_id: event.id
        });
      }
    } catch (error) {
      failures.push({
        projectId,
        eventId: event.id,
        branch,
        from,
        to,
        code: error.code || 'FETCH_COMMITS_FAILED',
        message: error.message
      });
      logger.warn(`项目 ${projectId} 的提交获取失败，已记录并继续`);
    }
  }

  logger.info(`获取到真实 Commits：${commitMap.size} 条`);
  return {
    schemaVersion: 1,
    fetchedAt: new Date().toISOString(),
    period,
    stats: {
      events: events.length,
      pushEvents: pushEvents.length,
      commits: commitMap.size,
      failures: failures.length
    },
    events,
    commits: [...commitMap.values()],
    failures
  };
}

module.exports = { GitLabClient, fetchGitData, isZeroSha };
