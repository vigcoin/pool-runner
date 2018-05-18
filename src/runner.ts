import * as cluster from "cluster";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import { RedisClient } from 'redis';
import { ConfigReader } from '@vigcoin/conf-reader';
import { Logger } from '@vigcoin/logger';
import { PoolRequest } from '@vigcoin/pool-request';

import { MiningServer } from '@vigcoin/pool-mining-server';
import { BlockUnlocker } from '@vigcoin/pool-block-unlocker';
import { Payments } from '@vigcoin/pool-payments';
import { Server as APIServer } from '@vigcoin/pool-api';
import { Charts } from '@vigcoin/pool-charts';

import { Application } from "express";
import * as express from "express";
import * as dateFormat from 'dateformat';

export class Runner {
  name = 'master';
  config: any;
  reader: ConfigReader;

  redis: RedisClient;
  logger: Logger;
  poolRequest: PoolRequest;
  miningServer: MiningServer;
  blockUnlocker: BlockUnlocker;
  payments: Payments;
  apiServer: APIServer;
  charts: Charts;
  moduleName: string;

  poolWorkers: any = {};
  spawnInterval: any;

  constructor(reader: ConfigReader, redis: RedisClient, logger: Logger,
    poolRequest: PoolRequest) {
    const { config } = reader.get();
    this.reader = reader;
    this.config = config;
    this.logger = logger;
    this.redis = redis;
    this.poolRequest = poolRequest;
    this.moduleName = "";
  }

