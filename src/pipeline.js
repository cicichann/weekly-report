'use strict';

const { loadConfig } = require('./config');
const { calculatePeriod } = require('./period');
const { getPipelinePaths } = require('./paths');
const { fetchGitData } = require('./gitlab-client');
const { normalizeGitData, isMergeCommit } = require('./normalize');
const { readManualExcel } = require('./read-manual-excel');
const { mergeNormalizedWithManual } = require('./merge-manual');
const { validateNormalized } = require('./validate');
const { createSnapshot } = require('./snapshot');
const { generateExcel } = require('./generate-excel');
const { generateHtml } = require('./generate-html');
const { verifyOutputs, verifyExcel } = require('./verify');
const { pathExists, readJson, writeJsonAtomic } = require('./utils/files');
const { PipelineError, ValidationError } = require('./errors');

async function loadContext(options) {
  const rootDir = options.rootDir || process.cwd();
  const config = await loadConfig(rootDir, options.config);
  const period = calculatePeriod(options.week, config.timezone);
  const paths = getPipelinePaths(config, period);
  return { rootDir, config, period, paths };
}

async function requireJson(file, description) {
  if (!(await pathExists(file))) {
    throw new PipelineError(`${description}不存在：${file}`, {
      code: 'REQUIRED_INPUT_MISSING'
    });
  }
  return readJson(file);
}

async function fetchStage(context, logger) {
  const raw = await fetchGitData(context.config, context.period, logger);
  await writeJsonAtomic(context.paths.rawFile, raw);
  return raw;
}

async function validateStage(context, raw, options, logger) {
  const normalized = normalizeGitData(raw, context.config, context.period);
  await writeJsonAtomic(context.paths.normalizedFile, normalized);

  const validation = validateNormalized(normalized, context.config, {
    allowEmpty: options.allowEmpty || context.config.validation.allowEmpty
  });
  await writeJsonAtomic(context.paths.validationFile, validation);

  logger.info(
    `校验完成：有效 ${validation.summary.accepted} 条，` +
    `拒绝 ${validation.summary.rejected} 条，警告 ${validation.summary.warnings} 条，错误 ${validation.summary.errors} 条`
  );
  return { normalized, validation };
}

async function validateReviewedExcelStage(context, baseline, options, logger) {
  const manual = await readManualExcel(context.config, context.period, context.paths);
  if (!manual.file || manual.file !== context.paths.excelFile) {
    throw new PipelineError(`待审核 Excel 不存在：${context.paths.excelFile}`, {
      code: 'REVIEWED_EXCEL_MISSING'
    });
  }

  const normalized = mergeNormalizedWithManual(baseline, manual, context.config, {
    manualAuthoritative: true
  });
  logger.info(
    `读取审核后的 Excel：${manual.items.length} 条，` +
    `匹配 Git ${normalized.manual.merged} 条，人工新增 ${normalized.manual.manualOnly} 条`
  );
  await writeJsonAtomic(context.paths.normalizedFile, normalized);

  const validation = validateNormalized(normalized, context.config, {
    allowEmpty: options.allowEmpty || context.config.validation.allowEmpty
  });
  await writeJsonAtomic(context.paths.validationFile, validation);
  logger.info(
    `审核数据校验：有效 ${validation.summary.accepted} 条，` +
    `警告 ${validation.summary.warnings} 条，错误 ${validation.summary.errors} 条`
  );
  return { normalized, validation, manual };
}

async function renderStage(context, snapshot, logger) {
  if (context.config.filters.excludeMergeCommits) {
    const staleMergeItems = snapshot.items.filter(item => isMergeCommit({
      title: item.title,
      message: item.message
    }));
    if (staleMergeItems.length) {
      throw new PipelineError(
        `当前快照仍包含 ${staleMergeItems.length} 条 Merge Commit，请运行 generate --from-cache 重新执行过滤`,
        {
          code: 'STALE_SNAPSHOT_CONTAINS_MERGE_COMMITS',
          details: staleMergeItems.map(item => ({ sha: item.sha, title: item.title }))
        }
      );
    }
  }

  const htmlResult = await generateHtml(snapshot, context.config, context.paths.htmlFile);
  logger.info(`HTML 生成成功：${context.paths.htmlFile}`);

  const verification = await verifyOutputs(snapshot, context.config, context.paths);
  logger.info('产物一致性校验通过');
  return { htmlResult, verification };
}

