/**
 * tree.proxy.ts — Main-thread proxy for the tree worker.
 *
 * Wraps postMessage calls in Promises. Retries up to 3 times on worker error.
 */

export class TreeProxy {
  private worker!: Worker;
  private resolvers = new Map<string, (v: any) => void>();
  private nextId = 0;
  private retryCount = 0;
  private maxRetries = 3;
  private workerError = false;

  constructor() {
    this.initWorker();
  }

  private initWorker() {
    this.worker = new Worker(
      new URL("./tree.worker.ts", import.meta.url),
      { type: "module" }
    );
    this.worker.onmessage = (e: MessageEvent) => {
      const { id, type, ...data } = e.data;
      const resolve = this.resolvers.get(id);
      if (resolve) {
        resolve({ type, ...data });
        this.resolvers.delete(id);
      }
    };
    this.worker.onerror = (err: ErrorEvent) => {
      console.error("Tree worker error:", err);
      this.workerError = true;
      this.retryCount++;
      if (this.retryCount <= this.maxRetries) {
        console.warn(`Retrying worker (${this.retryCount}/${this.maxRetries})`);
        try {
          this.worker.terminate();
          this.initWorker();
        } catch (e2) {
          console.error("Failed to restart worker:", e2);
          this.rejectAll("Worker restart failed");
        }
      } else {
        console.error("Worker failed after all retries");
        this.rejectAll(`Worker crashed after ${this.maxRetries} retries`);
      }
    };
  }

  private rejectAll(msg: string) {
    for (const [id, resolve] of this.resolvers) {
      resolve({ type: "error", error: msg });
      this.resolvers.delete(id);
    }
    this.workerError = true;
  }

  postMessage(msg: any) {
    if (this.workerError) {
      console.warn("Tree worker unavailable, falling back to main thread");
      return;
    }
    this.worker.postMessage(msg);
  }

  send(type: string, payload: any, timeoutMs = 30000): Promise<any> {
    if (this.workerError) {
      return Promise.resolve({ type: "error", error: "Worker unavailable" });
    }
    return new Promise((resolve) => {
      const id = String(this.nextId++);
      this.resolvers.set(id, resolve);
      this.worker.postMessage({ ...payload, type, id });
      setTimeout(() => {
        if (this.resolvers.has(id)) {
          console.warn(`Worker ${type} timed out after ${timeoutMs}ms`);
          this.resolvers.delete(id);
          resolve({ type: "error", error: `${type} timed out` });
        }
      }, timeoutMs);
    });
  }

  buildTree(item: string, opts: any) {
    return this.send("buildTree", { item, ...opts });
  }

  wouldCycle(inputId: string, targetId: string) {
    return this.send("wouldCycle", { inputId, targetId });
  }

  collectIds(treeNode: any) {
    return this.send("collectIds", { treeNode });
  }
}
