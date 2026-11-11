'use strict';

class RuntimeError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status) { throw new RuntimeError(code, message, status); }
function publicError(error) {
  if (error instanceof RuntimeError) return {code: error.code, message: error.message};
  // Child-process errors may contain arguments, input text, or host paths.
  return {code: 'operation_failed', message: 'Operation failed; inspect device state before retrying.'};
}
module.exports = {RuntimeError, fail, publicError};
