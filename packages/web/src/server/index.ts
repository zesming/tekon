import { createWebServer } from './http.js';

const server = await createWebServer({
  env: process.env,
  port: Number(process.env.PORT ?? 3000),
  vite: true,
});

await server.listen();
console.log(`Donkey Web listening on ${server.url}`);

const shutdown = async () => {
  await server.close();
  process.exit(0);
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