  async checkRedisVersion() {
    const info = promisify(this.redis.info).bind(this.redis);
    const response = await info();
    let parts = response.split('\r\n');
    let version;
    let versionString;
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].indexOf(':') !== -1) {
        let valParts = parts[i].split(':');
        if (valParts[0] === 'redis_version') {
          versionString = valParts[1];
          version = parseFloat(versionString);
          break;
        }
      }
    }
    if (!version) {
      this.logger.append('error', this.name, 'Could not detect redis version - must be super old or broken', []);
      return false;
    }
    else if (version < 2.6) {
      this.logger.append('error', this.name, "You're using redis version %s the minimum required version is 2.6. Follow the damn usage instructions...", [versionString]);
      return false;
    }
    return true;
  }

  public async start(type: string) {
    const { config, logger, poolRequest: pr, redis, reader } = this;
    switch (type) {
      case 'pool':
        this.miningServer = new MiningServer(config, logger, pr, redis);
        await this.miningServer.listen();
        this.miningServer.start();
        break;
      case 'blockUnlocker':
        this.blockUnlocker = new BlockUnlocker(redis, reader, logger, pr);
        await this.blockUnlocker.run();
        break;
      case 'payment':
        this.payments = new Payments(redis, reader, logger, pr);
        break;
      case 'api':
        const app = express();
        const { donations, version } = reader.get();

        this.apiServer = new APIServer(app, config, redis, donations, version);
        await this.apiServer.start();
        break;
      case 'cli':
        break;
      case 'charts':
        this.charts = new Charts(config, pr, logger);
        this.charts.start(redis, config.coin);
        break;
    }
  }

  checkSingle() {
    var validModules = ['pool', 'api', 'unlocker', 'payments', 'charts'];
    for (var i = 0; i < process.argv.length; i++) {
      if (process.argv[i].indexOf('-module=') === 0) {
        var moduleName = process.argv[i].split('=')[1];
        if (validModules.indexOf(moduleName) > -1) {
          return this.moduleName = moduleName;
        }
        this.logger.append('error', this.name, 'Invalid module "%s", valid modules: %s', [moduleName, validModules.join(', ')]);
        process.exit();
      }
    }
  }

  getForkNum() {
    const { clusterForks } = this.config.poolServer;
    if (!clusterForks) {
      return 1;
    }
    if (clusterForks === 'auto') {
      return os.cpus().length;
    }
    if (isNaN(clusterForks)) {
      return 1;
    }
    return clusterForks;
  }

  createPoolWorker(forkId: string) {
    const worker: any = cluster.fork({
      workerType: 'pool',
      forkId: forkId
    });
    worker.forkId = forkId;
    worker.type = 'pool';
    this.poolWorkers[forkId] = worker;
    worker.on('exit', (code: string, signal: string) => {
      this.logger.append('error', this.name, 'Pool fork %s died, spawning replacement worker...', [forkId]);
      setTimeout(() => {
        this.createPoolWorker(forkId);
      }, 2000);
    }).on('message', (msg: any) => {
      switch (msg.type) {
        case 'banIP':
          Object.keys(cluster.workers).forEach((id) => {
            const w: any = cluster.workers[id];
            if (w && w.type === 'pool') {
              w.send({ type: 'banIP', ip: msg.ip });
            }
          });
          break;
      }
    });
  }

  spawnPoolWorkers() {
    const { enabled, ports, clusterForks } = this.config.poolServer;
    if (enabled && ports && ports.length) {
      const numForks = this.getForkNum();
      let i = 1;
      this.spawnInterval = setInterval(() => {
        this.createPoolWorker(String(i));
        i++;
        if (i - 1 === numForks) {
          clearInterval(this.spawnInterval);
          this.logger.append('info', this.name, 'Pool spawned on %d thread(s)', [numForks]);
        }
      }, 10);

    } else {
      this.logger.append('error', this.name, 'Pool server not enabled or no ports specified', []);
    }
  }

  spawnBlockUnlocker() {
    const { blockUnlocker } = this.config;
    if (blockUnlocker && blockUnlocker.enabled) {
      var worker = cluster.fork({
        workerType: 'blockUnlocker'
      });
      worker.on('exit', (code, signal) => {
        this.logger.append('error', this.name, 'Block unlocker died, spawning replacement...', []);
        setTimeout(() => {
          this.spawnBlockUnlocker();
        }, 2000);
      });
    }
  }
  spawnCharts() {
    const { charts } = this.config;
    var worker = cluster.fork({
      workerType: 'charts'
    });
    worker.on('exit', (code, signal) => {
      this.logger.append('error', this.name, 'chartsDataCollector died, spawning replacement...', []);
      setTimeout(() => {
        this.spawnCharts();
      }, 2000);
    });
  }

  spawnPayments() {
    const { payments } = this.config;

    if (payments && payments.enabled) {
      var worker = cluster.fork({
        workerType: 'payments'
      });
      worker.on('exit', (code, signal) => {
        this.logger.append('error', this.name, 'Payment processor died, spawning replacement...', []);
        setTimeout(() => {
          this.spawnPayments();
        }, 2000);
      });
    }
  }
  spawnApi() {
    const { api } = this.config;

    if (api && api.enabled) {
      var worker = cluster.fork({
        workerType: 'api'
      });
      worker.on('exit', (code, signal) => {
        this.logger.append('error', this.name, 'API died, spawning replacement...', []);
        setTimeout(() => {
          this.spawnApi();
        }, 2000);
      });
    }
  }

  spawn() {
    console.log("inside spawning");
    if (this.moduleName) {
      console.log("inside single spawning module %s", this.moduleName);
      this.logger.append('info', this.name, 'Running in single module mode: %s', [this.moduleName]);

      switch (this.moduleName) {
        case 'pool':
          this.spawnPoolWorkers();
          break;
        case 'unlocker':
          this.spawnBlockUnlocker();
          break;
        case 'payments':
          this.spawnPayments();
          break;
        case 'api':
          this.spawnApi();
          break;
        case 'charts':
          this.spawnCharts();
          break;
      }
    } else {
      console.log("inside spawning all modules");
      this.spawnPoolWorkers();
      this.spawnBlockUnlocker();
      this.spawnPayments();
      this.spawnCharts();
      this.spawnApi();
    }
  }

  except(module: string) {
    const { directory } = this.config.logging.files;
    process.on('uncaughtException', (err) => {
      console.log('\n' + err.stack + '\n');
      var time = dateFormat(new Date(), 'yyyy-mm-dd HH:MM:ss');
      fs.appendFile(+ '/' + module + '_crash.log', time + '\n' + err.stack + '\n\n', (err) => {
        if (cluster.isWorker)
          process.exit();
      });
    });
  }
}