async function runCommand(command, options, logger) {
  const startedAt = new Date();
  const context = await loadContext(options);
  const baseResult = { command, period: context.period, paths: context.paths };

  if (command === 'fetch') {
    const raw = await fetchStage(context, logger);
    return { ...baseResult, raw };
  }

  if (command === 'validate') {
    const raw = await requireJson(context.paths.rawFile, '原始 Git 数据');
    const result = await validateStage(context, raw, options, logger);
    if (!result.validation.passed) {
      throw new ValidationError('数据校验未通过，请查看 validation.json', {
        code: 'VALIDATION_FAILED', details: result.validation
      });
    }
    return { ...baseResult, ...result };
  }

  if (command === 'render' || command === 'continue') {
    const baseline = await requireJson(context.paths.normalizedFile, '标准化 Git 数据');
    const reviewed = await validateReviewedExcelStage(context, baseline, options, logger);
    if (!reviewed.validation.passed) {
      throw new ValidationError('人工维护后的 Excel 校验未通过，请查看 validation.json', {
        code: 'VALIDATION_FAILED', details: reviewed.validation
      });
    }
    const snapshot = createSnapshot(reviewed.normalized, reviewed.validation);
    await writeJsonAtomic(context.paths.snapshotFile, snapshot);
    const rendered = await renderStage(context, snapshot, logger);
    const runManifest = {
      schemaVersion: 1,
      status: 'success',
      command,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      period: context.period,
      summary: reviewed.validation.summary,
      outputs: rendered
    };
    await writeJsonAtomic(context.paths.runFile, runManifest);
    return { ...baseResult, ...reviewed, snapshot, ...rendered, runManifest };
  }

  if (command !== 'generate' && command !== 'prepare') {
    throw new PipelineError(`不支持的命令：${command}`, { code: 'UNKNOWN_COMMAND' });
  }

  let raw;
  if (options.fromCache) {
    raw = await requireJson(context.paths.rawFile, '原始 Git 数据缓存');
    logger.info(`使用已有 Git 数据：${context.paths.rawFile}`);
  } else {
    raw = await fetchStage(context, logger);
  }

  const { normalized, validation } = await validateStage(context, raw, options, logger);
  if (!validation.passed) {
    throw new ValidationError('数据校验未通过，请查看 validation.json', {
      code: 'VALIDATION_FAILED', details: validation
    });
  }

  const snapshot = createSnapshot(normalized, validation);
  await writeJsonAtomic(context.paths.snapshotFile, snapshot);
  const excelResult = await generateExcel(snapshot, context.config, context.paths.excelFile);
  logger.info(`待审核 Excel 生成成功：${context.paths.excelFile}`);
  const verification = await verifyExcel(snapshot, context.config, context.paths.excelFile);

  const runManifest = {
    schemaVersion: 1,
    status: 'awaiting_review',
    command,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    period: context.period,
    summary: validation.summary,
    inputs: {
      rawFile: context.paths.rawFile,
      snapshotFile: context.paths.snapshotFile
    },
    outputs: {
      excelFile: context.paths.excelFile,
      validationFile: context.paths.validationFile,
      verification
    }
  };
  await writeJsonAtomic(context.paths.runFile, runManifest);

  return {
    ...baseResult,
    raw,
    normalized,
    validation,
    snapshot,
    excelResult,
    verification,
    runManifest
  };
}

async function run(command, options, logger) {
  const startedAt = new Date();
  try {
    return await runCommand(command, options, logger);
  } catch (error) {
    try {
      const context = await loadContext(options);
      const failureManifest = {
        schemaVersion: 1,
        status: 'failed',
        command,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        period: context.period,
        error: {
          code: error.code || 'UNEXPECTED_ERROR',
          message: error.message,
          details: error.details || null
        },
        partialOutputs: {
          validation: await pathExists(context.paths.validationFile),
          snapshot: await pathExists(context.paths.snapshotFile),
          excel: await pathExists(context.paths.excelFile),
          html: await pathExists(context.paths.htmlFile)
        }
      };
      await writeJsonAtomic(context.paths.runFile, failureManifest);
    } catch (_) {
      // 配置本身不可用或归档失败时，保留并继续抛出原始异常。
    }
    throw error;
  }
}

module.exports = {
  run,
  loadContext,
  fetchStage,
  validateStage,
  validateReviewedExcelStage,
  renderStage
};
