declare const process: {
  readonly argv: string[];
  readonly cwd: () => string;
  exitCode: number;
  readonly pid: number;
  readonly stderr: { write(value: string): void };
  readonly stdout: { write(value: string): void };
};

declare const Buffer: {
  from(value: string): { toString(encoding: string): string };
};

declare module "node:crypto" {
  export function randomUUID(): string;
}

declare module "node:fs" {
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding: string): string;
}

declare module "fs" {
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding: string): string;
}

declare module "node:fs/promises" {
  export function mkdir(
    path: string,
    options?: { readonly recursive?: boolean },
  ): Promise<void>;
  export function readFile(path: string, encoding: string): Promise<string>;
  export function rename(from: string, to: string): Promise<void>;
  export function rm(
    path: string,
    options?: { readonly force?: boolean; readonly recursive?: boolean },
  ): Promise<void>;
  export function writeFile(
    path: string,
    source: string,
    options?: { readonly encoding?: string; readonly flag?: string },
  ): Promise<void>;
}

declare module "node:module" {
  export function createRequire(path: string): {
    resolve(specifier: string): string;
  };
}

declare module "node:path" {
  export function basename(value: string): string;
  export function dirname(value: string): string;
  export function extname(value: string): string;
  export function isAbsolute(value: string): boolean;
  export function join(...values: string[]): string;
  export function parse(value: string): { readonly root: string };
  export function relative(from: string, to: string): string;
  export function resolve(...values: string[]): string;
  export const sep: string;

  const path: {
    basename(value: string): string;
    dirname(value: string): string;
    extname(value: string): string;
    isAbsolute(value: string): boolean;
    join(...values: string[]): string;
    parse(value: string): { readonly root: string };
    relative(from: string, to: string): string;
    resolve(...values: string[]): string;
    readonly sep: string;
  };
  export default path;
}

declare module "path" {
  export function basename(value: string): string;
  export function dirname(value: string): string;
  export function extname(value: string): string;
  export function isAbsolute(value: string): boolean;
  export function join(...values: string[]): string;
  export function parse(value: string): { readonly root: string };
  export function relative(from: string, to: string): string;
  export function resolve(...values: string[]): string;
  export const sep: string;

  const path: {
    basename(value: string): string;
    dirname(value: string): string;
    extname(value: string): string;
    isAbsolute(value: string): boolean;
    join(...values: string[]): string;
    parse(value: string): { readonly root: string };
    relative(from: string, to: string): string;
    resolve(...values: string[]): string;
    readonly sep: string;
  };
  export default path;
}

declare module "node:url" {
  export function fileURLToPath(url: string): string;
  export function pathToFileURL(path: string): { readonly href: string };
}

declare module "url" {
  export function fileURLToPath(url: string): string;
  export function pathToFileURL(path: string): { readonly href: string };
}
