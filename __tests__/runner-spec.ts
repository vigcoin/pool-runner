import { Runner } from '../src/runner';
import { RedisClient } from 'redis';
import { ConfigReader } from '@vigcoin/conf-reader';
import { Logger } from '@vigcoin/logger';
import { PoolRequest } from '@vigcoin/pool-request';

import * as EventEmitter from 'events';
import * as net from 'net';

import * as path from 'path';

const file = path.resolve(__dirname, './config.json');
const reader = new ConfigReader(file);
const { config } = reader.get();

const redis = new RedisClient({});
const logger = new Logger(config.logger);
const pr = new PoolRequest(config.daemon, config.wallet, config.api);


test('Should greet with message', () => {
  const runner = new Runner(reader, redis, logger, pr);
  expect(runner).toBeTruthy();
});

test('Should quit redis', () => {
  redis.quit();
});
