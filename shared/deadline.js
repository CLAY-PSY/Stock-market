import { UpstreamError } from './errors.js';

/**
 * 给一个异步操作加上截止时间：到点还没有结果就按超时失败。
 *
 * 浏览器里请求本身已有超时（AbortSignal.timeout），但手机切到后台 / 锁屏后网页被系统挂起，
 * 恢复后个别请求可能既不成功也不失败地一直挂着。轮询都是「等上一次结束再排下一次」，
 * 一个挂住的请求就会让行情永远停住，只有刷新页面才能恢复。这里不依赖请求自己的超时，到点直接放弃它。
 * 被放弃的请求之后即使返回，结果也会被丢弃。
 */
export function withDeadline(promise, ms, message = '行情接口请求超时') {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new UpstreamError(message)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
