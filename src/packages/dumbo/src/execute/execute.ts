import type { Connection } from '../connections';
import type { SQL } from '../sql';

export const execute = async <
  Result = void,
  ConnectionType extends Connection = Connection,
>(
  connection: ConnectionType,
  handle: (client: ReturnType<ConnectionType['open']>) => Promise<Result>,
) => {
  const client = connection.open();

  try {
    return await handle(client as ReturnType<ConnectionType['open']>);
  } finally {
    await connection.close();
  }
};

export const executeInTransaction = async <
  Result = void,
  ConnectionType extends Connection = Connection,
>(
  connection: ConnectionType,
  handle: (
    client: ReturnType<ConnectionType['open']>,
  ) => Promise<{ success: boolean; result: Result }>,
): Promise<Result> =>
  execute(connection, async (client) => {
    const transaction = await connection.beginTransaction();

    try {
      const { success, result } = await handle(client);

      if (success) await transaction.commit();
      else await transaction.rollback();

      return result;
    } catch (e) {
      await transaction.rollback();
      throw e;
    }
  });

export interface QueryResultRow {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [column: string]: any;
}

export type QueryResult<Result extends QueryResultRow = QueryResultRow> = {
  rowCount: number | null;
  rows: Result[];
};

export type SQLExecutor<ConnectionType extends Connection = Connection> = {
  type: ConnectionType['type'];
  query<Result extends QueryResultRow = QueryResultRow>(
    client: ReturnType<ConnectionType['open']>,
    sql: SQL,
  ): Promise<QueryResult<Result>>;
};

const getExecutor = <ConnectionType extends Connection = Connection>(
  _connectorType: ConnectionType['type'],
): SQLExecutor => ({
  type: '',
  query: <Result extends QueryResultRow = QueryResultRow>(
    _client: ReturnType<ConnectionType['open']>,
    _queryTextOrConfig: SQL,
  ): Promise<QueryResult<Result>> => Promise.reject('Not Implemented!'),
});

export const executeSQL = async <
  Result extends QueryResultRow = QueryResultRow,
  ConnectionType extends Connection = Connection,
>(
  connection: ConnectionType,
  sql: SQL,
): Promise<QueryResult<Result>> =>
  execute(connection, (client) =>
    getExecutor(connection.type).query(client, sql),
  );

export const executeSQLInTransaction = async <
  Result extends QueryResultRow = QueryResultRow,
  ConnectionType extends Connection = Connection,
>(
  connection: ConnectionType,
  sql: SQL,
) => {
  console.log(sql);
  return executeInTransaction(connection, async (client) => ({
    success: true,
    result: await getExecutor(connection.type).query<Result>(client, sql),
  }));
};

export const executeSQLBatchInTransaction = async <
  Result extends QueryResultRow = QueryResultRow,
  ConnectionType extends Connection = Connection,
>(
  connection: ConnectionType,
  ...sqls: SQL[]
) =>
  executeInTransaction(connection, async (client) => {
    for (const sql of sqls) {
      await getExecutor(connection.type).query<Result>(client, sql);
    }

    return { success: true, result: undefined };
  });

export const firstOrNull = async <
  Result extends QueryResultRow = QueryResultRow,
>(
  getResult: Promise<QueryResult<Result>>,
): Promise<Result | null> => {
  const result = await getResult;

  return result.rows.length > 0 ? result.rows[0] ?? null : null;
};

export const first = async <Result extends QueryResultRow = QueryResultRow>(
  getResult: Promise<QueryResult<Result>>,
): Promise<Result> => {
  const result = await getResult;

  if (result.rows.length === 0)
    throw new Error("Query didn't return any result");

  return result.rows[0]!;
};

export const singleOrNull = async <
  Result extends QueryResultRow = QueryResultRow,
>(
  getResult: Promise<QueryResult<Result>>,
): Promise<Result | null> => {
  const result = await getResult;

  if (result.rows.length > 1) throw new Error('Query had more than one result');

  return result.rows.length > 0 ? result.rows[0] ?? null : null;
};

export const single = async <Result extends QueryResultRow = QueryResultRow>(
  getResult: Promise<QueryResult<Result>>,
): Promise<Result> => {
  const result = await getResult;

  if (result.rows.length === 0)
    throw new Error("Query didn't return any result");

  if (result.rows.length > 1) throw new Error('Query had more than one result');

  return result.rows[0]!;
};

export const mapRows = async <
  Result extends QueryResultRow = QueryResultRow,
  Mapped = unknown,
>(
  getResult: Promise<QueryResult<Result>>,
  map: (row: Result) => Mapped,
): Promise<Mapped[]> => {
  const result = await getResult;

  return result.rows.map(map);
};

export const toCamelCase = (snakeStr: string): string =>
  snakeStr.replace(/_([a-z])/g, (g) => g[1]?.toUpperCase() ?? '');

export const mapToCamelCase = <T extends Record<string, unknown>>(
  obj: T,
): T => {
  const newObj: Record<string, unknown> = {};
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      newObj[toCamelCase(key)] = obj[key];
    }
  }
  return newObj as T;
};

export type ExistsSQLQueryResult = { exists: boolean };

export const exists = async <ConnectionType extends Connection = Connection>(
  connection: ConnectionType,
  sql: SQL,
): Promise<boolean> => {
  const result = await single(
    executeSQL<ExistsSQLQueryResult>(connection, sql),
  );

  return result.exists === true;
};