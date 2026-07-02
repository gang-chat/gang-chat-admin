export type RunTask = <T>(task: () => Promise<T>, success?: string) => Promise<T | undefined>;
