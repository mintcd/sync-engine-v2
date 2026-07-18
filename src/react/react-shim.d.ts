declare module "react" {
  export type DependencyList = readonly unknown[];

  export function useEffect(
    effect: () => void | (() => void),
    deps?: DependencyList,
  ): void;

  export function useMemo<T>(factory: () => T, deps: DependencyList): T;

  export function useRef<T>(initialValue: T): { current: T };

  export function useState<T>(
    initialValue: T | (() => T),
  ): [T, (value: T | ((previous: T) => T)) => void];

  export function useSyncExternalStore<T>(
    subscribe: (listener: () => void) => () => void,
    getSnapshot: () => T,
    getServerSnapshot?: () => T,
  ): T;
}
