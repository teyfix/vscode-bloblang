export abstract class BloblangError extends Error {
  abstract override readonly name: string;
  readonly reason: unknown;

  constructor(message: string, reason: unknown) {
    super(message);

    if (reason instanceof BloblangError) {
      this.reason = reason.reason;
    } else {
      this.reason = reason;
    }
  }
}
