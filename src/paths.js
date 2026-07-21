'use strict';

const path = require('path');

function getPipelinePaths(config, period) {
  return {
    rawFile: path.join(config.paths.dataDir, 'raw', `${period.key}.json`),
    normalizedFile: path.join(config.paths.dataDir, 'normalized', `${period.key}.json`),
    snapshotFile: path.join(config.paths.dataDir, 'snapshots', `${period.key}.json`),
    outputDir: path.join(config.paths.outputDir, period.key),
    validationFile: path.join(config.paths.outputDir, period.key, 'validation.json'),
    runFile: path.join(config.paths.outputDir, period.key, 'run.json'),
    excelFile: path.join(config.paths.outputDir, period.key, '周报.xlsx'),
    htmlFile: path.join(config.paths.outputDir, period.key, '周报.html')
  };
}

module.exports = { getPipelinePaths };

