// @ts-nocheck
import { BloblangError } from './error';

export class GenericError extends BloblangError {
  override readonly name = 'GenericError';
}

type Lazy<T> = T | PromiseLike<T>;
type Reducer<T> = T | (() => T);

export async function tryCatch<T, U extends BloblangError>(
  reducer: Lazy<Reducer<T>>,
): [T, never] | [never, U] {
  try {
    return [await (typeof reducer === 'function' ? reducer() : reducer)];
  } catch (err) {
    if (err instanceof BloblangError) {
      return [undefined, err];
    }

    return [undefined, new GenericError('Unknown error', err)];
  }
}
