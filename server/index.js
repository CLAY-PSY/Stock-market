import http from 'node:http';
import { config } from './config.js';
import { createApp } from './app.js';
import { createProvider } from './providers/index.js';
import { QuoteHub } from './realtime.js';
import { logger } from './lib/logger.js';

const provider = createProvider(config.provider);
const hub = new QuoteHub({ provider, config });
const app = createApp({ provider, hub });
const server = http.createServer(app);

hub.attach(server).start();

server.listen(config.port, config.host, () => {
  const shownHost = config.host === '0.0.0.0' ? 'localhost' : config.host;
  logger.info(`实时行情服务已启动：http://${shownHost}:${config.port}`);
  logger.info(`数据源：${provider.label} (${provider.name})，刷新间隔 ${config.quoteIntervalMs}ms`);
});

server.on('error', (err) => {
  logger.error(`HTTP 服务启动失败：${err.message}`);
  process.exit(1);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`收到 ${signal}，正在关闭…`);
  hub.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
