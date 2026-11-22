'use strict';
/**
 * 退出之前把还没写下去的东西写完（2.0.0-pre2）：设置改完 200 毫秒内关窗口，这次改动以前会丢。
 * 有防抖的模块用 onQuit 登记；最多等几秒，写不完也要能退出。
 */
const { queuedDone, sleep } = require('./util');

const LIMIT_MS = 4000;
const flushers = new Set();

function onQuit(fn) { flushers.add(fn); }

async function run() {
  const all = (async () => {
    await Promise.allSettled([...flushers].map((fn) => fn()));
    await queuedDone();
  })();
  await Promise.race([all, sleep(LIMIT_MS)]);
}

module.exports = { onQuit, run };
