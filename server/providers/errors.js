/** 请求的功能在当前市场 / 数据源下不可用（例如港股分钟 K 线） */
export class NotSupportedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotSupportedError';
    this.status = 422;
  }
}

/** 代码不存在或上游没有对应数据 */
export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
    this.status = 404;
  }
}
