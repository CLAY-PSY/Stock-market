/** 上游行情接口异常（网络错误、超时、数据格式不符） */
export class UpstreamError extends Error {
  constructor(message, { status, url, cause } = {}) {
    super(message, { cause });
    this.name = 'UpstreamError';
    this.status = status;
    this.url = url;
  }
}

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
