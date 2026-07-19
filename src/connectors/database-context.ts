/** Minimal pooled connection contract needed for temporary database switching. */
export interface DatabaseContextConnection {
  changeUser(options: { database: string }): Promise<void>;
  destroy(): void;
  release(): void;
}

/** Error raised when a pooled connection cannot safely return to its default database. */
export class DatabaseContextRestoreError extends Error {
  public constructor(
    defaultDatabase: string,
    public readonly executionError: unknown,
    restoreError: unknown
  ) {
    super(`Failed to restore database context to '${defaultDatabase}'`, {
      cause: restoreError,
    });
    this.name = "DatabaseContextRestoreError";
  }
}

/**
 * Executes one operation in a fixed database and restores the pooled connection.
 *
 * A failed switch or restore destroys the connection so database context can
 * never leak into the next request borrowing it from the pool.
 */
export async function executeInDatabaseContext<T>(
  connection: DatabaseContextConnection,
  defaultDatabase: string | null,
  targetDatabase: string | undefined,
  operation: () => Promise<T>
): Promise<T> {
  if (!targetDatabase || targetDatabase === defaultDatabase) {
    try {
      return await operation();
    } finally {
      connection.release();
    }
  }
  if (!defaultDatabase) {
    connection.destroy();
    throw new Error("A default database is required before switching database context");
  }

  try {
    await connection.changeUser({ database: targetDatabase });
  } catch (error) {
    connection.destroy();
    throw new Error(`Failed to switch database context to '${targetDatabase}'`, {
      cause: error,
    });
  }

  let executionResult: T | undefined;
  let executionError: unknown;
  let didExecute = false;
  try {
    executionResult = await operation();
    didExecute = true;
  } catch (error) {
    executionError = error;
  }

  try {
    await connection.changeUser({ database: defaultDatabase });
  } catch (restoreError) {
    connection.destroy();
    throw new DatabaseContextRestoreError(defaultDatabase, executionError, restoreError);
  }
  connection.release();

  if (!didExecute) {
    throw executionError;
  }
  return executionResult as T;
}
