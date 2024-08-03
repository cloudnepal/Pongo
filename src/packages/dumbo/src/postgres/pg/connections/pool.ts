import pg from 'pg';
import {
  sqlExecutorInNewConnection,
  transactionFactoryWithNewConnection,
  type ConnectionPool,
} from '../../../core';
import {
  defaultPostgreSqlDatabase,
  getDatabaseNameOrDefault,
} from '../../core';
import {
  nodePostgresConnection,
  NodePostgresConnectorType,
  type NodePostgresClientConnection,
  type NodePostgresPoolClientConnection,
} from './connection';

export type NodePostgresNativePool =
  ConnectionPool<NodePostgresPoolClientConnection>;

export type NodePostgresExplicitClientPool =
  ConnectionPool<NodePostgresClientConnection>;

export const nodePostgresNativePool = (options: {
  connectionString: string;
  database?: string;
  pool?: pg.Pool;
}): NodePostgresNativePool => {
  const { connectionString, database, pool: ambientPool } = options;
  const pool = ambientPool
    ? ambientPool
    : getPool({ connectionString, database });

  const getConnection = () =>
    nodePostgresConnection({
      type: 'PoolClient',
      connect: pool.connect(),
      close: (client) => Promise.resolve(client.release()),
    });

  const open = () => Promise.resolve(getConnection());
  const close = async () => {
    if (!ambientPool) await endPool({ connectionString, database });
  };

  return {
    type: NodePostgresConnectorType,
    open,
    close,
    execute: sqlExecutorInNewConnection({ open }),
    ...transactionFactoryWithNewConnection(getConnection),
  };
};

export const nodePostgresExplicitClientPool = (options: {
  connectionString: string;
  database?: string;
  client?: pg.Client;
}): NodePostgresExplicitClientPool => {
  const { connectionString, database, client: existingClient } = options;

  const getConnection = () => {
    const connect = existingClient
      ? Promise.resolve(existingClient)
      : Promise.resolve(new pg.Client({ connectionString, database })).then(
          async (client) => {
            await client.connect();
            return client;
          },
        );

    return nodePostgresConnection({
      type: 'Client',
      connect,
      close: (client) => (existingClient ? Promise.resolve() : client.end()),
    });
  };

  const open = () => Promise.resolve(getConnection());
  const close = async () => {
    if (!existingClient) await endPool({ connectionString, database });
  };

  return {
    type: NodePostgresConnectorType,
    open,
    close,
    execute: sqlExecutorInNewConnection({ open }),
    ...transactionFactoryWithNewConnection(getConnection),
  };
};

export type NodePostgresPoolPooledOptions =
  | {
      connectionString: string;
      database?: string;
      pooled: true;
      pool: pg.Pool;
    }
  | {
      connectionString: string;
      database?: string;
      pool: pg.Pool;
    }
  | {
      connectionString: string;
      database?: string;
      pooled: true;
    }
  | {
      connectionString: string;
      database?: string;
    };

export type NodePostgresPoolNotPooledOptions =
  | {
      connectionString: string;
      database?: string;
      pooled: false;
      client: pg.Client;
    }
  | {
      connectionString: string;
      database?: string;
      client: pg.Client;
    }
  | {
      connectionString: string;
      database?: string;
      pooled: false;
    };

export type NodePostgresPoolOptions =
  | NodePostgresPoolPooledOptions
  | NodePostgresPoolNotPooledOptions;

export function nodePostgresPool(
  options: NodePostgresPoolPooledOptions,
): NodePostgresNativePool;
export function nodePostgresPool(
  options: NodePostgresPoolNotPooledOptions,
): NodePostgresExplicitClientPool;
export function nodePostgresPool(
  options: NodePostgresPoolOptions,
): NodePostgresNativePool | NodePostgresExplicitClientPool {
  const { connectionString, database } = options;

  if (('pooled' in options && options.pooled === false) || 'client' in options)
    return nodePostgresExplicitClientPool({
      connectionString,
      ...(database ? { database } : {}),
      ...('client' in options && options.client
        ? { client: options.client }
        : {}),
    });

  return nodePostgresNativePool({
    connectionString,
    ...(database ? { database } : {}),
    ...('pool' in options && options.pool ? { pool: options.pool } : {}),
  });
}

const pools: Map<string, pg.Pool> = new Map();
const usageCounter: Map<string, number> = new Map();

export const getPool = (
  connectionStringOrOptions: string | pg.PoolConfig,
): pg.Pool => {
  const connectionString =
    typeof connectionStringOrOptions === 'string'
      ? connectionStringOrOptions
      : connectionStringOrOptions.connectionString!;

  const poolOptions =
    typeof connectionStringOrOptions === 'string'
      ? { connectionString }
      : connectionStringOrOptions;

  const database =
    poolOptions.database ??
    (poolOptions.connectionString
      ? getDatabaseNameOrDefault(poolOptions.connectionString)
      : undefined);

  const lookupKey = key(connectionString, database);

  updatePoolUsageCounter(lookupKey, 1);

  return (
    pools.get(lookupKey) ??
    pools.set(lookupKey, new pg.Pool(poolOptions)).get(lookupKey)!
  );
};

export const endPool = async ({
  connectionString,
  database,
  force,
}: {
  connectionString: string;
  database?: string | undefined;
  force?: boolean;
}): Promise<void> => {
  database = database ?? getDatabaseNameOrDefault(connectionString);
  const lookupKey = key(connectionString, database);

  const pool = pools.get(lookupKey);
  if (pool && (updatePoolUsageCounter(lookupKey, -1) <= 0 || force === true)) {
    await onEndPool(lookupKey, pool);
  }
};

export const onEndPool = async (lookupKey: string, pool: pg.Pool) => {
  try {
    await pool.end();
  } catch (error) {
    console.log(`Error while closing the connection pool: ${lookupKey}`);
    console.log(error);
  }
  pools.delete(lookupKey);
};

export const endAllPools = () =>
  Promise.all(
    [...pools.entries()].map(([lookupKey, pool]) => onEndPool(lookupKey, pool)),
  );

const key = (connectionString: string, database: string | undefined) =>
  `${connectionString}|${database ?? defaultPostgreSqlDatabase}`;

const updatePoolUsageCounter = (lookupKey: string, by: 1 | -1): number => {
  const currentCounter = usageCounter.get(lookupKey) ?? 0;
  const newCounter = currentCounter + by;

  usageCounter.set(lookupKey, currentCounter + by);

  return newCounter;
};
