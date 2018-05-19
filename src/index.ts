export * from './runner';
import { Runner } from './runner';
import * as path from "path";
import * as fs from "fs";
import { RedisClient } from 'redis';
import { ConfigReader } from '@vigcoin/conf-reader';
import { Logger } from '@vigcoin/logger';
import { PoolRequest } from '@vigcoin/pool-request';
import * as cluster from "cluster";

let filename = process.argv[2];

if (!filename) {
  filename = 'config.json';
}
if (!fs.existsSync(filename)) {
  console.log('file: ' + filename + ' not existed!');
  process.exit();
} else {
  const reader = new ConfigReader(filename);
  const { config } = reader.get();
  const redis = new RedisClient({});
  const logger = new Logger(config.logger);
  const pr = new PoolRequest(config.daemon, config.wallet, config.api);

  const runner = new Runner(reader, redis, logger, pr);
  if (cluster.isWorker) {
    if (process.env) {
      const { workerType } = process.env;
      console.log("inside starting %s", workerType);
      if (workerType) {
        process.nextTick(async () => {
          runner.except(workerType)
          await runner.start(workerType);
        }, 0);
      }
    }
  } else {
    runner.except('master');
    runner.checkSingle();
    console.log("checking single finished...");
    runner.checkRedisVersion().then(() => {
      console.log("checking redis finished...");
      runner.spawn();
    }).catch((e) => {
      logger.append('error', 'master', 'Redis version check failed: %s', [e]);
    })
  }
}
