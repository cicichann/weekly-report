'use strict';

class PipelineError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = options.code || 'PIPELINE_ERROR';
    this.details = options.details || null;
    this.exitCode = options.exitCode || 1;
  }
}

class ConfigError extends PipelineError {}
class GitLabError extends PipelineError {}
class ValidationError extends PipelineError {}
class OutputError extends PipelineError {}

module.exports = {
  PipelineError,
  ConfigError,
  GitLabError,
  ValidationError,
  OutputError
};

