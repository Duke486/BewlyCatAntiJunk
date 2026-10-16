export type Metric = 'requests' | 'firstPass' | 'secondPass' | 'cacheHits' | 'errors' | 'queueMs' | 'requestMs'
let sink: (key: Metric, amount: number) => void = () => {}

export function setMetricsSink(next: typeof sink) {
  sink = next
}

export function recordMetric(key: Metric, amount = 1) {
  sink(key, amount)
}

export function emptyMetrics(): Record<Metric, number> {
  return { requests: 0, firstPass: 0, secondPass: 0, cacheHits: 0, errors: 0, queueMs: 0, requestMs: 0 }
}
