import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createWebServer } from './http.js';

const projectRoot = process.env.TEKON_PROJECT_ROOT ?? process.cwd();
const tokenPath = join(projectRoot, '.tekon', 'web-session.json');
const webSession = JSON.parse(readFileSync(tokenPath, 'utf8')) as {
  token?: unknown;
};
const sessionToken = webSession.token;
if (typeof sessionToken !== 'string' || !sessionToken) {
  throw new Error(
    `${tokenPath} 中的 web-session.json 格式无效，请重新运行 "tekon init"`,
  );
}

const server = await createWebServer({
  env: process.env,
  port: Number(process.env.PORT ?? 3000),
  vite: true,
});

await server.listen();
// Reveal the static local credential only after a successful bind. If the port
// is occupied, listen() rejects and no clickable token URL reaches the shell.
console.log(
  `url=${server.url}/#token=${encodeURIComponent(sessionToken)}`,
);
console.log(`Tekon Web listening on ${server.url}`);

const shutdown = async () => {
  await server.close();
  process.exit(0);
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
