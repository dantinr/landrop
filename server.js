'use strict';

const path = require('node:path');
const { createLanDropServer, getLanAddresses } = require('./src/app');

function readPort() {
  const portArgument = process.argv.find((argument) => argument.startsWith('--port='));
  const value = portArgument?.slice('--port='.length) || process.env.PORT || '8787';
  const port = Number.parseInt(value, 10);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }

  return port;
}

async function main() {
  const port = readPort();
  const dataDir = process.env.LANDROP_DATA_DIR
    ? path.resolve(process.env.LANDROP_DATA_DIR)
    : path.join(__dirname, 'data');

  const app = await createLanDropServer({
    port,
    host: process.env.HOST || '0.0.0.0',
    dataDir,
  });

  await app.start();

  const addresses = getLanAddresses(port);
  console.log('');
  console.log('  邻传已启动');
  console.log('  本机访问:  http://localhost:' + port);
  for (const address of addresses) {
    console.log('  局域网访问: ' + address);
  }
  console.log('  文件目录:  ' + dataDir);
  console.log('');
  console.log('  按 Ctrl+C 停止服务。');

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    console.log('\n正在停止邻传...');
    await app.stop();
    process.exit(0);
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((error) => {
  console.error('邻传启动失败:', error.message);
  process.exitCode = 1;
});
