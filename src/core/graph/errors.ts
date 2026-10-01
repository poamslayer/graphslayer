export class GraphError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
    public readonly retryAfterSeconds?: number,
    /**
     * What the shipped Graph index can add to what Graph said. A path Graph could not find
     * carries the closest paths the index holds, so a near miss such as a singular resource name
     * is one step from correct rather than a guessing loop. Absent when the index has nothing to
     * add, and absent on every failure that is not about the path.
     */
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "GraphError";
  }

  toJSON() {
    return {
      status: this.status,
      code: this.code,
      message: this.message,
      requestId: this.requestId,
      retryAfterSeconds: this.retryAfterSeconds,
      hint: this.hint,
    };
  }
}
