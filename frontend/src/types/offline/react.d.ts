/**
 * Minimal React typings used only when @types/react is not installed (offline builds).
 * `npm ci` installs the real @types/react and tsconfig.json ignores this folder.
 */
declare namespace React {
  type Key = string | number | bigint;
  interface ReactElement<P = any> { type: any; props: P; key: Key | null }
  type ReactNode = ReactElement | string | number | bigint | boolean | null | undefined | Iterable<ReactNode>;
  type SetStateAction<S> = S | ((prev: S) => S);
  type Dispatch<A> = (value: A) => void;
  interface MutableRefObject<T> { current: T }
  interface RefObject<T> { readonly current: T | null }
  type Ref<T> = ((instance: T | null) => void) | RefObject<T> | MutableRefObject<T | null> | null;
  interface Context<T> { Provider: (props: { value: T; children?: ReactNode }) => ReactNode }
  type FC<P = {}> = (props: P) => ReactNode;
  type ComponentType<P = {}> = (props: P) => ReactNode;
  type PropsWithChildren<P = unknown> = P & { children?: ReactNode };
  type CSSProperties = { [key: string]: string | number | undefined };
  interface SyntheticEvent<T = Element, E = Event> {
    currentTarget: T; target: EventTarget & T; nativeEvent: E; defaultPrevented: boolean;
    preventDefault(): void; stopPropagation(): void;
  }
  interface ChangeEvent<T = Element> extends SyntheticEvent<T> { target: EventTarget & T }
  interface FormEvent<T = Element> extends SyntheticEvent<T> {}
  interface FocusEvent<T = Element> extends SyntheticEvent<T> { relatedTarget: EventTarget | null }
  interface MouseEvent<T = Element> extends SyntheticEvent<T> {
    button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; clientX: number; clientY: number;
  }
  interface KeyboardEvent<T = Element> extends SyntheticEvent<T> { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }
  interface DragEvent<T = Element> extends MouseEvent<T> { dataTransfer: DataTransfer }
  interface ClipboardEvent<T = Element> extends SyntheticEvent<T> { clipboardData: DataTransfer }
  interface DOMAttributes<T> { children?: ReactNode; [key: string]: any }
  interface HTMLAttributes<T> extends DOMAttributes<T> { className?: string; id?: string; style?: CSSProperties; title?: string }
  interface SVGAttributes<T> extends DOMAttributes<T> { className?: string; style?: CSSProperties; color?: string }
  type ComponentProps<T> = T extends (props: infer P) => any ? P : any;
}

declare module "react" {
  export function useState<S>(initial: S | (() => S)): [S, React.Dispatch<React.SetStateAction<S>>];
  export function useState<S = undefined>(): [S | undefined, React.Dispatch<React.SetStateAction<S | undefined>>];
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  export function useLayoutEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  export function useMemo<T>(factory: () => T, deps: readonly unknown[]): T;
  export function useCallback<T extends (...args: any[]) => any>(callback: T, deps: readonly unknown[]): T;
  export function useRef<T>(initial: T): React.MutableRefObject<T>;
  export function useRef<T>(initial: T | null): React.RefObject<T>;
  export function useRef<T = undefined>(): React.MutableRefObject<T | undefined>;
  export function useContext<T>(context: React.Context<T>): T;
  export function createContext<T>(defaultValue: T): React.Context<T>;
  export function useId(): string;
  export function useReducer<S, A>(reducer: (state: S, action: A) => S, initial: S): [S, React.Dispatch<A>];
  export function useSyncExternalStore<T>(subscribe: (cb: () => void) => () => void, get: () => T, server?: () => T): T;
  export function useTransition(): [boolean, (cb: () => void) => void];
  export function useDeferredValue<T>(value: T): T;
  export function startTransition(cb: () => void): void;
  export function lazy<T extends React.ComponentType<any>>(factory: () => Promise<{ default: T }>): T;
  export function memo<T>(component: T): T;
  export const Fragment: (props: { children?: React.ReactNode; key?: React.Key }) => React.ReactNode;
  export const StrictMode: (props: { children?: React.ReactNode }) => React.ReactNode;
  export const Suspense: (props: { children?: React.ReactNode; fallback?: React.ReactNode }) => React.ReactNode;
  export type ReactNode = React.ReactNode;
  export type ReactElement = React.ReactElement;
  export type FormEvent<T = Element> = React.FormEvent<T>;
  export type ChangeEvent<T = Element> = React.ChangeEvent<T>;
  export type MouseEvent<T = Element> = React.MouseEvent<T>;
  export type KeyboardEvent<T = Element> = React.KeyboardEvent<T>;
  export type DragEvent<T = Element> = React.DragEvent<T>;
  export type CSSProperties = React.CSSProperties;
  export type Dispatch<A> = React.Dispatch<A>;
  export type SetStateAction<S> = React.SetStateAction<S>;
  export type SVGAttributes<T> = React.SVGAttributes<T>;
  export type HTMLAttributes<T> = React.HTMLAttributes<T>;
  export type Context<T> = React.Context<T>;
  export type RefObject<T> = React.RefObject<T>;
  export type ComponentType<P = {}> = React.ComponentType<P>;
  export namespace JSX { type Element = React.ReactElement }
}

declare module "react/jsx-runtime" {
  export const jsx: any;
  export const jsxs: any;
  export const Fragment: any;
  export namespace JSX {
    type Element = React.ReactElement;
    interface ElementClass { render(): React.ReactNode }
    interface ElementAttributesProperty { props: {} }
    interface ElementChildrenAttribute { children: {} }
    interface IntrinsicAttributes { key?: React.Key | null }
    type ElementType = string | ((props: any) => React.ReactNode);
    interface IntrinsicProps {
      [prop: string]: any;
      onClick?: (event: React.MouseEvent<any>) => void;
      onMouseDown?: (event: React.MouseEvent<any>) => void;
      onMouseEnter?: (event: React.MouseEvent<any>) => void;
      onMouseLeave?: (event: React.MouseEvent<any>) => void;
      onChange?: (event: React.ChangeEvent<any>) => void;
      onInput?: (event: React.FormEvent<any>) => void;
      onSubmit?: (event: React.FormEvent<any>) => void;
      onKeyDown?: (event: React.KeyboardEvent<any>) => void;
      onFocus?: (event: React.FocusEvent<any>) => void;
      onBlur?: (event: React.FocusEvent<any>) => void;
      onDragOver?: (event: React.DragEvent<any>) => void;
      onDragLeave?: (event: React.DragEvent<any>) => void;
      onDrop?: (event: React.DragEvent<any>) => void;
      onClose?: (event: React.SyntheticEvent<any>) => void;
      onCancel?: (event: React.SyntheticEvent<any>) => void;
    }
    interface IntrinsicElements { [elemName: string]: IntrinsicProps }
  }
}

declare module "react-dom/client" {
  export function createRoot(container: Element): { render(children: React.ReactNode): void; unmount(): void };
}
