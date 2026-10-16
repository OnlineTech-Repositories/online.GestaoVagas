import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { connect, disconnect } from '../src/db/index.js';

/** Sobe a aplicação real em porta efêmera (o mesmo createApp do server.js). */
export async function startServer({ demo = false } = {}) {
  config.seed.demoData = demo;
  await connect();
  const app = await createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      await disconnect();
    },
  };
}
