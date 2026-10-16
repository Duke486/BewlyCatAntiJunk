interface Task<T = unknown> {
  owner: string
  priority: number
  signal: AbortSignal
  run: () => Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
  abort: () => void
}

/** One pool for classification, reviews, summaries, tests and retries. */
export class RequestScheduler {
  private queue: Task<any>[] = []
  private active = 0
  private lastOwners = new Map<number, string>()

  constructor(private readonly concurrency = 3) {}

  submit<T>(owner: string, priority: number, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    if (signal.aborted)
      return Promise.reject(signal.reason)
    return new Promise<T>((resolve, reject) => {
      const task: Task<T> = { owner, priority, signal, run, resolve, reject, abort: () => {
        const index = this.queue.indexOf(task)
        if (index >= 0) {
          this.queue.splice(index, 1)
          reject(signal.reason)
        }
      } }
      signal.addEventListener('abort', task.abort, { once: true })
      this.queue.push(task)
      this.drain()
    })
  }

  private drain() {
    while (this.active < this.concurrency && this.queue.length) {
      const priority = Math.min(...this.queue.map(task => task.priority))
      const owners = [...new Set(this.queue.filter(task => task.priority === priority).map(task => task.owner))]
      const previous = owners.indexOf(this.lastOwners.get(priority) ?? '')
      const owner = owners[(previous + 1) % owners.length]
      const index = this.queue.findIndex(task => task.priority === priority && task.owner === owner)
      const [task] = this.queue.splice(index, 1)
      task.signal.removeEventListener('abort', task.abort)
      this.lastOwners.set(priority, task.owner)
      this.active++
      void Promise.resolve().then(() => {
        task.signal.throwIfAborted()
        return task.run()
      }).then(task.resolve, task.reject).finally(() => {
        this.active--
        this.drain()
      })
    }
  }
}
