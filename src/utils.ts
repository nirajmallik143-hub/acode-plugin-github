export interface Disposable {
  dispose(): void;
}

export const EmptyDisposable: Disposable = Object.freeze({ dispose() { } });

export function toDisposable(dispose: () => void): Disposable {
  return { dispose };
}

export function dispose(disposables: Disposable[]) {
  for (const disposable of disposables) {
    disposable.dispose();
  }

  return [];
}

export interface Event<T> {
  (listener: (e: T) => any, thisArgs?: any, disposables?: Disposable[]): Disposable;
}

export class Emitter<T> {
  private _listeners: Set<(e: T) => any> = new Set();
  private _disposed = false;
  private _event?: Event<T>;

  get event(): Event<T> {
    if (!this._event) {
      this._event = (
        listener: (e: any) => any,
        thisArgs?: any,
        disposables?: Disposable[]
      ) => {
        if (this._disposed) {
          return EmptyDisposable;
        }

        const bound = thisArgs ? listener.bind(thisArgs) : listener;
        this._listeners.add(bound);

        const result: Disposable = {
          dispose: () => {
            if (!this._disposed) {
              this._listeners.delete(bound);
            }
          }
        }

        if (Array.isArray(disposables)) {
          disposables.push(result);
        }

        return result;
      };
    }
    return this._event;
  }

  fire(event: T): void {
    if (this._disposed) return;

    const listeners = Array.from(this._listeners);
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (err) {
        console.warn(`Error in event listener:`, err);
      }
    }
  }

  dispose(): void {
    if (this._disposed) {
      return;
    }

    this._disposed = true;
    this._listeners.clear();
  }
}

export function fromDOMEvent<K extends keyof HTMLElementEventMap>(
  element: HTMLElement,
  eventName: K,
  options?: AddEventListenerOptions
): Event<HTMLElementEventMap[K]> {
  return (listener, thisArgs?, disposables?) => {
    const handler = (e: HTMLElementEventMap[K]) => listener.call(thisArgs, e);
    element.addEventListener(eventName, handler, options);

    const disposable: Disposable = {
      dispose: () => {
        element.removeEventListener(eventName, handler, options);
      }
    };

    if (Array.isArray(disposables)) {
      disposables.push(disposable);
    }

    return disposable;
  };
}