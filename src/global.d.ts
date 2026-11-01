declare const __DEV__: boolean
declare const __BUILD_COMMIT__: string

declare module '*.vue' {
  const component: any
  export default component
}

declare module 'virtual:bewly-inject-messages' {
  /** Native page messages, keyed by locale then fully qualified message key. */
  const messages: Record<string, Record<string, string>>
  export default messages
}
