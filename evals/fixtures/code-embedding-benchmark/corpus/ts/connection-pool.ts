type Connection = {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
};

export class ConnectionPool {
  private readonly idle: Connection[] = [];

  constructor(
    private readonly createConnection: () => Promise<Connection>,
    private readonly maxSize = 10
  ) {}

  async withConnection<T>(
    handler: (connection: Connection) => Promise<T>
  ): Promise<T> {
    const connection = this.idle.pop() ?? (await this.createConnection());

    try {
      return await handler(connection);
    } finally {
      if (this.idle.length < this.maxSize) {
        this.idle.push(connection);
      } else {
        await connection.close();
      }
    }
  }
}
