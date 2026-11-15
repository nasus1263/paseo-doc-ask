// The plugin typechecks without @types/node; declare only the Node APIs the server uses.
declare module "node:fs/promises" {
  export interface DirEntry {
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
  }
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  export function readFile(path: string): Promise<{ toString(encoding: "base64"): string }>;
  export function writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  export function readdir(path: string, options: { withFileTypes: true }): Promise<DirEntry[]>;
  export function stat(path: string): Promise<{ isFile(): boolean; size: number }>;
  export function mkdir(path: string, options: { recursive: true }): Promise<string | undefined>;
}

declare module "node:path" {
  export function isAbsolute(path: string): boolean;
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
  export function extname(path: string): string;
}

declare module "node:os" {
  export function homedir(): string;
}

declare const process: { env: Record<string, string | undefined> };
