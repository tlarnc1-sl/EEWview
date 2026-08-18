/** 最小の購読機構。解除関数を返す。 */
export class Emitter<T> {
  private listeners = new Set<(value: T) => void>();

  subscribe(fn: (value: T) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  emit(value: T): void {
    // 配信中に解除されても走査が壊れないようコピーしてから回す
    for (const fn of [...this.listeners]) {
      try {
        fn(value);
      } catch (err) {
        console.error('[emitter] listener failed', err);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }

  get size(): number {
    return this.listeners.size;
  }
}
